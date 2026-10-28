import { Database } from "bun:sqlite"
import {
  FellBehind,
  LIVE_OUTPUT_TAIL,
  NoSuchApproval,
  NoSuchConversation,
  type ApprovalId,
  type Approvals,
  type Author,
  type CallId,
  type Commit,
  type Conversation,
  type ConversationId,
  type Delivery,
  type Entry,
  type EntryBody,
  type EntryId,
  type Live,
  type Lineage,
  type LiveChange,
  type Mail,
  type ModelSelection,
  type Queued,
  type Snapshot,
  type Status,
  type SubmissionId,
} from "@nisse/protocol"
import { Cause, Context, Effect, Layer, Queue, Stream } from "effect"
import { newId } from "./ids.ts"
import { migrate } from "./migrations.ts"

export interface NewEntry {
  readonly author: Author
  readonly body: EntryBody
}

export interface Change {
  readonly entries?: ReadonlyArray<NewEntry>
  readonly live?: ReadonlyArray<LiveChange>
  readonly status?: Status
  readonly submit?: {
    readonly id: SubmissionId
    readonly requestId: string
    readonly author: Author
    readonly text: string
    readonly steer: boolean
    readonly mail?: Mail
  }
  readonly place?: ReadonlyArray<SubmissionId>
  readonly attempts?: number
  readonly providerState?: unknown
  readonly approval?: { readonly id: ApprovalId; readonly call: CallId }
  readonly model?: ModelSelection
}

export interface ConversationState {
  readonly conversation: Conversation
  readonly status: Status
  readonly attempts: number
  readonly providerState: unknown
  readonly providerSeq: number
}

const SUBSCRIBER_QUEUE = 4096

interface ConversationRow {
  id: string
  cwd: string
  created_at: number
  model: string
  approvals: Approvals
  status: Status
  live: string
  attempts: number
  provider_state: string | null
  provider_seq: number
  lineage: string | null
}

interface SubmissionRow {
  id: string
  author: string
  text: string
  steer: number
  mail: string | null
}

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id as ConversationId,
  cwd: row.cwd,
  createdAt: row.created_at,
  model: JSON.parse(row.model) as ModelSelection,
  approvals: row.approvals,
  ...(row.lineage === null ? {} : { lineage: JSON.parse(row.lineage) as Lineage }),
})

const toQueued = (row: SubmissionRow): Queued => ({
  submission: row.id as SubmissionId,
  author: JSON.parse(row.author) as Author,
  text: row.text,
  steer: row.steer === 1,
  ...(row.mail === null ? {} : { mail: JSON.parse(row.mail) as Mail }),
})

const STARTS_A_RUN = "(mail IS NULL OR mail ->> '$.kind' = 'new_task')"

const applyLive = (live: Live, changes: ReadonlyArray<LiveChange>): Live => {
  let text = live.text
  const output = { ...live.output }
  for (const change of changes) {
    switch (change._tag) {
      case "clear":
        text = ""
        for (const call of Object.keys(output)) delete output[call]
        break
      case "text":
        text += change.append
        break
      case "text_end":
        text = ""
        break
      case "output":
        output[change.call] = ((output[change.call] ?? "") + change.append).slice(-LIVE_OUTPUT_TAIL)
        break
      case "output_end":
        delete output[change.call]
    }
  }
  return { text, output }
}

export class Store extends Context.Service<
  Store,
  {
    readonly start: (cwd: string, model: ModelSelection, approvals: Approvals, lineage?: Lineage) => Conversation
    readonly family: (root: ConversationId) => ReadonlyArray<ConversationState>
    readonly lastModel: () => ModelSelection | undefined
    readonly list: () => ReadonlyArray<Conversation>
    readonly state: (conversation: ConversationId) => Effect.Effect<ConversationState, NoSuchConversation>
    readonly commit: (conversation: ConversationId, change: Change) => Commit
    readonly submissionFor: (conversation: ConversationId, requestId: string) => SubmissionId | undefined
    readonly nextQueued: (conversation: ConversationId) => Queued | undefined
    readonly queuedSteers: (conversation: ConversationId) => ReadonlyArray<Queued>
    readonly queuedMail: (conversation: ConversationId) => ReadonlyArray<Queued>
    readonly transcript: (conversation: ConversationId) => ReadonlyArray<Entry>
    readonly resolveApproval: (
      conversation: ConversationId,
      approval: ApprovalId,
      author: Author,
      allow: boolean,
    ) => Effect.Effect<boolean, NoSuchApproval>
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
          "SELECT id, author, text, steer, mail FROM submissions WHERE conversation = ? AND placed_seq IS NULL ORDER BY rowid",
        )
        const nextQueuedRow = db.query<SubmissionRow, [string]>(
          `SELECT id, author, text, steer, mail FROM submissions WHERE conversation = ? AND placed_seq IS NULL AND ${STARTS_A_RUN} ORDER BY rowid LIMIT 1`,
        )
        const steerRows = db.query<SubmissionRow, [string]>(
          "SELECT id, author, text, steer, mail FROM submissions WHERE conversation = ? AND placed_seq IS NULL AND steer = 1 ORDER BY rowid",
        )
        const mailRows = db.query<SubmissionRow, [string]>(
          `SELECT id, author, text, steer, mail FROM submissions WHERE conversation = ? AND placed_seq IS NULL AND NOT ${STARTS_A_RUN} ORDER BY rowid`,
        )
        const familyRows = db.query<ConversationRow, [string, string]>(
          "SELECT * FROM conversations WHERE id = ? OR root = ? ORDER BY created_at, rowid",
        )
        const entryRows = db.query<{ body: string }, [string]>(
          "SELECT body FROM entries WHERE conversation = ? ORDER BY seq, rowid",
        )
        const commitsSince = db.query<{ body: string }, [string, number]>(
          "SELECT body FROM commits WHERE conversation = ? AND seq > ? ORDER BY seq",
        )
        const approvalRow = db.query<{ answered_seq: number | null }, [string, string]>(
          "SELECT answered_seq FROM approvals WHERE id = ? AND conversation = ?",
        )

        const snapshot = (row: ConversationRow): Snapshot => ({
          _tag: "snapshot",
          conversation: toConversation(row),
          seq: lastSeq.get(row.id)?.seq ?? 0,
          entries: entryRows.all(row.id).map((r) => JSON.parse(r.body) as Entry),
          live: JSON.parse(row.live) as Live,
          queued: queuedRows.all(row.id).map(toQueued),
          status: row.status,
        })

        const write = (conversation: ConversationId, change: Change): Commit => {
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
            db.run(
              "INSERT INTO submissions (id, conversation, request_id, author, text, steer, mail) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [
                s.id,
                conversation,
                s.requestId,
                JSON.stringify(s.author),
                s.text,
                s.steer ? 1 : 0,
                s.mail === undefined ? null : JSON.stringify(s.mail),
              ],
            )
          }
          for (const submission of change.place ?? []) {
            db.run("UPDATE submissions SET placed_seq = ? WHERE id = ?", [seq, submission])
          }
          if (change.approval) {
            db.run("INSERT INTO approvals (id, conversation, call) VALUES (?, ?, ?)", [
              change.approval.id,
              conversation,
              change.approval.call,
            ])
          }
          if (change.live && change.live.length > 0) {
            const row = conversationRow.get(conversation)!
            const live = applyLive(JSON.parse(row.live) as Live, change.live)
            db.run("UPDATE conversations SET live = ? WHERE id = ?", [JSON.stringify(live), conversation])
          }
          if (change.status) {
            db.run("UPDATE conversations SET status = ? WHERE id = ?", [change.status, conversation])
          }
          if (change.attempts !== undefined) {
            db.run("UPDATE conversations SET attempts = ? WHERE id = ?", [change.attempts, conversation])
          }
          if (change.model) {
            const row = conversationRow.get(conversation)!
            const switched = (JSON.parse(row.model) as ModelSelection).provider !== change.model.provider
            db.run("UPDATE conversations SET model = ?, model_at = ? WHERE id = ?", [
              JSON.stringify(change.model),
              at,
              conversation,
            ])
            if (switched) {
              db.run("UPDATE conversations SET provider_state = NULL, provider_seq = ? WHERE id = ?", [
                seq,
                conversation,
              ])
            }
          }
          if (change.providerState !== undefined) {
            db.run("UPDATE conversations SET provider_state = ?, provider_seq = ? WHERE id = ?", [
              JSON.stringify(change.providerState),
              seq,
              conversation,
            ])
          }
          const commit: Commit = {
            _tag: "commit",
            seq,
            at,
            conversation,
            entries,
            ...(change.live && change.live.length > 0 ? { live: change.live } : {}),
            ...(change.submit
              ? {
                  enqueued: {
                    submission: change.submit.id,
                    author: change.submit.author,
                    text: change.submit.text,
                    steer: change.submit.steer,
                    ...(change.submit.mail === undefined ? {} : { mail: change.submit.mail }),
                  },
                }
              : {}),
            ...(change.status ? { status: change.status } : {}),
          }
          db.run("INSERT INTO commits (seq, conversation, body) VALUES (?, ?, ?)", [
            seq,
            conversation,
            JSON.stringify(commit),
          ])
          return commit
        }

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

        const commit = (conversation: ConversationId, change: Change) => {
          const committed = db.transaction(write)(conversation, change)
          publish(committed)
          return committed
        }

        const stateOf = (row: ConversationRow): ConversationState => ({
          conversation: toConversation(row),
          status: row.status,
          attempts: row.attempts,
          providerState: row.provider_state === null ? undefined : JSON.parse(row.provider_state),
          providerSeq: row.provider_seq,
        })

        const findConversation = (conversation: ConversationId) =>
          Effect.suspend(() => {
            const row = conversationRow.get(conversation)
            return row ? Effect.succeed(row) : Effect.fail(new NoSuchConversation({ conversation }))
          })

        return Store.of({
          start: (cwd, model, approvals, lineage) => {
            const id = newId()
            const now = Date.now()
            db.run(
              "INSERT INTO conversations (id, cwd, created_at, model, model_at, approvals, live, lineage, root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                id,
                cwd,
                now,
                JSON.stringify(model),
                now,
                approvals,
                JSON.stringify({ text: "", output: {} }),
                lineage === undefined ? null : JSON.stringify(lineage),
                lineage?.root ?? null,
              ],
            )
            return toConversation(conversationRow.get(id)!)
          },
          family: (root) => familyRows.all(root, root).map(stateOf),
          lastModel: () => {
            const row = db
              .query<
                { model: string },
                []
              >("SELECT model FROM conversations ORDER BY model_at DESC, rowid DESC LIMIT 1")
              .get()
            return row ? (JSON.parse(row.model) as ModelSelection) : undefined
          },
          list: () =>
            db
              .query<ConversationRow, []>("SELECT * FROM conversations ORDER BY created_at DESC, rowid DESC")
              .all()
              .map(toConversation),
          state: (conversation) => Effect.map(findConversation(conversation), stateOf),
          commit,
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
          queuedSteers: (conversation) => steerRows.all(conversation).map(toQueued),
          queuedMail: (conversation) => mailRows.all(conversation).map(toQueued),
          transcript: (conversation) => entryRows.all(conversation).map((r) => JSON.parse(r.body) as Entry),
          resolveApproval: (conversation, approval, author, allow) =>
            Effect.suspend(() => {
              const outcome = db.transaction(() => {
                const row = approvalRow.get(approval, conversation)
                if (!row) return "missing" as const
                if (row.answered_seq !== null) return "answered" as const
                const committed = write(conversation, {
                  entries: [{ author, body: { _tag: "approval_answer", approval, allow } }],
                })
                db.run("UPDATE approvals SET answered_seq = ? WHERE id = ?", [committed.seq, approval])
                return committed
              })()
              if (outcome === "missing") return Effect.fail(new NoSuchApproval({ approval }))
              if (outcome === "answered") return Effect.succeed(false)
              publish(outcome)
              return Effect.succeed(true)
            }),
          openRuns: () =>
            db
              .query<{ id: string }, []>("SELECT id FROM conversations WHERE status != 'idle'")
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
  migrate(db)
  return db
}
