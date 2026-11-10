import type { Effect } from "effect"
import type { CommitRefused, StorageError, StorageRequestError } from "./errors.ts"
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  Page,
  Seq,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from "./records.ts"

/** How many batches of a commit call are durable, and the refusal that stopped the call, if one did. */
export type CommitResult = { readonly stored: number; readonly refused?: CommitRefused }

/** An entry and the sequence of the commit that stored it. */
export type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq }

/** A read's failure: invalid (`StorageRequestError`, that read only) or unknown (`StorageError`, final). */
export type ReadError = StorageError | StorageRequestError

/**
 * The storage contract of spec section 10. It trusts the owning Session for valid records, references and transitions;
 * it enforces atomicity, global ID ownership, immutable conversations and entries, document record consistency and
 * detached values. The Session serializes commits. Once `commit` succeeds, later reads observe it.
 *
 * Every failure but a `StorageRequestError` is final for the Session (spec 10.1). The Session calls one method at a
 * time on its mutation line and waits for it to settle, so an implementation may suspend.
 */
export interface Storage {
  /**
   * Stores `batches` in order, each as one atomic commit with its own seq, checked against what the earlier ones left.
   * Every batch has a write. Stops at the first batch storage's checks refuse: the batches before it are durable, it and
   * the ones after are not. Calls `receive(index, seq)` once per durable batch, in order, after all of them are durable.
   * Fails with a `StorageError` when the outcome is unknown.
   */
  commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
  ): Effect.Effect<CommitResult, StorageError>
  /** An ID above every ID minted since this storage opened and every ID stored, also across reopen. */
  mintId<I extends Id<string>>(): Effect.Effect<I, StorageError>

  conversation(id: ConversationId): Effect.Effect<ConversationRecord | undefined, StorageError>
  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<ConversationRecord>, ReadError>

  /** The entry by its global ID; with a conversation, only when that conversation's ancestry shows it. */
  entry(id: EntryId): Effect.Effect<StoredEntry | undefined, ReadError>
  entry(conversationId: ConversationId, id: EntryId): Effect.Effect<StoredEntry | undefined, ReadError>
  /** The newest visible entry carrying `head`, at or below the inclusive cutoff. */
  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
  ): Effect.Effect<(EntryRecord & { readonly head: EntryId }) | undefined, ReadError>
  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined): Effect.Effect<Page<EntryRecord>, ReadError>

  task(id: TaskId): Effect.Effect<TaskRecord | undefined, StorageError>
  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined): Effect.Effect<Page<TaskRecord>, ReadError>

  submission(id: SubmissionId): Effect.Effect<SubmissionRecord | undefined, StorageError>
  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<SubmissionRecord>, ReadError>
  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
  ): Effect.Effect<SubmissionRecord | undefined, StorageError>

  /** The incarnation at one exact address, current or at a point. */
  findDocument(address: DocumentAddress, at: DocumentPoint): Effect.Effect<DocumentRecord | undefined, StorageError>
  /** One incarnation's value at a point; never follows a replacement at the same address. */
  document(id: DocumentId, at: DocumentPoint): Effect.Effect<StoredDocument | undefined, ReadError>
  /** The incarnations alive in one scope at a point, in ascending ID order. */
  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<DocumentRecord>, ReadError>

  /** Waits for the reads underway, then closes. Every later call fails. Closing again waits for the same close. */
  close(): Effect.Effect<void, StorageError>
}
