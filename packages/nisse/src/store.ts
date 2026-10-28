import { Database } from "bun:sqlite"
import {
  FellBehind,
  NoSuchConversation,
  type Author,
  type Commit,
  type Conversation,
  type ConversationId,
  type Delivery,
  type Entry,
  type EntryBody,
  type EntryId,
  type LiveChange,
  type Queued,
  type Snapshot,
  type Status,
  type SubmissionId,
} from "@nisse/protocol"
import { Cause, Context, Effect, Layer, Queue, Stream } from "effect"
import { newId } from "./ids.ts"

export interface Change {
  readonly entries?: ReadonlyArray<{ readonly author: Author; readonly body: EntryBody }>
  readonly live?: LiveChange
  readonly status?: Status
  readonly submit?: {
    readonly id: SubmissionId
    readonly requestId: string
    readonly author: Author
    readonly text: string
  }
  readonly place?: SubmissionId
}

const SUBSCRIBER_QUEUE = 4096

const schema = [
  `CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    live TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE commits (seq INTEGER PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX commits_by_conversation ON commits (conversation, seq)`,
  `CREATE TABLE entries (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX entries_by_conversation ON entries (conversation, seq)`,
  `CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    conversation TEXT NOT NULL,
    request_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    placed_seq INTEGER,
    UNIQUE (conversation, request_id)
  )`,
  `CREATE INDEX submissions_waiting ON submissions (conversation) WHERE placed_seq IS NULL`,
]

interface ConversationRow {
  id: string
  cwd: string
  created_at: number
  status: Status
  live: string
}

interface SubmissionRow {
  id: string
  author: string
  text: string
}

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id as ConversationId,
  cwd: row.cwd,
  createdAt: row.created_at,
})

export class Store extends Context.Service<
  Store,
  {
    readonly start: (cwd: string) => Conversation
    readonly list: () => ReadonlyArray<Conversation>
    readonly exists: (conversation: ConversationId) => Effect.Effect<void, NoSuchConversation>
    readonly status: (conversation: ConversationId) => Status
    readonly commit: (conversation: ConversationId, change: Change) => Commit
    readonly submissionFor: (conversation: ConversationId, requestId: string) => SubmissionId | undefined
    readonly nextQueued: (conversation: ConversationId) => Queued | undefined
    readonly transcript: (conversation: ConversationId) => ReadonlyArray<Entry>
    readonly openRuns: () => ReadonlyArray<ConversationId>
    readonly pending: () => ReadonlyArray<ConversationId>
    readonly subscribe: (
      conversation: ConversationId,
      sinceSeq: number | undefined,
    ) => Stream.Stream<Delivery, NoSuchConversation | FellBehind>
  }
>()("nisse/Store") {
  static readonly layer = (path: string) =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => open(path)),
          (db) => Effect.sync(() => db.close()),
        )
        const subscribers = new Map<ConversationId, Set<Queue.Queue<Delivery, FellBehind>>>()

        const conversationRow = db.query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?")
        const lastSeq = db.query<{ seq: number | null }, [string]>(
          "SELECT max(seq) AS seq FROM commits WHERE conversation = ?",
        )
        const queuedRows = db.query<SubmissionRow, [string]>(
          "SELECT id, author, text FROM submissions WHERE conversation = ? AND placed_seq IS NULL ORDER BY rowid",
        )
        const nextQueuedRow = db.query<SubmissionRow, [string]>(
          "SELECT id, author, text FROM submissions WHERE conversation = ? AND placed_seq IS NULL ORDER BY rowid LIMIT 1",
        )
        const entryRows = db.query<{ body: string }, [string]>(
          "SELECT body FROM entries WHERE conversation = ? ORDER BY seq, rowid",
        )
        const commitsSince = db.query<{ body: string }, [string, number]>(
          "SELECT body FROM commits WHERE conversation = ? AND seq > ? ORDER BY seq",
        )

        const toQueued = (row: SubmissionRow): Queued => ({
          submission: row.id as SubmissionId,
          author: JSON.parse(row.author) as Author,
          text: row.text,
        })

        const snapshot = (row: ConversationRow): Snapshot => ({
          _tag: "snapshot",
          conversation: toConversation(row),
          seq: lastSeq.get(row.id)?.seq ?? 0,
          entries: entryRows.all(row.id).map((r) => JSON.parse(r.body) as Entry),
          live: row.live,
          queued: queuedRows.all(row.id).map(toQueued),
          status: row.status,
        })

        const write = db.transaction((conversation: ConversationId, change: Change): Commit => {
          const at = Date.now()
          const seq = (db.query<{ seq: number }, []>("SELECT coalesce(max(seq), 0) + 1 AS seq FROM commits").get()
            ?.seq ?? 1) as number
          const entries: Array<Entry> = (change.entries ?? []).map((e) => ({
            id: newId() as EntryId,
            seq,
            at,
            author: e.author,
            body: e.body,
          }))
          for (const entry of entries) {
            db.run("INSERT INTO entries (id, conversation, seq, body) VALUES (?, ?, ?, ?)", [
              entry.id,
              conversation,
              seq,
              JSON.stringify(entry),
            ])
          }
          if (change.submit) {
            const s = change.submit
            db.run("INSERT INTO submissions (id, conversation, request_id, author, text) VALUES (?, ?, ?, ?, ?)", [
              s.id,
              conversation,
              s.requestId,
              JSON.stringify(s.author),
              s.text,
            ])
          }
          if (change.place) {
            db.run("UPDATE submissions SET placed_seq = ? WHERE id = ?", [seq, change.place])
          }
          if (change.live?._tag === "append") {
            db.run("UPDATE conversations SET live = live || ? WHERE id = ?", [change.live.text, conversation])
          } else if (change.live?._tag === "clear") {
            db.run("UPDATE conversations SET live = '' WHERE id = ?", [conversation])
          }
          if (change.status) {
            db.run("UPDATE conversations SET status = ? WHERE id = ?", [change.status, conversation])
          }
          const commit: Commit = {
            _tag: "commit",
            seq,
            at,
            conversation,
            entries,
            ...(change.live ? { live: change.live } : {}),
            ...(change.submit
              ? { enqueued: { submission: change.submit.id, author: change.submit.author, text: change.submit.text } }
              : {}),
            ...(change.status ? { status: change.status } : {}),
          }
          db.run("INSERT INTO commits (seq, conversation, body) VALUES (?, ?, ?)", [
            seq,
            conversation,
            JSON.stringify(commit),
          ])
          return commit
        })

        const publish = (commit: Commit) => {
          const queues = subscribers.get(commit.conversation)
          if (!queues) return
          for (const queue of queues) {
            if (!Queue.offerUnsafe(queue, commit)) {
              queues.delete(queue)
              Effect.runSync(Queue.clear(queue))
              Queue.failCauseUnsafe(queue, Cause.fail(new FellBehind({ seq: commit.seq })))
            }
          }
        }

        const findConversation = (conversation: ConversationId) =>
          Effect.suspend(() => {
            const row = conversationRow.get(conversation)
            return row ? Effect.succeed(row) : Effect.fail(new NoSuchConversation({ conversation }))
          })

        return Store.of({
          start: (cwd) => {
            const row: ConversationRow = { id: newId(), cwd, created_at: Date.now(), status: "idle", live: "" }
            db.run("INSERT INTO conversations (id, cwd, created_at) VALUES (?, ?, ?)", [
              row.id,
              row.cwd,
              row.created_at,
            ])
            return toConversation(row)
          },
          list: () =>
            db
              .query<ConversationRow, []>("SELECT * FROM conversations ORDER BY created_at DESC, rowid DESC")
              .all()
              .map(toConversation),
          exists: (conversation) => Effect.asVoid(findConversation(conversation)),
          status: (conversation) => conversationRow.get(conversation)?.status ?? "idle",
          commit: (conversation, change) => {
            const commit = write(conversation, change)
            publish(commit)
            return commit
          },
          submissionFor: (conversation, requestId) =>
            db
              .query<
                { id: string },
                [string, string]
              >("SELECT id FROM submissions WHERE conversation = ? AND request_id = ?")
              .get(conversation, requestId)?.id as SubmissionId | undefined,
          nextQueued: (conversation) => {
            const row = nextQueuedRow.get(conversation)
            return row ? toQueued(row) : undefined
          },
          transcript: (conversation) => entryRows.all(conversation).map((r) => JSON.parse(r.body) as Entry),
          openRuns: () =>
            db
              .query<{ id: string }, []>("SELECT id FROM conversations WHERE status = 'working'")
              .all()
              .map((row) => row.id as ConversationId),
          pending: () =>
            db
              .query<{ conversation: string }, []>(
                "SELECT DISTINCT conversation FROM submissions WHERE placed_seq IS NULL",
              )
              .all()
              .map((row) => row.conversation as ConversationId),
          subscribe: (conversation, sinceSeq) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const row = yield* findConversation(conversation)
                const queue = yield* Queue.bounded<Delivery, FellBehind>(SUBSCRIBER_QUEUE)
                const first: Array<Delivery> =
                  sinceSeq === undefined
                    ? [snapshot(row)]
                    : commitsSince.all(conversation, sinceSeq).map((r) => JSON.parse(r.body) as Commit)
                let queues = subscribers.get(conversation)
                if (!queues) subscribers.set(conversation, (queues = new Set()))
                queues.add(queue)
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    queues.delete(queue)
                    if (queues.size === 0) subscribers.delete(conversation)
                  }),
                )
                return Stream.concat(Stream.fromIterable(first), Stream.fromQueue(queue))
              }),
            ),
        })
      }),
    )
}

const open = (path: string) => {
  const db = new Database(path, { create: true, strict: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
  if (version === 0) {
    db.transaction(() => {
      for (const statement of schema) db.run(statement)
      db.run("PRAGMA user_version = 1")
    })()
  }
  return db
}
