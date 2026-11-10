// The records Storage keeps and the shapes of its reads and writes (spec sections 2, 3.2 and 10). Their names, fields
// and JSON are pi-durable's (D2), so a database and the upstream suite read the same.
import type { Op } from "@nisse/delta"
import type { JsonValue } from "@nisse/delta/json"

export type { JsonValue }

/** JSON object used as the root of every document. */
export type JsonObject = { [key: string]: JsonValue }

declare const idBrand: unique symbol

/** A number from the one global ID namespace, branded with the record kind it names. The brand is compile-time only. */
export type Id<Kind extends string, Type = unknown> = number & {
  readonly [idBrand]: { readonly kind: Kind; readonly type: Type }
}

export type ConversationId = Id<"conversation">
export type EntryId = Id<"entry">
export type TaskId<Result = unknown> = Id<"task", Result>
export type SubmissionId = Id<"submission">
export type DocumentId = Id<"document">

declare const seqBrand: unique symbol

/** The sequence of one atomic storage commit. It strictly increases; gaps are allowed. */
export type Seq = number & { readonly [seqBrand]: "sequence" }

/** The root conversation always has this ID. */
export const ROOT_CONVERSATION_ID = 1 as ConversationId

/** Brands a number as an ID, at a boundary that allocated or decoded it. */
export const idFromNumber = <I extends Id<string>>(value: number): I => value as I

/** Brands a number as a commit sequence, at a storage boundary. */
export const seqFromNumber = (value: number): Seq => value as Seq

/** Identity, fork ancestry and task ownership of a conversation. Immutable. */
export type ConversationRecord = {
  readonly id: ConversationId
  /** Fork source and the inclusive parent entry through which history is inherited. */
  readonly parent?: { readonly conversationId: ConversationId; readonly at: EntryId }
  /** The task that created the conversation, and that task's conversation. */
  readonly owner?: { readonly conversationId: ConversationId; readonly taskId: TaskId }
}

/** An override of one visible entry's contribution to model context. Messages are the harness's; storage keeps JSON. */
export type ContextEdit = { readonly target: EntryId } & (
  | { readonly action: "omit"; readonly messages?: never }
  | { readonly action: "replace"; readonly messages: readonly JsonObject[] }
)

/** One immutable transcript record. */
export type EntryRecord = {
  readonly id: EntryId
  readonly conversationId: ConversationId
  readonly kind: string
  /** Messages contributed to model context, as the harness defines them. */
  readonly model?: readonly JsonObject[]
  readonly data?: JsonValue
  /** First entry of the context this entry selects. */
  readonly head?: EntryId
  readonly edits?: readonly ContextEdit[]
  readonly byTaskId?: TaskId
}

/** A telemetry adapter's propagation context. */
export type TelemetryCarrier = Readonly<Record<string, string>>

type SubmissionRecordBase = {
  /** The admission span's context; absent without propagation. */
  readonly trace?: TelemetryCarrier
  readonly id: SubmissionId
  readonly conversationId: ConversationId
  /** Host-provided deduplication key, scoped to the conversation. */
  readonly requestId?: string
}

type Unsettled = { readonly answer?: never; readonly reason?: never; readonly detail?: never }
type Unanswered = { readonly answer?: never; readonly reason: string; readonly detail?: JsonValue }

/** The lifecycle of one admitted input, passive write or continue. */
export type SubmissionRecord =
  | (SubmissionRecordBase & { readonly type: "input" } & (
        | ({ readonly status: "queued"; readonly entry?: never } & Unsettled)
        | ({ readonly status: "placed"; readonly entry: EntryId } & Unsettled)
        | {
            readonly status: "done"
            readonly entry: EntryId
            readonly answer: EntryId
            readonly reason?: never
            readonly detail?: never
          }
        | ({ readonly status: "unanswered"; readonly entry?: EntryId } & Unanswered)
      ))
  | (SubmissionRecordBase & { readonly type: "write" } & (
        | ({ readonly status: "queued"; readonly entry?: never } & Unsettled)
        | ({ readonly status: "done"; readonly entry: EntryId } & Unsettled)
        | ({ readonly status: "unanswered"; readonly entry?: never } & Unanswered)
      ))
  | (SubmissionRecordBase & { readonly type: "continue" } & (
        | ({ readonly status: "placed"; readonly entry?: never } & Unsettled)
        | {
            readonly status: "done"
            readonly entry?: never
            readonly answer: EntryId
            readonly reason?: never
            readonly detail?: never
          }
        | ({ readonly status: "unanswered"; readonly entry?: never } & Unanswered)
      ))

/** A JSON-safe error kept in place of a runtime `Error`. */
export type TaskOutcomeError = { readonly message: string; readonly detail?: JsonValue }

/** Why a task became terminal, and its result. */
export type TaskOutcome<R> =
  | { readonly status: "completed"; readonly result: R; readonly error?: never; readonly reason?: never }
  | { readonly status: "failed"; readonly error: TaskOutcomeError; readonly result?: R; readonly reason?: never }
  | { readonly status: "aborted"; readonly reason?: string; readonly result?: R; readonly error?: never }
  | { readonly status: "orphaned"; readonly reason: string; readonly result?: never; readonly error?: never }
  | { readonly status: "faulted"; readonly error: TaskOutcomeError; readonly result?: never; readonly reason?: never }

/** How a waiting task joins the tasks it waits on. */
export type JoinPolicy = "failFast" | "allSettled"

/** A task's complete execution state. */
export type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S; readonly outcome?: never }
  | { readonly status: "running"; readonly checkpoint: S; readonly outcome?: never }
  | {
      readonly status: "waiting"
      readonly checkpoint: S
      readonly on: readonly TaskId[]
      readonly policy: JoinPolicy
      readonly outcome?: never
    }
  | { readonly status: "sleeping"; readonly checkpoint: S; readonly until: number; readonly outcome?: never }
  | { readonly status: "completing"; readonly checkpoint?: never; readonly outcome: TaskOutcome<R> }
  | { readonly status: "terminal"; readonly checkpoint?: never; readonly outcome: TaskOutcome<R> }

/** The status of a task, as storage indexes it. */
export type TaskStatus = TaskState<unknown, unknown>["status"]

type TaskRecordBase<I, R> = {
  readonly trace?: TelemetryCarrier
  readonly links?: readonly TelemetryCarrier[]
  readonly id: TaskId<R>
  readonly conversationId: ConversationId
  readonly kind: string
  readonly version: number
  readonly input: I
  /** The owning task of a child task; absent for a task its conversation owns. */
  readonly owner?: TaskId
  readonly background: boolean
  readonly abortRequested: boolean
  readonly abortReason?: "restart"
  readonly abandonOnRestart?: true
  readonly startedAt?: number
  readonly endedAt?: number
  readonly restarts?: number
}

/** A task's complete record, replaced whole on each change. */
export type TaskRecord<I = JsonValue, S = JsonValue, R = JsonValue> = TaskRecordBase<I, R> &
  (
    | {
        readonly state: Extract<TaskState<S, R>, { readonly status: "pending" | "running" | "waiting" | "sleeping" }>
        readonly memos?: Readonly<Record<string, JsonValue>>
      }
    | {
        readonly state: Extract<TaskState<S, R>, { readonly status: "completing" | "terminal" }>
        readonly memos?: never
      }
  )

/** The lifecycle record of one create-to-retire document incarnation. */
export type DocumentRecord = {
  /** Never reused when the same logical document is created again. */
  readonly id: DocumentId
  readonly kind: string
  /** A family member's key; absent for a singleton. */
  readonly key?: string
  /** The commit that created the incarnation, stamped by storage. */
  readonly createdAt: Seq
  /** The commit that retired it; absent while it is current. */
  readonly retiredAt?: Seq
} & (
  | { readonly scope: { readonly kind: "session" }; readonly history?: never; readonly fork?: never }
  | ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
      | { readonly history: "latest"; readonly fork: "current" | "initial" }
      | { readonly history: "rewindable"; readonly fork: "asOf" | "current" | "initial" }
    ))
  | {
      readonly scope: { readonly kind: "task"; readonly taskId: TaskId }
      readonly history?: never
      readonly fork?: never
    }
)

/** A document record before storage stamps its lifetime. */
export type DocumentCreate = DocumentRecord extends infer R
  ? R extends DocumentRecord
    ? Omit<R, "createdAt" | "retiredAt">
    : never
  : never

/** One page of an ordered scan, and the cursor that continues it. */
export type Page<T> = { readonly items: readonly T[]; readonly next?: Cursor }

/** Backend-owned JSON that continues one scan, in the order it started with. */
export type Cursor = Readonly<Record<string, JsonValue>>

/** ID order: `ascending` is oldest first. */
export type ScanOrder = "ascending" | "descending"

export type ConversationQuery = {
  readonly ownerConversationId?: ConversationId
  readonly ownerTaskId?: TaskId
  /** Default `ascending`. */
  readonly order?: ScanOrder
}

/** Inclusive ID bounds over one conversation's history, its fork ancestry included. */
export type EntryQuery = {
  readonly conversationId: ConversationId
  readonly minEntryId?: EntryId
  readonly maxEntryId?: EntryId
  /** Default `descending`. */
  readonly order?: ScanOrder
}

export type TaskQuery = {
  readonly conversationId?: ConversationId
  readonly kind?: string
  readonly status?: TaskStatus
  readonly abortRequested?: boolean
  readonly background?: boolean
  /** Default `ascending`. */
  readonly order?: ScanOrder
}

export type SubmissionQuery = {
  readonly conversationId?: ConversationId
  readonly status?: SubmissionRecord["status"]
  /** Default `ascending`. */
  readonly order?: ScanOrder
}

/** Current state, or the state after one commit. */
export type DocumentPoint = Seq | "current"

/** A singleton's or one family member's logical identity. */
export type DocumentAddress = {
  readonly kind: string
  readonly scope: DocumentRecord["scope"]
  /** Absent selects the singleton. */
  readonly key?: string
}

/** The incarnations alive in one exact scope at one point. */
export type DocumentQuery = {
  readonly scope: DocumentRecord["scope"]
  readonly at: DocumentPoint
  readonly kind?: string
}

/** A complete value, or Chord operations on the previous one. */
export type DocumentContent =
  | { readonly version: number; readonly kind: "base"; readonly value: JsonObject }
  | { readonly version: number; readonly kind: "delta"; readonly ops: readonly Op[] }

/** The stored source of a document copy. */
export type DocumentCopySource = { readonly id: DocumentId; readonly at: DocumentPoint }

/** A document's materialized value at a point. */
export type StoredDocument = {
  readonly record: DocumentRecord
  readonly version: number
  readonly value: JsonObject
  /** Deltas replayed after the selected base. */
  readonly deltasSinceBase: number
}

/** One record or document change in an atomic commit. */
export type StorageWrite =
  | { readonly type: "conversation"; readonly value: ConversationRecord }
  | { readonly type: "entry"; readonly value: EntryRecord }
  | { readonly type: "task"; readonly value: TaskRecord }
  | { readonly type: "submission"; readonly value: SubmissionRecord }
  | {
      readonly type: "document.create"
      readonly record: DocumentCreate
      readonly content: Extract<DocumentContent, { readonly kind: "base" }>
    }
  | { readonly type: "document.copy"; readonly record: DocumentCreate; readonly source: DocumentCopySource }
  | { readonly type: "document.change"; readonly id: DocumentId; readonly content: DocumentContent }
  | { readonly type: "document.retire"; readonly id: DocumentId }
