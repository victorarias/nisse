// The transaction of one Session commit (spec sections 3.3 to 3.7 and 4): table reads, then table writes and document
// changes, staged into one batch.
// Derived from pi-durable's `src/session/transaction.ts` and `src/session/forks.ts` at 7d073328e (MIT, see LICENSE).
import { type Change, type Draft, type Op, type Prepared, type Tracker, track } from "@nisse/delta"
import { copyJson } from "@nisse/delta/json"
import { Deferred, Effect, Queue } from "effect"
import {
  type AnyDocDefinition,
  type AnyDocToken,
  addressId,
  checkRecordScope,
  checkRecordVersion,
  type ConversationDocFamilyToken,
  type ConversationDocToken,
  documentCreate,
  materializeDocumentValue,
  ownedObject,
  type ResolvedAddress,
  resolveAddress,
  type SessionDocFamilyToken,
  type SessionDocToken,
  type TaskDocFamilyToken,
  type TaskDocToken,
} from "../documents/definition.ts"
import { ReadAfterWrite, StorageError } from "../errors.ts"
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentCopySource,
  DocumentCreate,
  DocumentId,
  DocumentPoint,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  JsonObject,
  JsonValue,
  Page,
  Seq,
  StorageWrite,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from "../records.ts"
import type { ReadError, Storage } from "../storage.ts"
import type { LoadedDocument } from "./documents.ts"
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

/** A creation or update (`kind: "change"`), a retirement (`kind: "retire"`), or a definition-free fork copy. */
export type DocumentCommitChange =
  | {
      readonly type: "document"
      readonly kind: "change"
      readonly record: DocumentRecord
      readonly conversationId: ConversationId | undefined
      readonly version: number
      readonly value: JsonObject
      /** Empty for a creation. */
      readonly ops: readonly Op[]
    }
  | {
      readonly type: "document"
      readonly kind: "retire"
      readonly record: DocumentRecord
      readonly conversationId: ConversationId | undefined
    }
  | {
      readonly type: "document.copy"
      readonly record: DocumentRecord
      readonly conversationId: ConversationId
      readonly source: DocumentCopySource
    }

/** What a document access fails with: the storage read behind it. Misuse, such as a wrong token, is a defect. */
export type DocError = ReadError

/**
 * What a commit callback reads and writes. Table reads come first: a table read after the commit's first table write is
 * a `ReadAfterWrite` defect. Records it returns are frozen and shared with the commit's publication. Document access
 * (`doc`, `retireDoc`) is not a table read or write.
 *
 * A read's `StorageError` fails the Session (spec 10.1), so the commit fails even when the callback catches it. Every
 * operation must finish before the callback does: a commit whose callback returns with one still running fails.
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
  /**
   * Creates a conversation whose transcript is the parent's through the visible entry `at` (spec 3.7). Its conversation
   * documents follow their fork policy: `asOf` copies the value at `at`'s commit, `current` the committed value, and
   * `initial` copies nothing. Fails as a defect when this commit also writes one of the parent's `current` documents.
   */
  forkConversation(
    parentConversationId: ConversationId,
    at: EntryId,
    options: { readonly ownership: ConversationOwnership },
  ): Effect.Effect<ConversationRecord, ReadError>
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

  /**
   * The document at an address as a draft this commit changes, created from the token's initializer when absent and
   * migrated to the token's version when older (spec 3.3, 3.6). Later calls for the address in this commit return the
   * same draft; a family's first seed wins. The draft is revoked when the callback settles.
   */
  doc<T extends JsonObject>(token: SessionDocToken<T>): Effect.Effect<Draft<T>, DocError>
  doc<T extends JsonObject>(
    token: ConversationDocToken<T>,
    conversationId: ConversationId,
  ): Effect.Effect<Draft<T>, DocError>
  doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Effect.Effect<Draft<T>, DocError>
  doc<T extends JsonObject, I extends JsonValue>(
    token: SessionDocFamilyToken<T, I>,
    key: string,
    seed: I,
  ): Effect.Effect<Draft<T>, DocError>
  doc<T extends JsonObject, I extends JsonValue>(
    token: ConversationDocFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
    seed: I,
  ): Effect.Effect<Draft<T>, DocError>
  doc<T extends JsonObject, I extends JsonValue>(
    token: TaskDocFamilyToken<T, I>,
    taskId: TaskId,
    key: string,
    seed: I,
  ): Effect.Effect<Draft<T>, DocError>

  /**
   * Retires the document at an address, without creating it. An acquired draft's final content is stored before the
   * retirement; a later `doc()` at the address in this commit creates a new incarnation.
   */
  retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Effect.Effect<void, DocError>
  retireDoc<T extends JsonObject>(
    token: ConversationDocToken<T>,
    conversationId: ConversationId,
  ): Effect.Effect<void, DocError>
  retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Effect.Effect<void, DocError>
  retireDoc<T extends JsonObject, I extends JsonValue>(
    token: SessionDocFamilyToken<T, I>,
    key: string,
  ): Effect.Effect<void, DocError>
  retireDoc<T extends JsonObject, I extends JsonValue>(
    token: ConversationDocFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
  ): Effect.Effect<void, DocError>
  retireDoc<T extends JsonObject, I extends JsonValue>(
    token: TaskDocFamilyToken<T, I>,
    taskId: TaskId,
    key: string,
  ): Effect.Effect<void, DocError>
}

/** What a transaction needs from its Session. */
export type TransactionHost = {
  readonly storage: Storage
  /** Fails the Session with a storage error that a call of this transaction hit. */
  readonly failed: (error: StorageError) => void
  /** The cached incarnation at an address, noting the use. */
  readonly cached: (addressId: string) => LoadedDocument | undefined
  /** The current incarnation at an address, from the cache or loaded into it, for a token of the definition's version. */
  readonly load: (
    definition: AnyDocDefinition,
    addressId: string,
    address: DocumentAddress,
  ) => Effect.Effect<LoadedDocument | undefined, ReadError>
  readonly install: (document: LoadedDocument) => void
  readonly evict: (addressId: string, recordId: DocumentId) => void
}

type SubmissionChange = SubmissionSettlement | { readonly status: "placed"; readonly entry: EntryId }

const TABLE_COPY = { omitUndefinedProperties: true } as const
const SCAN_PAGE_SIZE = 256
const NO_OPS: readonly Op[] = []

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

/** Where one staged incarnation comes from. */
type DocumentTarget =
  | { readonly kind: "loaded"; readonly document: LoadedDocument }
  | {
      readonly kind: "created"
      readonly record: DocumentCreate
      readonly version: number
      readonly tracker: Tracker<JsonObject>
    }
  | { readonly kind: "fork-copy"; readonly record: DocumentCreate; readonly source: DocumentCopySource }
  | { readonly kind: "retire-only"; readonly record: DocumentRecord }

/** One incarnation this transaction acquired, created, copied or retired. */
type DocumentEntry = {
  readonly addressId: string
  readonly address: DocumentAddress
  /** Absent for a definition-free fork copy. */
  definition?: AnyDocDefinition
  /** The memoized acquisition; absent for a retirement-only entry. */
  draft?: Deferred.Deferred<Draft<JsonObject>, DocError>
  /** Set once acquisition or the retirement lookup found the incarnation. */
  target?: DocumentTarget
  change?: Change<JsonObject>
  prepared?: Prepared<JsonObject>
  retire: boolean
}

/** What one staged incarnation writes and publishes, decided before Storage so adoption only applies it. */
type DocumentPlan = {
  readonly addressId: string
  /** A `DocumentRecord` for a committed incarnation, a `DocumentCreate` for a new one. */
  readonly record: DocumentCreate | DocumentRecord
  retire: boolean
  /** Creation, copy or change content; absent when only a retirement is written. */
  content?: Extract<StorageWrite, { readonly type: "document.create" | "document.copy" | "document.change" }>
  /** A tracked incarnation's prepared change; absent for copies and retirement-only entries. */
  readonly change?: {
    readonly tracker: Tracker<JsonObject>
    readonly prepared: Prepared<JsonObject>
    readonly version: number
    /** The cached incarnation it updates; absent when it creates one. */
    readonly loaded?: LoadedDocument
    readonly definition?: AnyDocDefinition
  }
  /** The conversation a publication names, resolved before Storage. */
  conversationId?: ConversationId
}

const isCommitted = (record: DocumentCreate | DocumentRecord): record is DocumentRecord => "createdAt" in record

/** One commit's transaction. The Session settles it when the callback does, then takes its writes. */
export class Transaction implements Tx {
  readonly #host: TransactionHost
  #sealed = false
  #hasTableWrite = false
  /** Operations started and not settled, and the queue settlement waits on once sealed. */
  #pending = 0
  #drained: Queue.Queue<void> | undefined
  /** Conversation and entry writes, in staging order. */
  readonly #writes: StorageWrite[] = []
  readonly #createdConversations = new Set<ConversationId>()
  readonly #forkSourceConversations = new Set<ConversationId>()
  readonly #forkSourceDocuments = new Set<DocumentId>()
  /** Submissions this transaction created or changed, by ID, at their latest staged record. */
  readonly #submissions = new Map<SubmissionId, SubmissionRecord>()
  readonly #submissionChanges: { readonly id: SubmissionId; readonly change: SubmissionChange }[] = []
  /** Committed task records this transaction looked up, for task document checks. */
  readonly #tasks = new Map<TaskId, TaskRecord | undefined>()
  /** Every acquisition, copy and retirement, in staging order. */
  readonly #documents: DocumentEntry[] = []
  /** The latest entry at each address. */
  readonly #latest = new Map<string, DocumentEntry>()
  readonly #plans: DocumentPlan[] = []

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
    // Without a parent nothing is read but records, whose failures are storage errors.
    return this.#tableWrite(this.#stageConversation(undefined, options.ownership)) as Effect.Effect<
      ConversationRecord,
      StorageError
    >
  }

  forkConversation(
    parentConversationId: ConversationId,
    at: EntryId,
    options: { readonly ownership: ConversationOwnership },
  ) {
    return this.#tableWrite(this.#stageConversation({ conversationId: parentConversationId, at }, options.ownership))
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
        this.#assertOpen()
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
        this.#assertOpen()
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

  // Documents

  doc(token: AnyDocToken, ...args: readonly unknown[]): Effect.Effect<Draft<never>, DocError> {
    return this.#track(
      Effect.suspend(() => {
        this.#assertOpen()
        const definition = token.definition
        const resolved = resolveAddress(definition, args)
        const latest = this.#latest.get(resolved.id)
        if (latest !== undefined && !latest.retire) {
          if (latest.draft !== undefined) return Deferred.await(latest.draft)
          if (latest.target?.kind === "fork-copy") {
            const target = latest.target
            return this.#memoize(latest, this.#acquireForkCopy(latest, definition, target))
          }
        }
        const seed = definition.family === true ? copyJson(args[resolved.nextArgument]) : undefined
        const entry: DocumentEntry = { addressId: resolved.id, address: resolved.address, definition, retire: false }
        this.#documents.push(entry)
        this.#latest.set(entry.addressId, entry)
        // A retirement staged before means a new incarnation: the old one is not loaded again.
        return this.#memoize(entry, this.#acquire(entry, resolved, seed, latest?.retire === true))
      }),
    ) as Effect.Effect<Draft<never>, DocError>
  }

  retireDoc(token: AnyDocToken, ...args: readonly unknown[]): Effect.Effect<void, DocError> {
    return this.#track(
      Effect.suspend(() => {
        this.#assertOpen()
        const definition = token.definition
        const resolved = resolveAddress(definition, args)
        const latest = this.#latest.get(resolved.id)
        if (latest?.retire) return Effect.void
        if (latest?.target?.kind === "fork-copy") {
          checkRecordScope(definition, latest.target.record)
          latest.retire = true
          return Effect.void
        }
        if (latest?.draft !== undefined) {
          // The acquired draft's final content is stored before the retirement.
          latest.retire = true
          return Effect.asVoid(Deferred.await(latest.draft))
        }
        const entry: DocumentEntry = { addressId: resolved.id, address: resolved.address, definition, retire: true }
        this.#documents.push(entry)
        this.#latest.set(entry.addressId, entry)
        return this.#findRetirement(entry)
      }),
    )
  }

  // The Session's side

  /**
   * Ends the callback's access once it settled: every later call is a defect, and every open draft is revoked. Waits
   * for operations still running and tells whether there were any, in which case the commit fails.
   */
  settle(succeeded: boolean): Effect.Effect<{ readonly pending: boolean }> {
    return Effect.gen({ self: this }, function* () {
      this.#sealed = true
      const pending = this.#pending > 0
      if (!succeeded || pending) this.abort()
      if (pending) {
        const drained = yield* Queue.bounded<void>(1)
        this.#drained = drained
        if (this.#pending > 0) yield* Queue.take(drained)
      }
      return { pending }
    })
  }

  /**
   * The commit's writes, with each staged submission change applied to its latest record, every open draft prepared and
   * each document's representation chosen (spec 3.4, 3.5). A failure aborts every change.
   */
  writes(): Effect.Effect<readonly StorageWrite[], StorageError> {
    return Effect.gen({ self: this }, function* () {
      for (const document of this.#documents) {
        if (document.change !== undefined) document.prepared = document.change.prepare()
      }
      for (const { id, change } of this.#submissionChanges) {
        const current = this.#submissions.get(id) ?? (yield* this.#storageCall(this.#host.storage.submission(id)))
        if (current === undefined) return yield* Effect.die(new Error(`Submission ${id} does not exist`))
        this.#submissions.set(id, freeze(applySubmissionChange(current, change)))
      }
      const writes = [...this.#writes]
      for (const value of this.#submissions.values()) writes.push({ type: "submission", value })
      yield* this.#planDocuments()
      for (const plan of this.#plans) {
        if (plan.content !== undefined) writes.push(plan.content)
        if (plan.retire) writes.push({ type: "document.retire", id: plan.record.id })
      }
      return writes
    }).pipe(Effect.onError(() => Effect.sync(() => this.abort())))
  }

  /**
   * After Storage stored the commit at `seq`: adopts every prepared change by pointer swap, updates the cache, and
   * returns the document changes to publish.
   */
  adopt(seq: Seq): readonly DocumentCommitChange[] {
    const changes: DocumentCommitChange[] = []
    for (const plan of this.#plans) {
      let record: DocumentRecord = isCommitted(plan.record)
        ? plan.record
        : ({ ...plan.record, createdAt: seq } as DocumentRecord)
      if (plan.retire) record = { ...record, retiredAt: seq }
      const change = plan.change
      if (change !== undefined) {
        const { tracker, prepared, loaded, version } = change
        // A new incarnation is adopted unless it retires in the same commit; a loaded one only when it changed.
        if (loaded === undefined ? !plan.retire : prepared.ops.length > 0) tracker.adopt(prepared)
        else prepared.abort()
        if (loaded !== undefined) {
          if (loaded.storedVersion < version) loaded.storedVersion = version
          if (plan.content?.type === "document.change") {
            if (plan.content.content.kind === "base") loaded.deltasSinceBase = 0
            else loaded.deltasSinceBase++
          }
        } else if (!plan.retire) {
          this.#host.install({
            addressId: plan.addressId,
            record,
            storedVersion: version,
            valueVersion: version,
            deltasSinceBase: 0,
            tracker,
          })
        }
      }
      if (plan.retire && isCommitted(plan.record)) this.#host.evict(plan.addressId, record.id)
      const published = describe(plan, record)
      if (published !== undefined) changes.push(published)
    }
    return changes
  }

  /** Aborts every open or prepared change, revoking its draft: after a failure, or when nothing is stored. */
  abort(): void {
    for (const document of this.#documents) {
      document.change?.abort()
      document.prepared?.abort()
    }
  }

  // Staging

  #stageConversation(
    parent: NonNullable<ConversationRecord["parent"]> | undefined,
    ownership: ConversationOwnership,
  ): Effect.Effect<ConversationRecord, ReadError> {
    return Effect.gen({ self: this }, function* () {
      let owner: ConversationRecord["owner"]
      if (ownership.kind === "task") {
        const task = yield* this.#committedTask(ownership.taskId)
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
      const copies = parent === undefined ? [] : yield* this.#forkCopies(parent.conversationId, parent.at, id)
      this.#assertOpen()
      const record = freeze<ConversationRecord>({
        id,
        ...(parent === undefined ? {} : { parent }),
        ...(owner === undefined ? {} : { owner }),
      })
      for (const copy of copies) {
        this.#forkSourceDocuments.add(copy.source.id)
        const entry: DocumentEntry = {
          addressId: addressId(copy.record),
          address: copy.record,
          target: { kind: "fork-copy", ...copy },
          retire: false,
        }
        this.#documents.push(entry)
        this.#latest.set(entry.addressId, entry)
      }
      if (parent !== undefined) this.#forkSourceConversations.add(parent.conversationId)
      this.#createdConversations.add(id)
      this.#writes.push({ type: "conversation", value: record })
      return record
    })
  }

  /**
   * The documents a fork copies (spec 3.7): `asOf` ones from the conversation that owns `at`, at its commit, then
   * `current` ones from the parent, as committed. Each copy is a definition-free `document.copy` with a fresh ID.
   */
  #forkCopies(
    parentConversationId: ConversationId,
    at: EntryId,
    childConversationId: ConversationId,
  ): Effect.Effect<{ readonly record: DocumentCreate; readonly source: DocumentCopySource }[], ReadError> {
    return Effect.gen({ self: this }, function* () {
      const stored = yield* this.#storageCall(this.#host.storage.entry(parentConversationId, at))
      if (stored === undefined) {
        return yield* Effect.die(new Error(`Entry ${at} is not visible from conversation ${parentConversationId}`))
      }
      const copies: { readonly record: DocumentCreate; readonly source: DocumentCopySource }[] = []
      const addresses = new Set<string>()
      const collect = (
        conversationId: ConversationId,
        point: DocumentPoint,
        policy: "asOf" | "current",
      ): Effect.Effect<void, ReadError> =>
        Effect.gen({ self: this }, function* () {
          let cursor: Cursor | undefined
          do {
            const page = yield* this.#storageCall(
              this.#host.storage.scanDocuments(
                { scope: { kind: "conversation", conversationId }, at: point },
                SCAN_PAGE_SIZE,
                cursor,
              ),
            )
            for (const source of page.items) {
              if (source.scope.kind !== "conversation" || source.fork !== policy) continue
              const id = yield* this.#mint<DocumentId>()
              const record = {
                id,
                kind: source.kind,
                ...(source.key === undefined ? {} : { key: source.key }),
                scope: { kind: "conversation", conversationId: childConversationId },
                history: source.history,
                fork: source.fork,
              } as DocumentCreate
              const copied = addressId(record)
              if (addresses.has(copied)) {
                const member = record.key === undefined ? record.kind : `${record.kind}/${record.key}`
                return yield* Effect.die(new Error(`Fork selects multiple source documents for ${member}`))
              }
              addresses.add(copied)
              copies.push({ record, source: { id: source.id, at: point } })
            }
            cursor = page.next
          } while (cursor !== undefined)
        })
      yield* collect(stored.entry.conversationId, stored.commitSeq, "asOf")
      yield* collect(parentConversationId, "current", "current")
      return copies
    })
  }

  #acquire(
    entry: DocumentEntry,
    resolved: ResolvedAddress,
    seed: JsonValue | undefined,
    skipLoad: boolean,
  ): Effect.Effect<Draft<JsonObject>, DocError> {
    return Effect.gen({ self: this }, function* () {
      const definition = entry.definition!
      const scope = resolved.address.scope
      if (scope.kind === "task") yield* this.#requireOpenTask(scope.taskId)
      const loaded = skipLoad ? undefined : yield* this.#host.load(definition, entry.addressId, entry.address)
      this.#assertOpen()
      if (loaded !== undefined) {
        checkRecordScope(definition, loaded.record)
        checkRecordVersion(definition, loaded.record, loaded.storedVersion)
        entry.target = { kind: "loaded", document: loaded }
        entry.change = loaded.tracker.beginChange()
        return entry.change.state
      }
      if (scope.kind === "conversation") yield* this.#requireConversation(scope.conversationId)
      this.#assertOpen()
      const value = ownedObject(
        definition.family === true ? definition.initial(seed) : definition.initial(),
        `Document ${definition.kind} initial()`,
      )
      const id = yield* this.#mint<DocumentId>()
      this.#assertOpen()
      const tracker = track(value)
      entry.target = {
        kind: "created",
        record: documentCreate(definition, entry.address, id),
        version: definition.version,
        tracker,
      }
      entry.change = tracker.beginChange()
      return entry.change.state
    })
  }

  /** Typed access to an uncommitted fork copy: its source's stored value, migrated, becomes an ordinary creation. */
  #acquireForkCopy(
    entry: DocumentEntry,
    definition: AnyDocDefinition,
    target: Extract<DocumentTarget, { readonly kind: "fork-copy" }>,
  ): Effect.Effect<Draft<JsonObject>, DocError> {
    return Effect.gen({ self: this }, function* () {
      const stored = yield* this.#storageCall(this.#host.storage.document(target.source.id, target.source.at))
      this.#assertOpen()
      if (stored === undefined)
        return yield* Effect.die(new Error(`Fork source document ${target.source.id} cannot be read`))
      const record = stored.record
      if (
        record.scope.kind !== "conversation" ||
        record.kind !== target.record.kind ||
        record.key !== target.record.key ||
        record.history !== target.record.history ||
        record.fork !== target.record.fork
      ) {
        return yield* Effect.die(new Error(`Fork source document ${target.source.id} does not match the copied record`))
      }
      const value = materializeDocumentValue(definition, target.record, stored.version, stored.value)
      const tracker = track(value)
      entry.definition = definition
      entry.target = { kind: "created", record: target.record, version: definition.version, tracker }
      entry.change = tracker.beginChange()
      return entry.change.state
    })
  }

  #findRetirement(entry: DocumentEntry): Effect.Effect<void, DocError> {
    return Effect.gen({ self: this }, function* () {
      const record =
        this.#host.cached(entry.addressId)?.record ??
        (yield* this.#storageCall(this.#host.storage.findDocument(entry.address, "current")))
      this.#assertOpen()
      if (record === undefined) return
      checkRecordScope(entry.definition!, record)
      entry.target = { kind: "retire-only", record }
    })
  }

  /** The first acquisition at an address runs `acquire`; later ones wait for the same draft. */
  #memoize(entry: DocumentEntry, acquire: Effect.Effect<Draft<JsonObject>, DocError>) {
    const draft = Deferred.makeUnsafe<Draft<JsonObject>, DocError>()
    entry.draft = draft
    return acquire.pipe(Effect.onExit((exit) => Deferred.done(draft, exit)))
  }

  /** Plans every staged incarnation and checks what must hold before Storage (spec 3.4, 3.5, 3.7). */
  #planDocuments(): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const plans = this.#plans
      for (const document of this.#documents) {
        const plan = planDocument(document)
        if (plan !== undefined) plans.push(plan)
      }
      this.#rejectForkSourceWrites(plans)
      for (const plan of plans) {
        if (!publishes(plan)) continue
        const scope = plan.record.scope
        if (scope.kind === "conversation") plan.conversationId = scope.conversationId
        if (scope.kind === "task") {
          const task = yield* this.#committedTask(scope.taskId)
          if (task !== undefined) plan.conversationId = task.conversationId
        }
      }
      // Checkpoint predicates run last, after every validation, once each.
      for (const plan of plans) {
        const change = plan.change
        if (
          plan.content?.type !== "document.change" ||
          plan.content.content.kind !== "delta" ||
          change?.loaded === undefined
        ) {
          continue
        }
        const { prepared, version } = change
        if (
          change.definition!.checkpointWhen(prepared.value, prepared.ops, {
            deltasSinceBase: change.loaded.deltasSinceBase,
          })
        ) {
          plan.content = { ...plan.content, content: { version, kind: "base", value: prepared.value } }
        }
      }
    })
  }

  #rejectForkSourceWrites(plans: readonly DocumentPlan[]): void {
    for (const plan of plans) {
      if (plan.content === undefined && !plan.retire) continue
      const record = plan.record
      if (this.#forkSourceDocuments.has(record.id)) {
        throw new Error(`Cannot change fork source document ${record.id} in the fork transaction`)
      }
      if (
        record.scope.kind === "conversation" &&
        this.#forkSourceConversations.has(record.scope.conversationId) &&
        record.fork === "current"
      ) {
        throw new Error(
          `Cannot fork conversation ${record.scope.conversationId} while changing its current-policy documents`,
        )
      }
    }
  }

  // Helpers

  #tableRead<A, E>(name: string, read: Effect.Effect<A, E>): Effect.Effect<A, E | StorageError> {
    return this.#track(
      Effect.suspend(() => {
        this.#assertOpen()
        if (this.#hasTableWrite) return Effect.die(new ReadAfterWrite(`Tx.${name}`))
        return this.#storageCall(read)
      }),
    )
  }

  #tableWrite<A, E>(write: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return this.#track(
      Effect.suspend(() => {
        this.#assertOpen()
        this.#hasTableWrite = true
        return write
      }),
    )
  }

  #stageChange(id: SubmissionId, change: SubmissionChange): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#assertOpen()
      this.#hasTableWrite = true
      this.#submissionChanges.push({ id, change })
    })
  }

  /** Counts an operation while it runs, so settlement can tell the callback returned before it. */
  #track<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      this.#pending++
      return Effect.ensuring(
        operation,
        Effect.suspend(() => {
          this.#pending--
          return this.#pending === 0 && this.#drained !== undefined
            ? Queue.offer(this.#drained, undefined)
            : Effect.void
        }),
      )
    })
  }

  /** A conversation this transaction appends to must exist, in storage or created by it. Not a caller table read. */
  #requireConversation(id: ConversationId): Effect.Effect<void, StorageError> {
    if (this.#createdConversations.has(id)) return Effect.void
    return Effect.flatMap(this.#storageCall(this.#host.storage.conversation(id)), (record) =>
      record === undefined ? Effect.die(new Error(`Conversation ${id} does not exist`)) : Effect.void,
    )
  }

  /** A task document needs a task that exists and is not terminal. Not a caller table read. */
  #requireOpenTask(id: TaskId): Effect.Effect<void, StorageError> {
    return Effect.flatMap(this.#committedTask(id), (task) => {
      if (task === undefined) return Effect.die(new Error(`Task ${id} does not exist`))
      if (task.state.status === "terminal") return Effect.die(new Error(`Task ${id} is terminal`))
      return Effect.void
    })
  }

  #committedTask(id: TaskId): Effect.Effect<TaskRecord | undefined, StorageError> {
    if (this.#tasks.has(id)) return Effect.succeed(this.#tasks.get(id))
    return Effect.tap(this.#storageCall(this.#host.storage.task(id)), (task) =>
      Effect.sync(() => this.#tasks.set(id, task)),
    )
  }

  #mint<I extends Id<string>>(): Effect.Effect<I, StorageError> {
    return this.#storageCall(this.#host.storage.mintId<I>())
  }

  /**
   * A storage call of this transaction: its `StorageError` fails the Session, and the call fails with it too. A defect,
   * such as a stored record that does not parse, leaves the outcome unknown, so it is a `StorageError` as well.
   */
  #storageCall<A, E>(call: Effect.Effect<A, E>): Effect.Effect<A, E | StorageError> {
    return call.pipe(
      Effect.catchDefect((defect) => Effect.fail(StorageError.of(defect))),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error instanceof StorageError) this.#host.failed(error)
        }),
      ),
    )
  }

  #assertOpen(): void {
    if (this.#sealed) throw new Error("Transaction has settled: use it only inside its commit callback")
  }
}

function planDocument(document: DocumentEntry): DocumentPlan | undefined {
  const target = document.target
  if (target === undefined) return undefined
  const plan = { addressId: document.addressId, retire: document.retire }
  switch (target.kind) {
    case "created": {
      const prepared = document.prepared!
      const { record, version, tracker } = target
      return {
        ...plan,
        record,
        content: { type: "document.create", record, content: { version, kind: "base", value: prepared.value } },
        change: { tracker, prepared, version },
      }
    }
    case "fork-copy":
      return {
        ...plan,
        record: target.record,
        content: { type: "document.copy", record: target.record, source: target.source },
      }
    case "retire-only":
      return { ...plan, record: target.record }
    case "loaded": {
      const loaded = target.document
      const definition = document.definition!
      const prepared = document.prepared!
      const version = definition.version
      const id = loaded.record.id
      // A version change stores a base even without operations; otherwise only a change stores a delta.
      const content =
        loaded.storedVersion < version
          ? ({ type: "document.change", id, content: { version, kind: "base", value: prepared.value } } as const)
          : prepared.ops.length > 0
            ? ({ type: "document.change", id, content: { version, kind: "delta", ops: prepared.ops } } as const)
            : undefined
      const change = { tracker: loaded.tracker, prepared, version, loaded, definition }
      return { ...plan, record: loaded.record, change, ...(content === undefined ? {} : { content }) }
    }
  }
}

/**
 * Whether adoption publishes the plan: every creation, copy and retirement, and a loaded incarnation that writes
 * content, which includes a migration-only base so observers of the older shape get the new value.
 */
function publishes(plan: DocumentPlan): boolean {
  return plan.retire || plan.change?.loaded === undefined || plan.content !== undefined
}

/** The publication of one adopted plan, with `record` as committed. */
function describe(plan: DocumentPlan, record: DocumentRecord): DocumentCommitChange | undefined {
  const conversationId = plan.conversationId
  if (plan.retire) return { type: "document", kind: "retire", record, conversationId }
  if (plan.content?.type === "document.copy") {
    return { type: "document.copy", record, conversationId: conversationId!, source: plan.content.source }
  }
  const change = plan.change
  if (change === undefined || !publishes(plan)) return undefined
  const ops = change.loaded === undefined ? NO_OPS : change.prepared.ops
  return {
    type: "document",
    kind: "change",
    record,
    conversationId,
    version: change.version,
    value: change.prepared.value,
    ops,
  }
}
