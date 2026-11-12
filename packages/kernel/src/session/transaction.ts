// The transaction of one Session commit (spec sections 3.3 to 3.7 and 4): table reads, then table writes and document
// changes, staged into one batch.
// Derived from pi-durable's `src/session/transaction.ts` and `src/session/forks.ts` at 7d073328e (MIT, see LICENSE).
import { type Change, type Draft, type Op, type Prepared, type Tracker, track } from "@nisse/delta"
import { copyJson } from "@nisse/delta/json"
import { Cause, Deferred, Effect, Queue, type Tracer } from "effect"
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
import { ROOT_CONVERSATION_ID } from "../records.ts"
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
  TelemetryCarrier,
} from "../records.ts"
import type { ReadError, Storage } from "../storage.ts"
import type { Task, TaskOptions } from "../tasks/task.ts"
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
 *
 * A call refuses misuse it can see up front, such as `ReadAfterWrite` or a terminal task's document, before it touches
 * the transaction; a callback may catch that defect and commit. A call that dies or is interrupted after that point
 * fails the commit with its defect, even when the callback caught it, and nothing is stored.
 */
export interface Tx {
  /**
   * Whether this commit staged a table write: an entry, conversation, submission or task. Table reads must come before
   * the first one (`ReadAfterWrite`), so code that reads tables inside a caller's commit checks it up front.
   */
  readonly hasTableWrite: boolean
  /** The span of the commit's caller, which the callback runs for on the Session line; `undefined` without one. */
  readonly span: Tracer.AnySpan | undefined
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
  /** Creates the ownerless root with the reserved ID `ROOT_CONVERSATION_ID`; a defect when it exists already. */
  createRootConversation(): Effect.Effect<ConversationRecord, StorageError>
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
   * Creates a `pending` task at the definition's initial checkpoint (spec 5.1, 5.5). A child task lives in its owner's
   * conversation and is never background; the owner must be live, not `completing` or abort-marked, in this commit's
   * final records. Only the scheduler runs it, with the services its handlers need.
   */
  createTask<I, S extends { readonly phase: string }, R, Svc>(
    task: Task<I, S, R, Svc>,
    input: I,
    options: TaskOptions,
  ): Effect.Effect<TaskId<R>, StorageError>

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

/** Defaults a commit binds to: the conversation `createTask()` uses, and the task its appended entries name. */
export type CommitScope = { readonly conversationId?: ConversationId; readonly taskId?: TaskId }

/** What a transaction needs from its Session. */
export type TransactionHost = {
  readonly storage: Storage
  /** The clock task lifecycle times are stamped with. */
  readonly now: () => number
  readonly scope: CommitScope
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
  readonly retire: (addressId: string, recordId: DocumentId) => void
  /** The Session's creation hook, run inside every call that creates or forks a conversation, before it returns. */
  readonly conversationCreated?: (tx: Tx, record: ConversationRecord) => Effect.Effect<void, unknown>
  /** The carrier of the span the commit was made in, which tasks it creates inherit; `undefined` without one. */
  readonly trace: () => TelemetryCarrier | undefined
  /** The span the commit was made in. */
  readonly span: Tracer.AnySpan | undefined
}

/** A new task's `trace` and `links`: given, inherited from the commit's span when omitted, or none for `"root"`. */
function traceOf(
  options: TaskOptions,
  inherited: () => TelemetryCarrier | undefined,
): { readonly trace?: TelemetryCarrier; readonly links?: readonly TelemetryCarrier[] } {
  const trace = options.trace === "root" ? undefined : (options.trace ?? inherited())
  return {
    ...(trace === undefined ? {} : { trace }),
    ...(options.links === undefined || options.links.length === 0 ? {} : { links: options.links }),
  }
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

/** One task a transaction touched: its committed record once read, and the candidate it writes. */
type TransactionTask = {
  committed?: { readonly record: TaskRecord | undefined }
  write?: { readonly kind: "create" | "replace"; readonly record: TaskRecord }
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

/**
 * A second access at an address in one transaction must use the definition the incarnation was acquired with: another
 * version or lifetime would read or write the draft in a shape its stored version does not have.
 */
function sameDefinition(entry: DocumentEntry, definition: AnyDocDefinition): Effect.Effect<void> {
  const acquired = entry.definition
  if (acquired === undefined || acquired === definition) return Effect.void
  const semantics = (d: AnyDocDefinition) =>
    JSON.stringify([
      d.kind,
      d.version,
      d.scope,
      "history" in d ? d.history : null,
      "fork" in d ? d.fork : null,
      d.family === true,
    ])
  if (semantics(acquired) === semantics(definition)) return Effect.void
  return Effect.die(
    new Error(
      `Document ${definition.kind} is accessed in one transaction through two definitions: version ${acquired.version} and version ${definition.version}, or another scope, history or fork`,
    ),
  )
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
  change?: {
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

  get hasTableWrite(): boolean {
    return this.#hasTableWrite
  }

  /** Whether `tx` is a transaction over `storage`; a proxy or another object is not. */
  static over(tx: unknown, storage: Storage): boolean {
    return typeof tx === "object" && tx !== null && #host in tx && (tx as Transaction).#host.storage === storage
  }
  /** Operations started and not settled, and the queue settlement waits on once sealed. */
  #pending = 0
  #drained: Queue.Queue<void> | undefined
  /** Why the commit must fail: the first call that died or was interrupted after its checks. */
  #poison: { readonly defect: unknown } | undefined
  /** Conversation and entry writes, in staging order. */
  readonly #writes: StorageWrite[] = []
  readonly #createdConversations = new Set<ConversationId>()
  readonly #forkSourceConversations = new Set<ConversationId>()
  readonly #forkSourceDocuments = new Set<DocumentId>()
  /** Submissions this transaction created or changed, by ID, at their latest staged record. */
  readonly #submissions = new Map<SubmissionId, SubmissionRecord>()
  readonly #submissionChanges: { readonly id: SubmissionId; readonly change: SubmissionChange }[] = []
  /** Each task this transaction looked up, created or replaced: its committed record once read, and its candidate. */
  readonly #tasks = new Map<TaskId, TransactionTask>()
  /** Every acquisition, copy and retirement, in staging order. */
  readonly #documents: DocumentEntry[] = []
  /** The latest entry at each address. */
  readonly #latest = new Map<string, DocumentEntry>()
  readonly #plans: DocumentPlan[] = []

  constructor(host: TransactionHost) {
    this.#host = host
  }

  get span(): Tracer.AnySpan | undefined {
    return this.#host.span
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
    return this.#created(this.#tableWrite(this.#stageConversation(undefined, options.ownership))) as Effect.Effect<
      ConversationRecord,
      StorageError
    >
  }

  createRootConversation() {
    return this.#created(
      this.#tableWrite(this.#stageConversation(undefined, { kind: "ownerless" }, ROOT_CONVERSATION_ID)),
    ) as Effect.Effect<ConversationRecord, StorageError>
  }

  forkConversation(
    parentConversationId: ConversationId,
    at: EntryId,
    options: { readonly ownership: ConversationOwnership },
  ) {
    return this.#created(
      this.#tableWrite(this.#stageConversation({ conversationId: parentConversationId, at }, options.ownership)),
    )
  }

  /** Runs the creation hook on a staged conversation; a hook failure fails the commit (spec 7.1). */
  #created<E>(staged: Effect.Effect<ConversationRecord, E>): Effect.Effect<ConversationRecord, E> {
    const hook = this.#host.conversationCreated
    if (hook === undefined) return staged
    // A Tx call of its own: counted while it runs, and a hook that dies poisons the commit.
    return Effect.tap(staged, (record) =>
      this.#call(
        () => {},
        () => Effect.orDie(hook(this, record)),
      ),
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
        this.#assertOpen()
        const { head, ...rest } = draft
        // An undefined `head` is left out by the copy.
        const record = freeze<EntryRecord>({
          ...rest,
          id,
          conversationId,
          head: head === "self" ? id : head,
          byTaskId: this.#host.scope.taskId,
        })
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

  createTask<I, S extends { readonly phase: string }, R, Svc>(
    task: Task<I, S, R, Svc>,
    input: I,
    options: TaskOptions,
  ): Effect.Effect<TaskId<R>, StorageError> {
    return this.#tableWrite(
      Effect.gen({ self: this }, function* () {
        const ownership = options.ownership
        let owner: TaskRecord | undefined
        if (ownership.kind === "task") {
          // Its liveness is checked on the owner's final candidate when the writes are assembled.
          owner = yield* this.currentTask(ownership.taskId)
          this.#assertOpen()
          if (owner === undefined) return yield* Effect.die(new Error(`Task owner ${ownership.taskId} does not exist`))
          if (options.background === true) return yield* Effect.die(new TypeError("A child task cannot be background"))
          if (options.conversationId !== undefined && options.conversationId !== owner.conversationId) {
            return yield* Effect.die(
              new Error(`A child task lives in its owner's conversation ${owner.conversationId}`),
            )
          }
        }
        const conversationId = owner?.conversationId ?? options.conversationId ?? this.#host.scope.conversationId
        if (conversationId === undefined) {
          return yield* Effect.die(new TypeError("Tx.createTask() requires options.conversationId"))
        }
        yield* this.#requireConversation(conversationId)
        this.#assertOpen()
        const traced = options.traceFrom === undefined ? options : yield* this.#traceFrom(options, options.traceFrom)
        const definition = task.definition
        const checkpoint = definition.initial(input)
        const id = yield* this.#mint<TaskId<R>>()
        this.#assertOpen()
        const record = freeze<TaskRecord>({
          id,
          conversationId,
          kind: definition.name,
          version: definition.version,
          input,
          ...(owner === undefined ? {} : { owner: owner.id }),
          background: options.background ?? false,
          abortRequested: false,
          ...(options.abandonOnRestart === true ? { abandonOnRestart: true } : {}),
          state: { status: "pending", checkpoint },
          ...traceOf(traced, this.#host.trace),
        })
        this.#taskEntry(id).write = { kind: "create", record }
        return id
      }),
    )
  }

  /** `options` with the trace of the first submission of `ids` and links to the others', staged ones first. */
  #traceFrom(options: TaskOptions, ids: readonly SubmissionId[]): Effect.Effect<TaskOptions, StorageError> {
    return Effect.gen({ self: this }, function* () {
      let trace: TelemetryCarrier | "root" = "root"
      const links: TelemetryCarrier[] = []
      for (const [index, id] of ids.entries()) {
        const record = this.#submissions.get(id) ?? (yield* this.#storageCall(this.#host.storage.submission(id)))
        if (index === 0) trace = record?.trace ?? "root"
        else if (record?.trace !== undefined) links.push(record.trace)
      }
      return { ...options, trace, links }
    })
  }

  // The scheduler's side

  /**
   * Replaces one task record completely, as the commit's candidate. Tasks change their own state through their runtime;
   * only the scheduler calls this. Lifecycle times are stamped here: `startedAt` at the first `running`, `endedAt` at
   * `terminal`, each kept once set. A first table write; misuse throws.
   */
  setTask(value: TaskRecord): void {
    this.#assertOpen()
    this.#hasTableWrite = true
    const task = this.#taskEntry(value.id)
    const candidate = task.write?.record
    if (candidate?.state.status === "terminal") throw new Error(`Task ${value.id} already has a terminal candidate`)
    if (candidate !== undefined && candidate.conversationId !== value.conversationId) {
      throw new Error(`Task ${value.id} cannot change conversations`)
    }
    task.write = {
      kind: task.write?.kind === "create" ? "create" : "replace",
      record: freeze<TaskRecord>(this.#stampTimes(value, candidate)),
    }
  }

  /** The task's candidate in this commit, else its committed record. Not a caller table read. */
  currentTask(id: TaskId): Effect.Effect<TaskRecord | undefined, StorageError> {
    const candidate = this.#tasks.get(id)?.write?.record
    return candidate !== undefined ? Effect.succeed(candidate) : this.#committedTask(id)
  }

  /** The task's candidate in this commit, if it created or replaced it. */
  stagedTask(id: TaskId): TaskRecord | undefined {
    return this.#tasks.get(id)?.write?.record
  }

  /** The candidates of the tasks this commit created or replaced so far. */
  stagedTasks(): readonly TaskRecord[] {
    const records: TaskRecord[] = []
    for (const task of this.#tasks.values()) if (task.write !== undefined) records.push(task.write.record)
    return records
  }

  /** Whether this commit creates the task. */
  createsTask(id: TaskId): boolean {
    return this.#tasks.get(id)?.write?.kind === "create"
  }

  /** The conversations this commit created or forked so far. */
  stagedConversations(): readonly ConversationRecord[] {
    const records: ConversationRecord[] = []
    for (const write of this.#writes) if (write.type === "conversation") records.push(write.value)
    return records
  }

  // Documents

  doc(token: AnyDocToken, ...args: readonly unknown[]): Effect.Effect<Draft<never>, DocError> {
    return this.#documentCall(
      () => {
        const definition = token.definition
        const resolved = resolveAddress(definition, args)
        const scope = resolved.address.scope
        // Settlement retires a terminal task's documents, so none is handed out after its terminal candidate.
        if (scope.kind === "task" && this.#tasks.get(scope.taskId)?.write?.record.state.status === "terminal") {
          throw new Error(`Task ${scope.taskId} is terminal`)
        }
        return { definition, resolved }
      },
      ({ definition, resolved }) => {
        const latest = this.#latest.get(resolved.id)
        if (latest !== undefined && !latest.retire) {
          if (latest.draft !== undefined) {
            const draft = latest.draft
            return Effect.flatMap(Deferred.await(draft), (acquired) =>
              Effect.as(sameDefinition(latest, definition), acquired),
            )
          }
          if (latest.target?.kind === "fork-copy") {
            return this.#memoize(latest, this.#acquireForkCopy(latest, definition, latest.target))
          }
        }
        const seed = definition.family === true ? copyJson(args[resolved.nextArgument]) : undefined
        const entry: DocumentEntry = { addressId: resolved.id, address: resolved.address, definition, retire: false }
        this.#stage(entry)
        // A retirement staged before means a new incarnation: the old one is not loaded again.
        return this.#memoize(entry, this.#acquire(entry, resolved, seed, latest?.retire === true))
      },
    ) as Effect.Effect<Draft<never>, DocError>
  }

  retireDoc(token: AnyDocToken, ...args: readonly unknown[]): Effect.Effect<void, DocError> {
    return this.#documentCall(
      () => ({ definition: token.definition, resolved: resolveAddress(token.definition, args) }),
      ({ definition, resolved }) => {
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
          return Effect.flatMap(Deferred.await(latest.draft), () => sameDefinition(latest, definition))
        }
        const entry: DocumentEntry = { addressId: resolved.id, address: resolved.address, definition, retire: true }
        this.#stage(entry)
        return this.#findRetirement(entry)
      },
    )
  }

  // The Session's side

  /** The defect the commit fails with, when a call died or was interrupted after its checks. */
  get poison(): { readonly defect: unknown } | undefined {
    return this.#poison
  }

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
      yield* this.#validateTasks()
      const writes = [...this.#writes]
      for (const value of this.#submissions.values()) writes.push({ type: "submission", value })
      for (const task of this.#tasks.values())
        if (task.write !== undefined) writes.push({ type: "task", value: task.write.record })
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
      if (plan.retire && isCommitted(plan.record)) {
        this.#host.retire(plan.addressId, record.id)
        // The incarnation ended: a stale reference to its tracker, such as a finished generator's, keeps no value.
        plan.change?.tracker.release()
      }
      const published = describe(plan, record)
      if (published !== undefined) changes.push(published)
    }
    this.#release()
    return changes
  }

  /** Aborts every open or prepared change, revoking its draft: after a failure, or when nothing is stored. */
  abort(): void {
    for (const document of this.#documents) {
      document.change?.abort()
      document.prepared?.abort()
    }
    this.#release()
  }

  /**
   * Drops the staged documents once the commit is adopted or aborted: the cache and observers own what lives on, and a
   * stale reference to a finished transaction holds no document value.
   */
  #release(): void {
    // Closures and generators of this commit may still reference an entry or a plan (JavaScriptCore scans stacks
    // conservatively), so each drops what reaches a document value, not only the lists that hold them.
    for (const document of this.#documents) {
      delete document.draft
      delete document.target
      delete document.change
      delete document.prepared
    }
    for (const plan of this.#plans) {
      delete plan.change
      delete plan.content
    }
    this.#documents.length = 0
    this.#plans.length = 0
    this.#latest.clear()
  }

  // Staging

  #stageConversation(
    parent: NonNullable<ConversationRecord["parent"]> | undefined,
    ownership: ConversationOwnership,
    reservedId?: ConversationId,
  ): Effect.Effect<ConversationRecord, ReadError> {
    return Effect.gen({ self: this }, function* () {
      let owner: ConversationRecord["owner"]
      if (ownership.kind === "task") {
        // Its liveness is checked on the owner's final candidate when the writes are assembled (spec 5.5).
        const task = yield* this.currentTask(ownership.taskId)
        if (task === undefined) {
          return yield* Effect.die(new Error(`Conversation owner task ${ownership.taskId} does not exist`))
        }
        owner = { conversationId: task.conversationId, taskId: ownership.taskId }
      }
      const id = reservedId ?? (yield* this.#mint<ConversationId>())
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

  /** Stages `entry` as the address's newest. */
  #stage(entry: DocumentEntry): void {
    this.#documents.push(entry)
    this.#latest.set(entry.addressId, entry)
  }

  /**
   * The first acquisition at an address runs `acquire`; later ones wait for the same draft. One that does not succeed
   * fails the commit (a storage error fails the Session, anything else poisons the transaction), so it stays staged.
   */
  #memoize(entry: DocumentEntry, acquire: Effect.Effect<Draft<JsonObject>, DocError>) {
    const draft = Deferred.makeUnsafe<Draft<JsonObject>, DocError>()
    entry.draft = draft
    return Effect.onExit(acquire, (exit) => Deferred.done(draft, exit))
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
      yield* this.#retireTaskDocuments(plans)
      for (const plan of plans) {
        if (!publishes(plan)) continue
        const scope = plan.record.scope
        if (scope.kind === "conversation") plan.conversationId = scope.conversationId
        if (scope.kind === "task") {
          const task = yield* this.currentTask(scope.taskId)
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
    return this.#call(
      () => {
        if (this.#hasTableWrite) throw new ReadAfterWrite(`Tx.${name}`)
      },
      () => this.#storageCall(read),
    )
  }

  #tableWrite<A, E>(write: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return this.#call(
      () => {},
      () => {
        this.#hasTableWrite = true
        return write
      },
    )
  }

  #stageChange(id: SubmissionId, change: SubmissionChange): Effect.Effect<void> {
    return this.#call(
      () => {},
      () =>
        Effect.sync(() => {
          this.#hasTableWrite = true
          this.#submissionChanges.push({ id, change })
        }),
    )
  }

  /**
   * A document call. Its own storage reads are well formed, so a refused request is a defect; the only failure left is
   * a `StorageError`, which fails the Session.
   */
  #documentCall<C, A>(check: () => C, stage: (checked: C) => Effect.Effect<A, DocError>): Effect.Effect<A, DocError> {
    return this.#call(check, (checked) =>
      Effect.catchTag(stage(checked), "StorageRequestError", (error) => Effect.die(error)),
    )
  }

  /**
   * Every Tx call: `check` refuses misuse before the call touches the transaction, and a defect it throws fails only the
   * call. Then `stage` runs, counted while it runs so settlement can tell the callback returned before it. A `stage`
   * that dies or is interrupted may leave the transaction partly changed, so it poisons the commit.
   */
  #call<C, A, E>(check: () => C, stage: (checked: C) => Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      this.#assertOpen()
      const checked = check()
      this.#pending++
      return Effect.suspend(() => stage(checked)).pipe(
        Effect.onError((cause) =>
          Effect.sync(() => {
            if (this.#poison !== undefined || !(Cause.hasDies(cause) || Cause.hasInterrupts(cause))) return
            const died = cause.reasons.find((reason) => reason._tag === "Die")
            this.#poison = { defect: died?._tag === "Die" ? died.defect : new Error("A Tx call was interrupted") }
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            this.#pending--
            return this.#pending === 0 && this.#drained !== undefined
              ? Queue.offer(this.#drained, undefined)
              : Effect.void
          }),
        ),
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

  /** A task document needs a task that exists and is not terminal in this commit. Not a caller table read. */
  #requireOpenTask(id: TaskId): Effect.Effect<void, StorageError> {
    return Effect.flatMap(this.currentTask(id), (task) => {
      if (task === undefined) return Effect.die(new Error(`Task ${id} does not exist`))
      if (task.state.status === "terminal") return Effect.die(new Error(`Task ${id} is terminal`))
      return Effect.void
    })
  }

  #committedTask(id: TaskId): Effect.Effect<TaskRecord | undefined, StorageError> {
    const known = this.#tasks.get(id)?.committed
    if (known !== undefined) return Effect.succeed(known.record)
    return Effect.tap(this.#storageCall(this.#host.storage.task(id)), (record) =>
      Effect.sync(() => {
        this.#taskEntry(id).committed = { record }
      }),
    )
  }

  #taskEntry(id: TaskId): TransactionTask {
    let task = this.#tasks.get(id)
    if (task === undefined) {
      task = {}
      this.#tasks.set(id, task)
    }
    return task
  }

  /** Lifecycle times (spec 5.3): each is stamped once, by the Session clock, and carried over from then on. */
  #stampTimes(value: TaskRecord, candidate: TaskRecord | undefined): TaskRecord {
    const status = value.state.status
    const startedAt = candidate?.startedAt ?? value.startedAt ?? (status === "running" ? this.#host.now() : undefined)
    const endedAt = candidate?.endedAt ?? value.endedAt ?? (status === "terminal" ? this.#host.now() : undefined)
    if (startedAt === value.startedAt && endedAt === value.endedAt) return value
    return {
      ...value,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
    }
  }

  /**
   * Before Storage: new owned work needs a live owner in this commit's final records, neither `completing`, terminal nor
   * abort-marked, so a task cannot create owned work in the commit that finishes it (spec 5.5). A replaced task must
   * exist, not be terminal, and keep its conversation.
   */
  #validateTasks(): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const owners: { readonly what: string; readonly taskId: TaskId }[] = []
      for (const write of this.#writes) {
        if (write.type === "conversation" && write.value.owner !== undefined) {
          owners.push({ what: "Conversation owner task", taskId: write.value.owner.taskId })
        }
      }
      for (const task of this.#tasks.values()) {
        const owner = task.write?.kind === "create" ? task.write.record.owner : undefined
        if (owner !== undefined) owners.push({ what: "Task owner", taskId: owner })
      }
      for (const { what, taskId } of owners) {
        const task = yield* this.currentTask(taskId)
        if (task === undefined) return yield* Effect.die(new Error(`${what} ${taskId} does not exist`))
        if (task.state.status === "terminal" || task.state.status === "completing") {
          return yield* Effect.die(new Error(`${what} ${taskId} is ${task.state.status}`))
        }
        if (task.abortRequested) return yield* Effect.die(new Error(`${what} ${taskId} is abort-marked`))
      }
      for (const [id, task] of this.#tasks) {
        if (task.write?.kind !== "replace") continue
        const committed = yield* this.#committedTask(id)
        if (committed === undefined) return yield* Effect.die(new Error(`Task ${id} does not exist`))
        if (committed.state.status === "terminal") return yield* Effect.die(new Error(`Task ${id} is already terminal`))
        if (committed.conversationId !== task.write.record.conversationId) {
          return yield* Effect.die(new Error(`Task ${id} cannot change conversations`))
        }
      }
    })
  }

  /**
   * Terminal settlement retires every document of the task, including ones this commit created (spec 5.3). The stored
   * ones are found by a scan; a task this commit creates has none stored.
   */
  #retireTaskDocuments(plans: DocumentPlan[]): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const terminal = new Set<TaskId>()
      for (const task of this.#tasks.values()) {
        if (task.write?.record.state.status === "terminal") terminal.add(task.write.record.id)
      }
      if (terminal.size === 0) return
      const retiring = new Set<DocumentId>()
      for (const plan of plans) {
        const scope = plan.record.scope
        if (scope.kind !== "task" || !terminal.has(scope.taskId)) continue
        plan.retire = true
        retiring.add(plan.record.id)
      }
      for (const taskId of terminal) {
        if (this.createsTask(taskId)) continue
        let cursor: Cursor | undefined
        do {
          // The scan is the transaction's own, so a refused request is a defect.
          const page = yield* this.#storageCall(
            this.#host.storage.scanDocuments(
              { scope: { kind: "task", taskId }, at: "current" },
              SCAN_PAGE_SIZE,
              cursor,
            ),
          ).pipe(Effect.catchTag("StorageRequestError", (error) => Effect.die(error)))
          for (const record of page.items) {
            if (retiring.has(record.id)) continue
            retiring.add(record.id)
            plans.push({ addressId: addressId(record), record, retire: true })
          }
          cursor = page.next
        } while (cursor !== undefined)
      }
    })
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
