// Documents through the Session's public API over real SQLite storage: committed with entries, scoped, kept in history
// and forked, and followed by observers and watches. The upstream rows cover the rest of section 3; these prove the
// kernel's own Effect surface, and the bound a stalled watch keeps (spec 9.2).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Deferred, Effect, Exit, Queue, type Scope, Stream } from "effect"
import {
  type CommitPublication,
  type ConversationId,
  type DocumentChange,
  type EntryRecord,
  defineDoc,
  openSession,
  openSqliteStorage,
  type Session,
  type Storage,
} from "../src/index.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const newSession = (): Effect.Effect<Session, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const home = mkdtempSync(join(tmpdir(), "nisse-documents-"))
    homes.push(home)
    return yield* openSession(yield* openSqliteStorage(join(home, "kernel.sqlite")))
  })

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> => Effect.runPromise(Effect.scoped(effect))

const Counter = defineDoc<{ count: number }>({
  kind: "test.counter",
  version: 1,
  scope: "session",
  initial: () => ({ count: 0 }),
  checkpointWhen: () => false,
})

const Notes = defineDoc<{ lines: string[] }>({
  kind: "test.notes",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ lines: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 9,
})

const Draft = defineDoc<{ text: string }>({
  kind: "test.draft",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ text: "" }),
  checkpointWhen: () => true,
})

const Scratch = defineDoc<{ text: string }>({
  kind: "test.scratch",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ text: "" }),
  checkpointWhen: () => true,
})

/** A window over a growing sequence: each change pushes one number and drops the oldest, so its ops never fold away. */
const Window = defineDoc<{ items: number[]; next: number }>({
  kind: "test.window",
  version: 1,
  scope: "session",
  initial: () => ({ items: [], next: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 99,
})

const newConversation = (session: Session): Effect.Effect<ConversationId, unknown> =>
  session.commit((tx) => Effect.map(tx.createConversation({ ownership: { kind: "ownerless" } }), (record) => record.id))

const addLine = (session: Session, conversationId: ConversationId, line: string) =>
  session.commit((tx) =>
    Effect.gen(function* () {
      const notes = yield* tx.doc(Notes, conversationId)
      notes.lines.push(line)
      return yield* tx.appendEntry(conversationId, { kind: "note", data: { line } })
    }),
  )

const bump = (session: Session) =>
  session.commit((tx) =>
    Effect.map(tx.doc(Counter), (counter) => {
      counter.count++
    }),
  )

const slide = (session: Session) =>
  session.commit((tx) =>
    Effect.map(tx.doc(Window), (window) => {
      window.items.push(window.next)
      window.next++
      if (window.items.length > 8) window.items.shift()
    }),
  )

/** The live heap after collection, in bytes. */
const heapUsed = (): number => {
  Bun.gc(true)
  Bun.gc(true)
  return process.memoryUsage().heapUsed
}

const median = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!

describe("documents", () => {
  test("doc-commit: a document change commits with its entry as one publication, and a failed callback stores neither", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        const published: CommitPublication[] = []
        session.observeCommits({ advance: (publication) => published.push(publication), end: () => {} })
        const conversationId = yield* newConversation(session)

        yield* addLine(session, conversationId, "first")
        expect(yield* session.snapshot(Notes, conversationId)).toEqual({ lines: ["first"] })
        expect(
          published
            .at(-1)!
            .changes.map((change) => change.type)
            .sort(),
        ).toEqual(["document", "entry"])

        const failed = yield* Effect.exit(
          session.commit((tx) =>
            Effect.gen(function* () {
              const notes = yield* tx.doc(Notes, conversationId)
              notes.lines.push("lost")
              yield* tx.appendEntry(conversationId, { kind: "note", data: { line: "lost" } })
              return yield* Effect.fail("gave up")
            }),
          ),
        )
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* session.snapshot(Notes, conversationId)).toEqual({ lines: ["first"] })
        const entries = yield* session.read((storage) => storage.scanEntries({ conversationId }, 10, undefined))
        expect(entries.items.map((entry) => entry.data)).toEqual([{ line: "first" }])
      }),
    ))

  test("doc-session-scope: a fork shares the session document with its parent, neither copied nor reset", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        const parent = yield* newConversation(session)
        const first = yield* session.commit((tx) =>
          Effect.gen(function* () {
            ;(yield* tx.doc(Counter)).count = 5
            return yield* tx.appendEntry(parent, { kind: "note", data: {} })
          }),
        )
        yield* session.commit((tx) =>
          Effect.gen(function* () {
            yield* tx.forkConversation(parent, first.id, { ownership: { kind: "ownerless" } })
            ;(yield* tx.doc(Counter)).count++
          }),
        )
        expect(yield* session.snapshot(Counter)).toEqual({ count: 6 })
        const documents = yield* session.read((storage) =>
          storage.scanDocuments(
            { scope: { kind: "session" }, at: "current", kind: Counter.definition.kind },
            10,
            undefined,
          ),
        )
        expect(documents.items).toHaveLength(1)
      }),
    ))

  test("doc-conversation-scope: each conversation has its own document of a kind", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        const a = yield* newConversation(session)
        const b = yield* newConversation(session)
        yield* addLine(session, a, "for a")
        expect(yield* session.snapshot(Notes, a)).toEqual({ lines: ["for a"] })
        expect(yield* session.snapshot(Notes, b)).toBeUndefined()
        yield* addLine(session, b, "for b")
        expect(yield* session.snapshot(Notes, a)).toEqual({ lines: ["for a"] })
        expect(yield* session.snapshot(Notes, b)).toEqual({ lines: ["for b"] })
      }),
    ))

  test("doc-history: a rewindable document reads as of any entry, and a fork starts from that point, the current value or nothing, by its policy", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        const parent = yield* newConversation(session)
        const entries: EntryRecord[] = []
        for (const line of ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"])
          entries.push(yield* addLine(session, parent, line))
        // Past a checkpoint too: the tenth change is stored as a base.
        expect(yield* session.snapshotAsOf(Notes, parent, entries[1]!.id)).toEqual({ lines: ["one", "two"] })
        expect(yield* session.snapshotAsOf(Notes, parent, entries[10]!.id)).toEqual({
          lines: entries.map((e) => (e.data as { line: string }).line),
        })

        yield* session.commit((tx) =>
          Effect.gen(function* () {
            ;(yield* tx.doc(Draft, parent)).text = "draft now"
            ;(yield* tx.doc(Scratch, parent)).text = "scratch now"
          }),
        )
        const fork = yield* session.commit((tx) =>
          Effect.map(
            tx.forkConversation(parent, entries[1]!.id, { ownership: { kind: "ownerless" } }),
            (record) => record.id,
          ),
        )
        expect(yield* session.snapshot(Notes, fork)).toEqual({ lines: ["one", "two"] })
        expect(yield* session.snapshot(Draft, fork)).toEqual({ text: "draft now" })
        expect(yield* session.snapshot(Scratch, fork)).toBeUndefined()

        // The fork's own history goes on from there, and the parent's is untouched.
        yield* addLine(session, fork, "forked")
        expect(yield* session.snapshot(Notes, fork)).toEqual({ lines: ["one", "two", "forked"] })
        expect((yield* session.snapshot(Notes, parent))!.lines).toHaveLength(11)
      }),
    ))

  test("doc-deltas: a small change to a big document reaches an observer as a small change", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        const conversationId = yield* newConversation(session)
        yield* session.commit((tx) =>
          Effect.map(tx.doc(Notes, conversationId), (notes) => {
            for (let i = 0; i < 2_000; i++) notes.lines.push(`line ${i} of a long transcript of notes`)
          }),
        )
        const changes: DocumentChange<{ lines: string[] }>[] = []
        const observation = yield* session.observeDoc(Notes, conversationId, {
          advance: (change) => changes.push(change),
          end: () => {},
        })
        expect(observation!.value.lines).toHaveLength(2_000)

        yield* addLine(session, conversationId, "one more")
        expect(changes).toHaveLength(1)
        expect(changes[0]!.value.lines.at(-1)).toBe("one more")
        expect(changes[0]!.retired).toBe(false)
        const opsSize = JSON.stringify(changes[0]!.ops).length
        expect(opsSize).toBeLessThan(100)
        expect(JSON.stringify(changes[0]!.value).length).toBeGreaterThan(50_000)
        observation!.detach()
      }),
    ))

  test("doc-watch: a watch gets each commit's change while it keeps up, a retirement, then the next incarnation whole", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        yield* bump(session)
        const watch = (yield* session.watchDoc(Counter))!
        expect(watch.value).toEqual({ count: 1 })
        const seen = yield* Queue.unbounded<DocumentChange<{ count: number }>>()
        yield* Effect.forkScoped(Stream.runForEach(watch.changes, (change) => Queue.offer(seen, change)))

        yield* bump(session)
        expect(yield* Queue.take(seen)).toEqual({ value: { count: 2 }, ops: [["s", ["count"], 2]], retired: false })
        yield* bump(session)
        expect((yield* Queue.take(seen)).value).toEqual({ count: 3 })

        yield* session.commit((tx) => tx.retireDoc(Counter))
        expect(yield* Queue.take(seen)).toEqual({ value: { count: 3 }, ops: [], retired: true })
        expect(yield* session.snapshot(Counter)).toBeUndefined()

        yield* bump(session)
        expect(yield* Queue.take(seen)).toEqual({ value: { count: 1 }, ops: [["r", { count: 1 }]], retired: false })
      }),
    ))

  test("doc-watch: closing the Session ends the watch's stream", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        yield* bump(session)
        const watch = (yield* session.watchDoc(Counter))!
        const done = yield* Deferred.make<void>()
        yield* Effect.forkScoped(Effect.ensuring(Stream.runDrain(watch.changes), Deferred.succeed(done, undefined)))
        yield* session.close
        yield* Deferred.await(done)
      }),
    ))

  test("doc-watch: a watch whose scope ends completes its stream, also for a consumer outside the scope", () =>
    run(
      Effect.gen(function* () {
        const session = yield* newSession()
        yield* bump(session)
        const watch = (yield* Effect.scoped(session.watchDoc(Counter)))!
        yield* bump(session)
        // Nothing pending reaches it after the scope's end, and the stream completes.
        expect(yield* Stream.runCollect(watch.changes)).toEqual([])
      }),
    ))

  test("doc-lifetime: a reset whose cold doc() dies on its migration fails the commit and keeps the stored document; retiring first resets it", () =>
    run(
      Effect.gen(function* () {
        const Old = defineDoc<{ count: number }>({
          kind: "test.reset",
          version: 1,
          scope: "session",
          initial: () => ({ count: 0 }),
          checkpointWhen: () => false,
        })
        const New = defineDoc<{ total: number }>({
          kind: "test.reset",
          version: 2,
          scope: "session",
          initial: () => ({ total: 0 }),
          migrate: () => {
            throw new Error("cannot migrate this value")
          },
          checkpointWhen: () => false,
        })
        const path = join(mkdtempSync(join(tmpdir(), "nisse-documents-")), "kernel.sqlite")
        homes.push(dirname(path))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* openSession(yield* openSqliteStorage(path))
            yield* session.commit((tx) => Effect.map(tx.doc(Old), (doc) => void (doc.count = 7)))
          }),
        )
        // A fresh Session has nothing cached, and the stored document's lookup yields, so the first doc() is still
        // loading while the retirement and the replacement start. Without the yield the calls run one after another.
        const stored = yield* openSqliteStorage(path)
        const storage = new Proxy(stored, {
          get(target, key) {
            if (key === "findDocument") {
              return (...args: Parameters<Storage["findDocument"]>) =>
                Effect.andThen(Effect.yieldNow, target.findDocument(...args))
            }
            const value = Reflect.get(target, key)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as Storage
        const session = yield* openSession(storage)

        const exit = yield* Effect.exit(
          session.commit((tx) =>
            Effect.gen(function* () {
              const [load, retire, replace] = yield* Effect.all(
                [Effect.exit(tx.doc(New)), Effect.exit(tx.retireDoc(New)), Effect.exit(tx.doc(New))],
                { concurrency: "unbounded" },
              )
              expect(Exit.isFailure(load)).toBe(true)
              if (Exit.isSuccess(replace)) replace.value.total = 1
              return retire
            }),
          ),
        )
        expect(
          String(Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Die" && exit.cause.reasons[0].defect),
        ).toContain("cannot migrate this value")
        expect(session.failure).toBeUndefined()
        expect(yield* session.snapshot(Old)).toEqual({ count: 7 })

        // A retirement before any doc() does not load the stored value, so it resets the address without migrating.
        yield* session.commit((tx) =>
          Effect.gen(function* () {
            yield* tx.retireDoc(New)
            ;(yield* tx.doc(New)).total = 1
          }),
        )
        expect(yield* session.snapshot(New)).toEqual({ total: 1 })
      }),
    ))

  test("doc-migration: one transaction cannot reach a document through two definition versions, and stores nothing", () =>
    run(
      Effect.gen(function* () {
        const Old = defineDoc<{ count: number }>({
          kind: "test.two-tokens",
          version: 1,
          scope: "session",
          initial: () => ({ count: 0 }),
          checkpointWhen: () => false,
        })
        const New = defineDoc<{ total: number }>({
          kind: "test.two-tokens",
          version: 2,
          scope: "session",
          initial: () => ({ total: 0 }),
          checkpointWhen: () => false,
        })
        const session = yield* newSession()
        yield* session.commit((tx) => Effect.map(tx.doc(Old), (doc) => void (doc.count = 1)))

        const mixed = yield* Effect.exit(
          session.commit((tx) =>
            Effect.gen(function* () {
              ;(yield* tx.doc(Old)).count = 2
              ;(yield* tx.doc(New)).total = 5
            }),
          ),
        )
        expect(Exit.isFailure(mixed)).toBe(true)
        expect(
          String(Exit.isFailure(mixed) && mixed.cause.reasons[0]?._tag === "Die" && mixed.cause.reasons[0].defect),
        ).toContain("two definitions")
        expect(yield* session.snapshot(Old)).toEqual({ count: 1 })

        // A retirement through the other definition fails the commit, also when the callback catches its defect.
        const caught = yield* Effect.exit(
          session.commit((tx) =>
            Effect.gen(function* () {
              ;(yield* tx.doc(Old)).count = 3
              yield* Effect.catchDefect(tx.retireDoc(New), () => Effect.void)
            }),
          ),
        )
        expect(
          String(Exit.isFailure(caught) && caught.cause.reasons[0]?._tag === "Die" && caught.cause.reasons[0].defect),
        ).toContain("two definitions")
        expect(yield* session.snapshot(Old)).toEqual({ count: 1 })
      }),
    ))

  test("view-slow-folding: a stalled watch neither slows commits nor grows, and resumes with one root replacement", () =>
    run(
      Effect.gen(function* () {
        // Receipts on an M-series Mac: a commit's median is 0.047 ms with or without a stalled watch, and 10,000 commits
        // grow the heap about 0.1 MB with one, against 7.2 MB for an observer that keeps every change. The bounds sit
        // past the healthy numbers and below the unbounded one.
        const commits = 10_000
        const unwatched = yield* newSession()
        yield* slide(unwatched)
        const baseline: number[] = []
        for (let i = 0; i < commits; i++) {
          const start = performance.now()
          yield* slide(unwatched)
          baseline.push(performance.now() - start)
        }

        const session = yield* newSession()
        yield* slide(session)
        const watch = (yield* session.watchDoc(Window))!
        const gate = yield* Deferred.make<void>()
        const seen = yield* Queue.unbounded<DocumentChange<{ items: number[]; next: number }>>()
        yield* Effect.forkScoped(
          Stream.runForEach(watch.changes, (change) => Effect.andThen(Queue.offer(seen, change), Deferred.await(gate))),
        )
        // The consumer takes the first change and stalls on it.
        yield* slide(session)
        expect((yield* Queue.take(seen)).value.next).toBe(2)

        const before = heapUsed()
        const watched: number[] = []
        for (let i = 0; i < commits; i++) {
          const start = performance.now()
          yield* slide(session)
          watched.push(performance.now() - start)
        }
        const grown = heapUsed() - before

        expect(median(watched)).toBeLessThan(2 * median(baseline) + 0.05)
        expect(grown).toBeLessThan(2_000_000)

        // Released, the consumer gets the newest value in one root replacement, then commits one by one again.
        yield* Deferred.succeed(gate, undefined)
        const caughtUp = yield* Queue.take(seen)
        expect(yield* session.snapshot(Window)).toEqual(caughtUp.value)
        expect(caughtUp.ops).toEqual([["r", caughtUp.value]])
        yield* slide(session)
        expect((yield* Queue.take(seen)).value.next).toBe(caughtUp.value.next + 1)
      }),
    ))
})
