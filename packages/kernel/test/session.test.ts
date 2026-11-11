// The Session's mutation line, transactions and failure, through the package's public API over real SQLite storage.
// The upstream session tests need documents, so they wait for kernel-documents; these prove what they cannot yet.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue, Scheduler, type Scope } from "effect"
import {
  type CommitObserverEnd,
  type CommitPublication,
  type ConversationId,
  defineDoc,
  defineEntry,
  type EntryId,
  type EntryRecord,
  openSession,
  openSqliteStorage,
  ReadAfterWrite,
  ReadOnlySession,
  type Session,
  SessionFailed,
  type Storage,
  StorageError,
  type SubmissionRecord,
  type TaskId,
  type TaskRecord,
  type Tx,
} from "../src/index.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const databasePath = (): string => {
  const home = mkdtempSync(join(tmpdir(), "nisse-session-"))
  homes.push(home)
  return join(home, "kernel.sqlite")
}

/**
 * Storage in front of real SQLite that can hold commits: while `holding`, each commit call announces itself on
 * `arrived` and goes to SQLite only once the test puts a release on `releases`. `failCommits` makes commit calls fail as
 * a broken disk would. `stored` lists the seqs SQLite has stored, in order.
 */
type TestStorage = {
  readonly storage: Storage
  holding: boolean
  /** Like `holding`, for single-submission reads. */
  holdingReads: boolean
  /** Entry scans die, as a stored record that does not parse makes them. */
  breakScans: boolean
  failCommits: boolean
  closed: boolean
  readonly stored: number[]
  readonly arrived: Queue.Queue<void>
  readonly releases: Queue.Queue<void>
}

const testStorage = (path: string): Effect.Effect<TestStorage, StorageError> =>
  Effect.gen(function* () {
    const inner = yield* openSqliteStorage(path)
    const control: TestStorage = {
      storage: undefined as unknown as Storage,
      holding: false,
      holdingReads: false,
      breakScans: false,
      failCommits: false,
      closed: false,
      stored: [],
      arrived: yield* Queue.unbounded<void>(),
      releases: yield* Queue.unbounded<void>(),
    }
    const commit: Storage["commit"] = (batches, receive) =>
      Effect.gen(function* () {
        if (control.holding) {
          yield* Queue.offer(control.arrived, undefined)
          yield* Queue.take(control.releases)
        }
        if (control.failCommits) return yield* Effect.fail(StorageError.because("disk I/O error"))
        return yield* inner.commit(batches, (index, seq) => {
          control.stored.push(seq)
          receive(index, seq)
        })
      })
    const submission: Storage["submission"] = (id) =>
      Effect.gen(function* () {
        if (control.holdingReads) {
          yield* Queue.offer(control.arrived, undefined)
          yield* Queue.take(control.releases)
        }
        return yield* inner.submission(id)
      })
    const scanEntries: Storage["scanEntries"] = (query, limit, cursor) =>
      control.breakScans ? Effect.sync(() => JSON.parse("{corrupt") as never) : inner.scanEntries(query, limit, cursor)
    const close: Storage["close"] = () => Effect.tap(inner.close(), () => Effect.sync(() => (control.closed = true)))
    ;(control as { storage: Storage }).storage = new Proxy(inner, {
      get(target, key) {
        if (key === "commit") return commit
        if (key === "close") return close
        if (key === "submission") return submission
        if (key === "scanEntries") return scanEntries
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as Storage
    return control
  })

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> => Effect.runPromise(Effect.scoped(effect))

/** The typed failure of an exit; throws when it succeeded or died. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`expected a typed failure, got ${reason?._tag}`)
  return reason.error
}

const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a defect, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Die") throw new Error(`expected a defect, got ${reason?._tag}`)
  return reason.defect
}

const newConversation = (session: Session): Effect.Effect<ConversationId, unknown> =>
  session.commit((tx) => Effect.map(tx.createConversation({ ownership: { kind: "ownerless" } }), (record) => record.id))

const note = (session: Session, conversationId: ConversationId, text: string) =>
  session.commit((tx) => tx.appendEntry(conversationId, { kind: "note", data: { text } }))

const recordCommits = (session: Session) => {
  const published: CommitPublication[] = []
  const ends: CommitObserverEnd[] = []
  session.observeCommits({ advance: (publication) => published.push(publication), end: (end) => ends.push(end) })
  return { published, ends }
}

describe("Session", () => {
  test("commit-atomic, commit-published-after-store: commits from many fibers form one ordered line, each published only after it is stored", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const published: { seq: number; storedBefore: boolean; text: unknown }[] = []
        session.observeCommits({
          advance: (publication) => {
            const entry = publication.changes.find((change) => change.type === "entry")?.value as EntryRecord
            published.push({
              seq: publication.seq,
              storedBefore: control.stored.includes(publication.seq),
              text: (entry.data as { text: string }).text,
            })
          },
          end: () => {},
        })

        // Each callback yields mid-way, inviting another to run inside it; the line must still run one at a time.
        let running = 0
        let overlapped = false
        const fibers = 20
        control.holding = true
        const commits = yield* Effect.forEach(
          Array.from({ length: fibers }, (_, index) => index),
          (index) =>
            Effect.forkChild(
              session.commit((tx) =>
                Effect.gen(function* () {
                  running++
                  if (running > 1) overlapped = true
                  yield* Effect.yieldNow
                  const entry = yield* tx.appendEntry(conversationId, {
                    kind: "note",
                    data: { text: `fiber ${index}` },
                  })
                  running--
                  return entry.id
                }),
              ),
            ),
        )

        // Each commit reaches storage alone; until storage stores it, nothing of it is published.
        for (let index = 0; index < fibers; index++) {
          yield* Queue.take(control.arrived)
          expect(published).toHaveLength(index)
          yield* Queue.offer(control.releases, undefined)
        }
        const ids = yield* Effect.forEach(commits, Fiber.join)

        expect(overlapped).toBe(false)
        expect(published).toHaveLength(fibers)
        expect(published.every((p) => p.storedBefore)).toBe(true)
        const seqs = published.map((p) => p.seq)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        expect(new Set(seqs).size).toBe(fibers)
        // Every fiber's commit is there once, and storage holds them in the order they were published.
        expect(new Set(published.map((p) => p.text)).size).toBe(fibers)
        const stored = yield* control.storage.scanEntries({ conversationId, order: "ascending" }, 100, undefined)
        expect(stored.items.map((entry) => (entry.data as { text: string }).text)).toEqual(
          published.map((p) => p.text as string),
        )
        expect(new Set(ids).size).toBe(fibers)
      }),
    ))

  test("commit-atomic: a waiter's code after its commit runs only once the next commit on the line is published", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const events: string[] = []
        session.observeCommits({
          advance: (publication) => {
            for (const change of publication.changes) {
              if (change.type === "entry") events.push(`published ${(change.value.data as { text: string }).text}`)
            }
          },
          end: () => {},
        })

        control.holding = true
        // Whatever the waiter does once it resumes, such as CPU work, runs here.
        const waiter = yield* Effect.forkChild(
          Effect.tap(note(session, conversationId, "waiter"), () => Effect.sync(() => events.push("waiter resumed"))),
        )
        yield* Queue.take(control.arrived)
        // The next commit is admitted while the waiter's commit is in storage.
        const admitted = yield* Queue.unbounded<void>()
        const next = yield* Effect.forkChild(
          Effect.andThen(Queue.offer(admitted, undefined), note(session, conversationId, "next")),
        )
        yield* Queue.take(admitted)
        control.holding = false
        yield* Queue.offer(control.releases, undefined)
        yield* Fiber.join(waiter)
        yield* Fiber.join(next)

        // A wake run inside the line would put the waiter's code, and all the time it takes, before the next commit.
        expect(events).toEqual(["published waiter", "published next", "waiter resumed"])
      }).pipe(
        // No cooperative yields, so the order shows only how the line wakes its waiters.
        Effect.provideService(Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER),
      ),
    ))

  test("commit-read-after-write: a commit admitted while another is in storage starts only once that one is stored, and reads it", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)

        control.holding = true
        const first = yield* Effect.forkChild(note(session, conversationId, "first"))
        yield* Queue.take(control.arrived)
        let started = false
        const reader = yield* Effect.forkChild(
          session.commit((tx) => {
            started = true
            return tx.latestEntryId(conversationId)
          }),
        )
        // Give a line that ran jobs side by side every chance to start the reader.
        yield* Effect.repeat(Effect.yieldNow, { times: 10 })
        expect(started).toBe(false)
        control.holding = false
        yield* Queue.offer(control.releases, undefined)
        const written = yield* Fiber.join(first)
        expect(yield* Fiber.join(reader)).toBe(written.id)
      }),
    ))

  test("commit-tx-api: a conversation, an entry and a submission commit as one change, and a failing callback stores none of them", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const { published } = recordCommits(session)

        const { conversation, entry, submission } = yield* session.commit((tx) =>
          Effect.gen(function* () {
            const conversation = yield* tx.createConversation({ ownership: { kind: "ownerless" } })
            const entry = yield* tx.appendEntry(conversation.id, { kind: "user", data: "hello" })
            const submission = yield* tx.createSubmission({
              conversationId: conversation.id,
              type: "input",
              status: "placed",
              entry: entry.id,
            })
            return { conversation, entry, submission }
          }),
        )
        expect(published).toHaveLength(1)
        expect(published[0]!.changes.map((change) => change.type).sort()).toEqual([
          "conversation",
          "entry",
          "submission",
        ])
        expect(yield* control.storage.conversation(conversation.id)).toEqual(conversation)
        expect((yield* control.storage.entry(entry.id))?.entry).toEqual(entry)
        expect(yield* control.storage.submission(submission.id)).toEqual(submission)

        // Writes, then a failure: nothing is stored or published, and the Session goes on.
        const failed = yield* Effect.exit(
          session.commit((tx) =>
            Effect.gen(function* () {
              yield* tx.appendEntry(conversation.id, { kind: "user", data: "lost" })
              yield* tx.createConversation({ ownership: { kind: "ownerless" } })
              return yield* Effect.fail("callback gave up")
            }),
          ),
        )
        expect(failureOf(failed)).toBe("callback gave up")
        expect(published).toHaveLength(1)
        const entries = yield* control.storage.scanEntries({ conversationId: conversation.id }, 10, undefined)
        expect(entries.items.map((item) => item.id)).toEqual([entry.id])
        const conversations = yield* control.storage.scanConversations({}, 10, undefined)
        expect(conversations.items.map((item) => item.id)).toEqual([conversation.id])
        yield* note(session, conversation.id, "still open")
        expect(published).toHaveLength(2)
      }),
    ))

  test("commit-tx-api: a table read after the commit's first table write is a ReadAfterWrite defect, and nothing is stored", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const exit = yield* Effect.exit(
          session.commit((tx) =>
            Effect.gen(function* () {
              yield* tx.appendEntry(conversationId, { kind: "note" })
              return yield* tx.conversation(conversationId)
            }),
          ),
        )
        expect(defectOf(exit)).toBeInstanceOf(ReadAfterWrite)
        expect((yield* control.storage.scanEntries({ conversationId }, 10, undefined)).items).toEqual([])
      }),
    ))

  test("commit-tx-api: a Tx call that dies after its checks fails the commit even when the callback caught it, and nothing is stored", () =>
    run(
      Effect.gen(function* () {
        const session = yield* openSession(yield* openSqliteStorage(databasePath()))
        const conversationId = yield* newConversation(session)
        const Notes = defineDoc<{ text: string }>({
          kind: "test.poison",
          version: 1,
          scope: "conversation",
          history: "latest",
          fork: "current",
          initial: () => ({ text: "" }),
          checkpointWhen: () => false,
        })
        const missing = 999_999 as ConversationId
        const calls: readonly (readonly [string, (tx: Tx) => Effect.Effect<unknown, unknown>])[] = [
          ["appendEntry", (tx) => tx.appendEntry(missing, { kind: "note" })],
          [
            "createConversation",
            (tx) => tx.createConversation({ ownership: { kind: "task", taskId: 999_999 as TaskId } }),
          ],
          [
            "forkConversation",
            (tx) => tx.forkConversation(conversationId, 999_999 as EntryId, { ownership: { kind: "ownerless" } }),
          ],
          ["doc", (tx) => tx.doc(Notes, missing)],
        ]
        for (const [name, call] of calls) {
          const exit = yield* Effect.exit(
            session.commit((tx) =>
              Effect.gen(function* () {
                yield* Effect.catchDefect(Effect.asVoid(call(tx)), () => Effect.void)
                yield* tx.appendEntry(conversationId, { kind: "note", data: name })
              }),
            ),
          )
          expect([name, String(defectOf(exit))]).toEqual([name, expect.stringMatching(/does not exist|is not visible/)])
        }
        const entries = yield* session.read((reads) => reads.scanEntries({ conversationId }, 10, undefined))
        expect(entries.items).toEqual([])
        expect(session.failure).toBeUndefined()
      }),
    ))

  test("commit-tx-api: a refusal a Tx call raises before touching the transaction, once caught, still commits", () =>
    run(
      Effect.gen(function* () {
        const session = yield* openSession(yield* openSqliteStorage(databasePath()))
        const conversationId = yield* newConversation(session)
        yield* session.commit((tx) =>
          Effect.gen(function* () {
            yield* tx.appendEntry(conversationId, { kind: "note", data: "kept" })
            const refused = yield* Effect.exit(tx.conversation(conversationId))
            expect(defectOf(refused)).toBeInstanceOf(ReadAfterWrite)
          }),
        )
        const entries = yield* session.read((reads) => reads.scanEntries({ conversationId }, 10, undefined))
        expect(entries.items.map((entry) => entry.data)).toEqual(["kept"])
      }),
    ))

  test("commit-tx-read: a commit finds a placed input's entry through Tx.submission and answers it", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const queued = yield* session.commit((tx) =>
          tx.createSubmission({ conversationId, type: "input", status: "queued", requestId: "r-1" }),
        )
        // An inbox boundary places it at its entry.
        const entry = yield* session.commit((tx) =>
          Effect.gen(function* () {
            const entry = yield* tx.appendEntry(conversationId, { kind: "user", data: "question" })
            yield* tx.placeSubmission(queued.id, entry.id)
            return entry
          }),
        )
        // A tool reads its run's input without scanning, then answers it after its first write.
        const answered = yield* session.commit((tx) =>
          Effect.gen(function* () {
            const input = yield* tx.submission(queued.id)
            const byRequest = yield* tx.submissionByRequest(conversationId, "r-1")
            const inputEntry = input?.status === "placed" ? yield* tx.entry(input.entry!) : undefined
            const answer = yield* tx.appendEntry(conversationId, { kind: "assistant", data: "answer" })
            yield* tx.settleSubmission(queued.id, { status: "done", answer: answer.id })
            return { input, byRequest, inputEntry, answer }
          }),
        )
        expect(answered.input).toMatchObject({ status: "placed", entry: entry.id })
        expect(answered.byRequest?.id).toBe(queued.id)
        expect(answered.inputEntry).toEqual(entry)
        expect(yield* control.storage.submission(queued.id)).toEqual({
          ...queued,
          status: "done",
          entry: entry.id,
          answer: answered.answer.id,
        } as SubmissionRecord)
      }),
    ))

  test("entry-immutable: an appended entry is a frozen copy of its draft, and storage keeps it as committed", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const data = { text: "original", tags: ["a"] }
        const entry = yield* session.commit((tx) =>
          tx.appendEntry(conversationId, { kind: "note", data, head: "self" }),
        )
        expect(entry.head).toBe(entry.id)

        data.text = "changed after append"
        data.tags.push("b")
        expect(() => {
          ;(entry.data as { text: string }).text = "changed in place"
        }).toThrow(TypeError)
        expect(() => {
          ;((entry.data as { tags: string[] }).tags as string[]).push("c")
        }).toThrow(TypeError)
        expect(entry.data).toEqual({ text: "original", tags: ["a"] })
        expect((yield* control.storage.entry(entry.id))?.entry.data).toEqual({ text: "original", tags: ["a"] })
      }),
    ))

  test("entry-custom: a defineEntry token sets the kind, and reading with it finds only that kind", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const Bookmark = defineEntry<{ readonly label: string }>("app.bookmark")
        const { bookmark, other } = yield* session.commit((tx) =>
          Effect.gen(function* () {
            const bookmark = yield* tx.appendEntry(Bookmark, conversationId, { data: { label: "start" } })
            const other = yield* tx.appendEntry(conversationId, { kind: "note", data: { label: "not one" } })
            return { bookmark, other }
          }),
        )
        expect(bookmark.kind).toBe("app.bookmark")
        const read = yield* session.commit((tx) =>
          Effect.all([tx.entry(Bookmark, bookmark.id), tx.entry(Bookmark, other.id)]),
        )
        expect(read[0]?.data.label).toBe("start")
        expect(read[1]).toBeUndefined()
        expect(Bookmark.is(other)).toBe(false)
      }),
    ))

  test("session-failed: a storage error fails the commit that hit it, every later commit with SessionFailed, and closes the Session", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const { ends } = recordCommits(session)
        let closeListened = 0
        session.subscribeClose(() => closeListened++)

        control.failCommits = true
        const hit = yield* Effect.exit(note(session, conversationId, "lost"))
        expect(failureOf(hit)).toBeInstanceOf(StorageError)

        const later = failureOf(yield* Effect.exit(note(session, conversationId, "later")))
        expect(later).toBeInstanceOf(SessionFailed)
        expect((later as SessionFailed).cause).toBe(failureOf(hit))
        const readOnly = failureOf(yield* Effect.exit(session.commit((tx) => tx.latestEntryId(conversationId))))
        expect(readOnly).toBeInstanceOf(SessionFailed)

        const end = yield* session.closed
        expect(end).toEqual({ kind: "failed", error: failureOf(hit) })
        expect(ends).toEqual([{ kind: "failed", error: failureOf(hit) }])
        expect(closeListened).toBe(1)
        expect(control.closed).toBe(true)
      }),
    ))

  test("session-failed: a commit whose callback caught a failed read fails with SessionFailed", () =>
    run(
      Effect.gen(function* () {
        const path = databasePath()
        const control = yield* testStorage(path)
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        // Closing the storage under the Session makes its next read fail as a broken database would.
        yield* control.storage.close()
        const exit = yield* Effect.exit(
          session.commit((tx) =>
            Effect.gen(function* () {
              yield* Effect.ignore(tx.latestEntryId(conversationId))
              return "carried on"
            }),
          ),
        )
        expect(failureOf(exit)).toBeInstanceOf(SessionFailed)
        expect((yield* session.closed).kind).toBe("failed")
      }),
    ))

  test("session-read-only: a read-only Session refuses a commit with writes before storage, and keeps answering reads", () =>
    run(
      Effect.gen(function* () {
        const path = databasePath()
        const conversationId = yield* Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* openSession(yield* openSqliteStorage(path))
            const conversationId = yield* newConversation(writer)
            yield* note(writer, conversationId, "kept")
            return conversationId
          }),
        )
        const control = yield* testStorage(path)
        const viewer = yield* openSession(control.storage, { readOnly: true })
        const { published } = recordCommits(viewer)

        const refused = yield* Effect.exit(note(viewer, conversationId, "refused"))
        expect(failureOf(refused)).toBe(ReadOnlySession.instance)
        expect(control.stored).toEqual([])
        expect(published).toEqual([])

        const page = yield* viewer.commit((tx) => tx.scanEntries({ conversationId }, 10))
        expect(page.items.map((entry) => entry.data)).toEqual([{ text: "kept" }])
        yield* viewer.close
        expect(yield* viewer.closed).toEqual({ kind: "closed" })
      }),
    ))

  test("commit-atomic: close lets admitted commits finish, then refuses new ones and ends observers", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const { published, ends } = recordCommits(session)

        control.holding = true
        const admitted = yield* Effect.forkChild(note(session, conversationId, "admitted"))
        yield* Queue.take(control.arrived)
        const closing = yield* Effect.forkChild(session.close)
        yield* Effect.yieldNow
        expect(failureOf(yield* Effect.exit(note(session, conversationId, "too late"))).message).toBe(
          "Session is closed",
        )
        yield* Queue.offer(control.releases, undefined)
        yield* Fiber.join(closing)
        expect((yield* Fiber.join(admitted)).data).toEqual({ text: "admitted" })
        expect(published).toHaveLength(1)
        expect(ends).toEqual([{ kind: "ended" }])
        expect(control.closed).toBe(true)
      }),
    ))
  test("commit-tx-api: a caller that stops waiting before its commit reaches storage abandons it, also while its writes are assembled", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        const { entry, queued } = yield* session.commit((tx) =>
          Effect.gen(function* () {
            const entry = yield* tx.appendEntry(conversationId, { kind: "user" })
            const queued = yield* tx.createSubmission({ conversationId, type: "input", status: "queued" })
            return { entry, queued }
          }),
        )
        const storedBefore = control.stored.length

        // Placing a submission this commit did not create reads it from storage once the callback is done.
        control.holdingReads = true
        const caller = yield* Effect.forkChild(session.commit((tx) => tx.placeSubmission(queued.id, entry.id)))
        yield* Queue.take(control.arrived)
        yield* Fiber.interrupt(caller)
        control.holdingReads = false
        yield* Queue.offer(control.releases, undefined)

        // The next commit runs after the abandoned one left the line.
        yield* note(session, conversationId, "after")
        expect(control.stored.length).toBe(storedBefore + 1)
        expect((yield* control.storage.submission(queued.id))?.status).toBe("queued")
      }),
    ))

  test("commit-atomic: an observer whose async advance rejects is detached and ended listener_error, and commits go on", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const ends = yield* Queue.unbounded<CommitObserverEnd>()
        let advanced = 0
        const failure = new Error("observer broke")
        session.observeCommits({
          advance: (async () => {
            advanced++
            throw failure
          }) as () => void,
          end: (end) => Queue.offerUnsafe(ends, end),
        })
        const conversationId = yield* newConversation(session)
        expect(yield* Queue.take(ends)).toEqual({ kind: "listener_error", error: failure })
        yield* note(session, conversationId, "after")
        expect(advanced).toBe(1)
      }),
    ))

  test("commit-tx-api: a conversation cannot be owned by a task that is finishing, finished or abort-marked", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        // The Session cannot create tasks yet, so they are stored through the Storage port.
        const task = (state: TaskRecord["state"], abortRequested = false) =>
          Effect.gen(function* () {
            const id = yield* control.storage.mintId<TaskId>()
            const record = {
              id,
              conversationId,
              kind: "test.task",
              version: 1,
              input: null,
              background: false,
              abortRequested,
              state,
            } as TaskRecord
            yield* control.storage.commit([[{ type: "task", value: record }]], () => {})
            return id
          })
        const live = yield* task({ status: "running", checkpoint: null })
        const completing = yield* task({ status: "completing", outcome: { status: "completed", result: null } })
        const terminal = yield* task({ status: "terminal", outcome: { status: "completed", result: null } })
        const aborting = yield* task({ status: "running", checkpoint: null }, true)
        const own = (taskId: TaskId) =>
          Effect.exit(session.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId } })))

        expect(Exit.isSuccess(yield* own(live))).toBe(true)
        for (const [taskId, why] of [
          [completing, "is completing"],
          [terminal, "is terminal"],
          [aborting, "is abort-marked"],
        ] as const) {
          expect((defectOf(yield* own(taskId)) as Error).message).toBe(`Conversation owner task ${taskId} ${why}`)
        }
      }),
    ))
  test("session-failed: a close listener or observer end that returns a rejecting promise has the rejection contained", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        // A promise that records whether the Session attached a rejection handler to it.
        const handled: string[] = []
        const rejecting = (name: string) =>
          ({
            then: (_onFulfilled: unknown, onRejected: unknown) => {
              if (typeof onRejected === "function") handled.push(name)
            },
          }) as unknown as void
        session.subscribeClose(() => rejecting("close listener"))
        session.observeCommits({ advance: () => rejecting("advance"), end: () => rejecting("end") })
        yield* newConversation(session)
        yield* session.close
        expect(handled.sort()).toEqual(["advance", "close listener", "end"])
      }),
    ))
  test("commit-atomic: an observer attached while close drains admitted commits gets them, then ends; one attached after close ends at once", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)

        control.holding = true
        const admitted = yield* Effect.forkChild(note(session, conversationId, "admitted"))
        yield* Queue.take(control.arrived)
        const closing = yield* Effect.forkChild(session.close)
        yield* Effect.yieldNow
        const late = recordCommits(session)
        yield* Queue.offer(control.releases, undefined)
        yield* Fiber.join(closing)
        yield* Fiber.join(admitted)
        expect(late.published).toHaveLength(1)
        expect(late.ends).toEqual([{ kind: "ended" }])

        let afterClose: CommitObserverEnd | undefined
        expect(() =>
          session.observeCommits({
            advance: () => {},
            end: (end) => {
              afterClose = end
              throw new Error("end threw")
            },
          }),
        ).not.toThrow()
        expect(afterClose).toEqual({ kind: "ended" })
      }),
    ))
  test("session-failed: a storage read that dies on a corrupt record fails the Session like a storage error", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const conversationId = yield* newConversation(session)
        control.breakScans = true
        const hit = failureOf(yield* Effect.exit(session.commit((tx) => tx.latestEntryId(conversationId))))
        expect(hit).toBeInstanceOf(StorageError)
        expect((hit as StorageError).cause).toBeInstanceOf(SyntaxError)
        expect(failureOf(yield* Effect.exit(note(session, conversationId, "later")))).toBeInstanceOf(SessionFailed)
        expect(yield* session.closed).toEqual({ kind: "failed", error: hit })
      }),
    ))

  test("commit-atomic: an observer that another observer's end detached during close gets no end", () =>
    run(
      Effect.gen(function* () {
        const control = yield* testStorage(databasePath())
        const session = yield* openSession(control.storage)
        const ended: string[] = []
        let second: { detach(): void } | undefined
        session.observeCommits({
          advance: () => {},
          end: () => {
            ended.push("first")
            second?.detach()
          },
        })
        second = session.observeCommits({ advance: () => {}, end: () => ended.push("second") })
        yield* session.close
        expect(ended).toEqual(["first"])
      }),
    ))
})
