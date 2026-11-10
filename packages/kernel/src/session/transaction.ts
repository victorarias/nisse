// The transaction of one Session commit (spec section 4): table reads, then table writes, staged into one batch.
// Derived from pi-durable's `src/session/transaction.ts` at 7d073328e (MIT, see LICENSE).
import { copyJson } from "@nisse/delta/json"
import { Effect } from "effect"
import { ReadAfterWrite, StorageError } from "../errors.ts"
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  JsonValue,
  Page,
  StorageWrite,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from "../records.ts"
import type { ReadError, Storage } from "../storage.ts"
import type { Entry, EntryDraft, TypedEntry, TypedEntryDraft } from "./entry.ts"

/** Who owns a new conversation; chosen explicitly at every creation (spec 2). */
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId }

/** How a commit settles a queued or placed submission. */
export type SubmissionSettlement =
  | { readonly status: "done"; readonly answer: EntryId }
  | { readonly status: "unanswered"; readonly reason: string; readonly detail?: JsonValue }

/** A submission record before the Session assigns its ID. */
export type SubmissionCreate = SubmissionRecord extends infer R
  ? R extends SubmissionRecord
    ? Omit<R, "id">
    : never
  : never

/**
 * What a commit callback reads and writes. Table reads come first: a table read after the commit's first table write is
 * a `ReadAfterWrite` defect. Records it returns are frozen and shared with the commit's publication.
 *
 * A read's `StorageError` fails the Session (spec 10.1), so the commit fails even when the callback catches it.
 */
export interface Tx {
  conversation(id: ConversationId): Effect.Effect<ConversationRecord | undefined, StorageError>
  entry(id: EntryId): Effect.Effect<EntryRecord | undefined, ReadError>
  /** Undefined when the entry is absent or has another kind. */
  entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Effect.Effect<TypedEntry<D> | undefined, ReadError>
  task(id: TaskId): Effect.Effect<TaskRecord | undefined, StorageError>
  submission(id: SubmissionId): Effect.Effect<SubmissionRecord | undefined, StorageError>
  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
  ): Effect.Effect<SubmissionRecord | undefined, StorageError>
  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor?: Cursor,
  ): Effect.Effect<Page<ConversationRecord>, ReadError>
  scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Effect.Effect<Page<EntryRecord>, ReadError>
  scanTasks(query: TaskQuery, limit: number, cursor?: Cursor): Effect.Effect<Page<TaskRecord>, ReadError>
  /** The newest entry visible from the conversation that carries a `head`. */
  latestHeadMarker(
    conversationId: ConversationId,
  ): Effect.Effect<(EntryRecord & { readonly head: EntryId }) | undefined, ReadError>
  /** The ID of the newest entry visible from the conversation; `undefined` when it has none. */
  latestEntryId(conversationId: ConversationId): Effect.Effect<EntryId | undefined, ReadError>

  createConversation(options: {
    readonly ownership: ConversationOwnership
  }): Effect.Effect<ConversationRecord, StorageError>
  appendEntry(conversationId: ConversationId, draft: EntryDraft): Effect.Effect<EntryRecord, StorageError>
  /** The token supplies `kind` and types `data`. */
  appendEntry<D extends JsonValue>(
    token: Entry<D>,
    conversationId: ConversationId,
    draft: TypedEntryDraft<NoInfer<D>>,
  ): Effect.Effect<TypedEntry<D>, StorageError>
  /** A raw submission with a fresh ID. No admission rules apply: no busy check, no queueing, no placement. */
  createSubmission(create: SubmissionCreate): Effect.Effect<SubmissionRecord, StorageError>
  /**
   * Settles a queued or placed submission, against this commit's latest record of it, so it works after table writes.
   * Only a placed input or continue can be answered; a settled submission stays unchanged.
   */
  settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): Effect.Effect<void>
  /** Places a queued submission at `entry`: an input becomes `placed`, a write `done`. Resolved like a settlement. */
  placeSubmission(id: SubmissionId, entry: EntryId): Effect.Effect<void>
}

/** What a transaction needs from its Session. */
export type TransactionHost = {
  readonly storage: Storage
  /** Fails the Session with a storage error that a call of this transaction hit. */
  readonly failed: (error: StorageError) => void
}

type SubmissionChange = SubmissionSettlement | { readonly status: "placed"; readonly entry: EntryId }

const TABLE_COPY = { omitUndefinedProperties: true } as const

/** A frozen, detached copy: records are shared with publications and must not change after their commit. */
const freeze = <T>(value: unknown): T => deepFreeze(copyJson(value, TABLE_COPY)) as T

function deepFreeze(value: JsonValue): JsonValue {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * The complete record after one change. Placement turns a queued input `placed` and a queued write `done`; a continue is
 * never queued. Only a placed input or continue can be answered. A settled record stays.
 */
function applySubmissionChange(current: SubmissionRecord, change: SubmissionChange): SubmissionRecord {
  if (current.status === "done" || current.status === "unanswered") return current
  if (change.status === "placed") {
    if (current.status !== "queued") throw new Error(`Submission ${current.id} is not queued`)
    const status = current.type === "input" ? "placed" : "done"
    return { ...current, status, entry: change.entry } as SubmissionRecord
  }
  if (change.status === "done" && current.status !== "placed") {
    throw new Error(`Submission ${current.id} is not a placed input or continue`)
  }
  // Queued and placed records carry no answer, reason or detail; an unanswered input keeps its entry.
  return { ...current, ...change } as SubmissionRecord
}

/** One commit's transaction. The Session seals it when the callback settles, then takes its writes. */
export class Transaction implements Tx {
  readonly #host: TransactionHost
  #sealed = false
  #hasTableWrite = false
  /** Conversation and entry writes, in staging order. */
  readonly #writes: StorageWrite[] = []
  readonly #createdConversations = new Set<ConversationId>()
  /** Submissions this transaction created or changed, by ID, at their latest staged record. */
  readonly #submissions = new Map<SubmissionId, SubmissionRecord>()
  readonly #submissionChanges: { readonly id: SubmissionId; readonly change: SubmissionChange }[] = []

  constructor(host: TransactionHost) {
    this.#host = host
  }

  // Table reads

  conversation(id: ConversationId) {
    return this.#tableRead("conversation()", this.#host.storage.conversation(id))
  }

  entry(id: EntryId): Effect.Effect<EntryRecord | undefined, ReadError>
  entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Effect.Effect<TypedEntry<D> | undefined, ReadError>
  entry(first: EntryId | Entry<JsonValue>, second?: EntryId): Effect.Effect<EntryRecord | undefined, ReadError> {
    const token = typeof first === "number" ? undefined : first
    const id = typeof first === "number" ? first : second!
    return this.#tableRead(
      "entry()",
      Effect.map(this.#host.storage.entry(id), (stored) =>
        stored === undefined || (token !== undefined && !token.is(stored.entry)) ? undefined : stored.entry,
      ),
    )
  }

  task(id: TaskId) {
    return this.#tableRead("task()", this.#host.storage.task(id))
  }

  submission(id: SubmissionId) {
    return this.#tableRead("submission()", this.#host.storage.submission(id))
  }

  submissionByRequest(conversationId: ConversationId, requestId: string) {
    return this.#tableRead("submissionByRequest()", this.#host.storage.submissionByRequest(conversationId, requestId))
  }

  scanConversations(query: ConversationQuery, limit: number, cursor?: Cursor) {
    return this.#tableRead("scanConversations()", this.#host.storage.scanConversations(query, limit, cursor))
  }

  scanEntries(query: EntryQuery, limit: number, cursor?: Cursor) {
    return this.#tableRead("scanEntries()", this.#host.storage.scanEntries(query, limit, cursor))
  }

  scanTasks(query: TaskQuery, limit: number, cursor?: Cursor) {
    return this.#tableRead("scanTasks()", this.#host.storage.scanTasks(query, limit, cursor))
  }

  latestHeadMarker(conversationId: ConversationId) {
    return this.#tableRead("latestHeadMarker()", this.#host.storage.findLatestHeadMarker(conversationId, undefined))
  }

  latestEntryId(conversationId: ConversationId) {
    return this.#tableRead(
      "latestEntryId()",
      Effect.map(
        this.#host.storage.scanEntries({ conversationId, order: "descending" }, 1, undefined),
        (page) => page.items[0]?.id,
      ),
    )
  }

  // Table writes

  createConversation(options: { readonly ownership: ConversationOwnership }) {
    return this.#tableWrite(
      Effect.gen({ self: this }, function* () {
        const ownership = options.ownership
        let owner: ConversationRecord["owner"]
        if (ownership.kind === "task") {
          const task = yield* this.#storageCall(this.#host.storage.task(ownership.taskId))
          // New owned work needs a live owner (spec 5.5). This transaction cannot write tasks yet, so the stored record
          // is the owner's final state; once it can, this check moves to where the writes are assembled.
          const refusal =
            task === undefined
              ? "does not exist"
              : task.state.status === "completing" || task.state.status === "terminal"
                ? `is ${task.state.status}`
                : task.abortRequested
                  ? "is abort-marked"
                  : undefined
          if (task === undefined || refusal !== undefined) {
            return yield* Effect.die(new Error(`Conversation owner task ${ownership.taskId} ${refusal}`))
          }
          owner = { conversationId: task.conversationId, taskId: ownership.taskId }
        }
        const id = yield* this.#mint<ConversationId>()
        const record = freeze<ConversationRecord>(owner === undefined ? { id } : { id, owner })
        this.#createdConversations.add(id)
        this.#writes.push({ type: "conversation", value: record })
        return record
      }),
    )
  }

  appendEntry(conversationId: ConversationId, draft: EntryDraft): Effect.Effect<EntryRecord, StorageError>
  appendEntry<D extends JsonValue>(
    token: Entry<D>,
    conversationId: ConversationId,
    draft: TypedEntryDraft<NoInfer<D>>,
  ): Effect.Effect<TypedEntry<D>, StorageError>
  appendEntry(
    first: ConversationId | Entry<JsonValue>,
    second: ConversationId | EntryDraft,
    third?: object,
  ): Effect.Effect<EntryRecord, StorageError> {
    const conversationId = (typeof first === "number" ? first : second) as ConversationId
    const draft = (typeof first === "number" ? second : { ...third, kind: first.kind }) as EntryDraft
    return this.#tableWrite(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireConversation(conversationId)
        const id = yield* this.#mint<EntryId>()
        const { head, ...rest } = draft
        // An undefined `head` is left out by the copy.
        const record = freeze<EntryRecord>({ ...rest, id, conversationId, head: head === "self" ? id : head })
        this.#writes.push({ type: "entry", value: record })
        return record
      }),
    )
  }

  createSubmission(create: SubmissionCreate) {
    return this.#tableWrite(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireConversation(create.conversationId)
        const id = yield* this.#mint<SubmissionId>()
        const record = freeze<SubmissionRecord>({ ...create, id })
        this.#submissions.set(id, record)
        return record
      }),
    )
  }

  settleSubmission(id: SubmissionId, settlement: SubmissionSettlement) {
    return this.#stageChange(id, copyJson(settlement) as SubmissionSettlement)
  }

  placeSubmission(id: SubmissionId, entry: EntryId) {
    return this.#stageChange(id, { status: "placed", entry })
  }

  // The Session's side

  /** Ends the callback's access: every later call on this transaction is a defect. */
  seal(): void {
    this.#sealed = true
  }

  /** The commit's writes, with each staged submission change applied to its latest record. */
  writes(): Effect.Effect<readonly StorageWrite[], StorageError> {
    return Effect.gen({ self: this }, function* () {
      for (const { id, change } of this.#submissionChanges) {
        const current = this.#submissions.get(id) ?? (yield* this.#storageCall(this.#host.storage.submission(id)))
        if (current === undefined) return yield* Effect.die(new Error(`Submission ${id} does not exist`))
        this.#submissions.set(id, freeze(applySubmissionChange(current, change)))
      }
      const writes = [...this.#writes]
      for (const value of this.#submissions.values()) writes.push({ type: "submission", value })
      return writes
    })
  }

  // Helpers

  #tableRead<A, E>(name: string, read: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      this.#assertOpen()
      if (this.#hasTableWrite) return Effect.die(new ReadAfterWrite(`Tx.${name}`))
      return this.#storageCall(read)
    })
  }

  #tableWrite<A, E>(write: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      this.#assertOpen()
      this.#hasTableWrite = true
      return write
    })
  }

  #stageChange(id: SubmissionId, change: SubmissionChange): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#assertOpen()
      this.#hasTableWrite = true
      this.#submissionChanges.push({ id, change })
    })
  }

  /** A conversation this transaction appends to must exist, in storage or created by it. Not a caller table read. */
  #requireConversation(id: ConversationId): Effect.Effect<void, StorageError> {
    if (this.#createdConversations.has(id)) return Effect.void
    return Effect.flatMap(this.#storageCall(this.#host.storage.conversation(id)), (record) =>
      record === undefined ? Effect.die(new Error(`Conversation ${id} does not exist`)) : Effect.void,
    )
  }

  #mint<I extends Id<string>>(): Effect.Effect<I, StorageError> {
    return this.#storageCall(this.#host.storage.mintId<I>())
  }

  /** A storage call of this transaction: its `StorageError` fails the Session, and the call fails with it too. */
  #storageCall<A, E>(call: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.tapError(call, (error) =>
      Effect.sync(() => {
        if (error instanceof StorageError) this.#host.failed(error)
      }),
    )
  }

  #assertOpen(): void {
    if (this.#sealed) throw new Error("This transaction's commit callback has settled; use it only inside the callback")
  }
}
