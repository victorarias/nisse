// The Storage port over SQLite (spec 10 and 11.2).
// Derived from pi-durable's `src/storage/sqlite/storage.ts` at 7d073328e (MIT, see LICENSE).
import { apply, type Op } from "@sigma/delta"
import { Deferred, Effect } from "effect"
import { CommitRefused, StorageError, StorageRequestError } from "../errors.ts"
import {
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentContent,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  idFromNumber,
  type JsonObject,
  type Page,
  type ScanOrder,
  type Seq,
  seqFromNumber,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "../records.ts"
import { page, type ScanStart, scanStart } from "../scan.ts"
import type { CommitResult, ReadError, Storage, StoredEntry } from "../storage.ts"
import { CommitState, claimOf, type DocumentAction, PendingWrites, prepareDocumentActions } from "./commit.ts"
import { openSqliteDatabase, type SqliteDatabase, type SqliteDatabaseOptions, type SqliteExecutor } from "./database.ts"
import { applySqliteMigrations } from "./migrations.ts"
import { addressParts, encodeIndexedString, isCurrentOnly, parseJson, scopeColumns } from "./rows.ts"
import type { SqliteValue } from "./database.ts"

type JsonRow = { readonly record: string }
type EntryJsonRow = { readonly record: string; readonly commit_seq: number }
type RevisionRow = {
  readonly seq: number
  readonly kind: DocumentContent["kind"]
  readonly version: number
  readonly content: string
}
type MetadataRow = { readonly next_id: string; readonly next_seq: number }
type HeadMarker = EntryRecord & { readonly head: EntryId }

/** The ID condition, its parameter, and the `ORDER BY` direction of a table scan. */
const scanSql = (start: ScanStart) =>
  start.order === "ascending"
    ? { clause: "id > ?", param: start.after ?? -1, direction: "ASC" }
    : { clause: "id < ?", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" }

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  if (at === "current") return record.retiredAt === undefined
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt)
}

const unknownConversation = (id: ConversationId) =>
  Effect.fail(new StorageRequestError({ message: `Unknown conversation: ${id}` }))

/** Runs `check`, a pure check of storage's own; its `CommitRefused` becomes the refusal, anything else is a bug. */
const refusal = (check: () => void): CommitRefused | undefined => {
  try {
    check()
    return undefined
  } catch (error) {
    if (error instanceof CommitRefused) return error
    throw error
  }
}

/** Opens or creates storage in the SQLite file at `path`, migrating it to the current schema. */
export const openSqliteStorage = (
  path: string,
  options: SqliteDatabaseOptions = {},
): Effect.Effect<SqliteStorage, StorageError> =>
  // Uninterruptible, so no interruption falls between opening the database and handing it to storage.
  Effect.uninterruptible(Effect.flatMap(openSqliteDatabase(path, options), (database) => SqliteStorage.open(database)))

/** The storage contract over a `SqliteDatabase`, which it owns. */
export class SqliteStorage implements Storage {
  readonly #db: SqliteDatabase
  #nextId: number
  #closing: Deferred.Deferred<void, StorageError> | undefined
  /** Calls underway that reach the database; close waits for them, so none reaches a closed database. */
  #calls = 0
  #callsDrained: Deferred.Deferred<void> | undefined

  private constructor(db: SqliteDatabase, nextId: number) {
    this.#db = db
    this.#nextId = nextId
  }

  /** Opens storage over `db`, migrating it to the current schema. A failure or an interruption closes `db`. */
  static open(db: SqliteDatabase): Effect.Effect<SqliteStorage, StorageError> {
    return Effect.gen(function* () {
      yield* applySqliteMigrations(db)
      const metadata = yield* readMetadata(db)
      return new SqliteStorage(db, Number(metadata.next_id))
    }).pipe(Effect.onError(() => Effect.ignore(db.close())))
  }

  /**
   * One SQL transaction per call. Each batch is checked before it writes, against what the earlier ones left, and the
   * first one refused ends the call: the transaction commits the ones before it. The checks read the stored state of
   * all batches up front and run in memory, and accepted batches are written per table in multi-row statements. A copy
   * reads its source from the database, so the batches before it are written first.
   */
  commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
  ): Effect.Effect<CommitResult, StorageError> {
    return this.#admit(
      Effect.gen({ self: this }, function* () {
        const seqs: Seq[] = []
        let refused: CommitRefused | undefined
        let candidateNextId = this.#nextId
        yield* this.#db.transaction((transaction) =>
          Effect.gen({ self: this }, function* () {
            const metadata = yield* readMetadata(transaction)
            let next = metadata.next_seq
            const state = yield* CommitState.read(transaction, batches)
            const pending = new PendingWrites()
            for (const writes of batches) {
              const checked = yield* this.#checkBatch(transaction, state, pending, writes)
              if (checked instanceof CommitRefused) {
                refused = checked
                break
              }
              const seq = seqFromNumber(next++)
              state.apply(writes, checked, seq)
              // A record JSON cannot encode, such as a cycle, fails the call and rolls it back.
              yield* Effect.try({ try: () => pending.add(writes, checked, seq, state), catch: StorageError.of })
              seqs.push(seq)
              for (const write of writes) {
                const id = claimOf(write)?.id
                if (id !== undefined) candidateNextId = Math.max(candidateNextId, id + 1)
              }
            }
            yield* pending.flush(transaction)
            if (seqs.length > 0) {
              yield* transaction.run(
                "UPDATE durable_metadata SET next_id = ?, next_seq = ? WHERE singleton = 1",
                String(Math.max(Number(metadata.next_id), candidateNextId)),
                next,
              )
            }
          }),
        )
        // The transaction committed: the stored batches are durable.
        this.#nextId = Math.max(this.#nextId, candidateNextId)
        for (const [index, seq] of seqs.entries()) receive(index, seq)
        return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused }
      }),
    )
  }

  /**
   * Storage's own checks of one batch against what the batches before it left: its document actions, or its refusal.
   * Only these checks refuse; a failed database call fails the commit.
   */
  #checkBatch(
    transaction: SqliteExecutor,
    state: CommitState,
    pending: PendingWrites,
    writes: readonly StorageWrite[],
  ): Effect.Effect<Map<DocumentId, DocumentAction> | CommitRefused, StorageError> {
    return Effect.gen({ self: this }, function* () {
      let actions = new Map<DocumentId, DocumentAction>()
      const refused = refusal(() => {
        actions = prepareDocumentActions(writes)
        state.check(writes, actions)
      })
      if (refused !== undefined) return refused
      if (![...actions.values()].some((action) => action.copy !== undefined)) return actions
      yield* pending.flush(transaction)
      return (yield* this.#resolveCopies(transaction, actions)) ?? actions
    })
  }

  /**
   * Resolves each copy to a base of its source's state before this batch. A source that cannot be copied refuses the
   * batch; a failed database call fails the commit.
   */
  #resolveCopies(
    executor: SqliteExecutor,
    actions: Map<DocumentId, DocumentAction>,
  ): Effect.Effect<CommitRefused | undefined, StorageError> {
    return Effect.gen({ self: this }, function* () {
      // Only a failure of the database itself fails the commit; corrupt or unusable sources refuse the batch.
      let databaseFailed = false
      const watched = watchCalls(executor, () => {
        databaseFailed = true
      })
      for (const [id, action] of actions) {
        if (action.copy === undefined) continue
        const source = action.copy
        const create = action.create!
        const stored = yield* Effect.result(materializeDocument(watched, source.id, source.at))
        if (stored._tag === "Failure" && databaseFailed) return yield* Effect.fail(stored.failure as StorageError)
        const reason =
          stored._tag === "Failure"
            ? stored.failure
            : stored.success === undefined
              ? new Error(`Fork source document ${source.id} cannot be read`)
              : stored.success.record.scope.kind !== "conversation" ||
                  create.scope.kind !== "conversation" ||
                  stored.success.record.kind !== create.kind ||
                  stored.success.record.key !== create.key ||
                  stored.success.record.history !== create.history ||
                  stored.success.record.fork !== create.fork
                ? new Error(`Fork source document ${source.id} does not match the copied record`)
                : undefined
        if (reason !== undefined) {
          return new CommitRefused({ message: `Document copy ${id} was rejected`, cause: reason })
        }
        const { version, value } = (stored as { readonly success: StoredDocument }).success
        action.content = { kind: "base", version, value }
      }
      return undefined
    })
  }

  mintId<I extends Id<string>>(): Effect.Effect<I, StorageError> {
    return this.#admit(
      Effect.gen({ self: this }, function* () {
        if (!Number.isSafeInteger(this.#nextId)) return yield* StorageError.because("ID space is exhausted")
        return idFromNumber<I>(this.#nextId++)
      }),
    )
  }

  conversation(id: ConversationId): Effect.Effect<ConversationRecord | undefined, StorageError> {
    return this.#admit(this.#readConversation(id))
  }

  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<ConversationRecord>, ReadError> {
    const filters: [string, SqliteValue | undefined][] = [
      ["owner_conversation_id = ?", query.ownerConversationId],
      ["owner_task_id = ?", query.ownerTaskId],
    ]
    return this.#scanTable<ConversationRecord>("conversations", query.order, filters, limit, cursor)
  }

  entry(id: EntryId): Effect.Effect<StoredEntry | undefined, ReadError>
  entry(conversationId: ConversationId, id: EntryId): Effect.Effect<StoredEntry | undefined, ReadError>
  entry(first: EntryId | ConversationId, second?: EntryId): Effect.Effect<StoredEntry | undefined, ReadError> {
    return this.#admit(
      Effect.gen({ self: this }, function* () {
        const id = idFromNumber<EntryId>(second ?? first)
        let conversation: ConversationRecord | undefined
        if (second !== undefined) {
          const conversationId = idFromNumber<ConversationId>(first)
          conversation = yield* this.#readConversation(conversationId)
          if (conversation === undefined) return yield* unknownConversation(conversationId)
        }
        const row = yield* this.#db.get<EntryJsonRow>("SELECT record, commit_seq FROM entries WHERE id = ?", id)
        if (row === undefined) return undefined
        const entry = parseJson<EntryRecord>(row.record)
        if (conversation !== undefined) {
          let upperEntryId = Number.POSITIVE_INFINITY
          while (conversation.id !== entry.conversationId) {
            if (conversation.parent === undefined) return undefined
            upperEntryId = Math.min(upperEntryId, conversation.parent.at)
            conversation = (yield* this.#readConversation(conversation.parent.conversationId))!
          }
          if (entry.id > upperEntryId) return undefined
        }
        return { entry, commitSeq: seqFromNumber(row.commit_seq) }
      }),
    )
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
  ): Effect.Effect<HeadMarker | undefined, ReadError> {
    return this.#admit(
      Effect.gen({ self: this }, function* () {
        let conversation = yield* this.#readConversation(conversationId)
        if (conversation === undefined) return yield* unknownConversation(conversationId)
        let upper: number | undefined = atOrBeforeEntryId
        while (true) {
          const row =
            upper === undefined
              ? yield* this.#db.get<JsonRow>(
                  "SELECT record FROM entries WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1",
                  conversation.id,
                )
              : yield* this.#db.get<JsonRow>(
                  "SELECT record FROM entries WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1",
                  conversation.id,
                  upper,
                )
          if (row !== undefined) return parseJson<HeadMarker>(row.record)
          if (conversation.parent === undefined) return undefined
          upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at)
          conversation = (yield* this.#readConversation(conversation.parent.conversationId))!
        }
      }),
    )
  }

  /**
   * Newest first by default, applying every ancestry cap; oldest first, the root's segment and then each fork's. With
   * no bounds it pages the whole visible history.
   */
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<EntryRecord>, ReadError> {
    return this.#admit(
      Effect.gen({ self: this }, function* () {
        const { order, after } = yield* scanStart(query.order, cursor, "descending")
        // The fork chain from the queried conversation to the root, each segment with its inclusive upper bound.
        const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = []
        let conversation = yield* this.#readConversation(query.conversationId)
        if (conversation === undefined) return yield* unknownConversation(query.conversationId)
        let upper: number | undefined = query.maxEntryId
        if (order === "descending" && after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1)
        let lower: number | undefined = query.minEntryId
        if (order === "ascending" && after !== undefined) lower = Math.max(lower ?? after + 1, after + 1)
        const values: EntryRecord[] = []
        while (true) {
          segments.push({ conversationId: conversation.id, upper })
          // Newest first, each segment is read as the chain is walked, so a full page stops the walk early.
          if (order === "descending") {
            values.push(...(yield* this.#readSegment(conversation.id, lower, upper, "DESC", limit + 1 - values.length)))
            if (values.length > limit) break
          }
          if (conversation.parent === undefined) break
          upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at)
          if (query.minEntryId !== undefined && upper < query.minEntryId) break
          conversation = (yield* this.#readConversation(conversation.parent.conversationId))!
        }
        if (order === "ascending") {
          for (const segment of segments.reverse()) {
            values.push(
              ...(yield* this.#readSegment(
                segment.conversationId,
                lower,
                segment.upper,
                "ASC",
                limit + 1 - values.length,
              )),
            )
            if (values.length > limit) break
          }
        }
        return page(values, limit, order)
      }),
    )
  }

  #readSegment(
    conversationId: ConversationId,
    lower: number | undefined,
    upper: number | undefined,
    direction: "ASC" | "DESC",
    limit: number,
  ): Effect.Effect<EntryRecord[], StorageError> {
    const clauses = ["conversation_id = ?"]
    const params: SqliteValue[] = [conversationId]
    if (lower !== undefined) {
      clauses.push("id >= ?")
      params.push(lower)
    }
    if (upper !== undefined) {
      clauses.push("id <= ?")
      params.push(upper)
    }
    params.push(limit)
    return Effect.map(
      this.#db.all<JsonRow>(
        `SELECT record FROM entries WHERE ${clauses.join(" AND ")} ORDER BY id ${direction} LIMIT ?`,
        ...params,
      ),
      (rows) => rows.map((row) => parseJson<EntryRecord>(row.record)),
    )
  }

  task(id: TaskId): Effect.Effect<TaskRecord | undefined, StorageError> {
    return this.#admit(this.#readRecord<TaskRecord>("SELECT record FROM tasks WHERE id = ?", id))
  }

  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined): Effect.Effect<Page<TaskRecord>, ReadError> {
    const flag = (value: boolean | undefined) => (value === undefined ? undefined : value ? 1 : 0)
    const filters: [string, SqliteValue | undefined][] = [
      ["conversation_id = ?", query.conversationId],
      ["kind = ?", query.kind === undefined ? undefined : encodeIndexedString(query.kind)],
      ["status = ?", query.status],
      ["abort_requested = ?", flag(query.abortRequested)],
      ["background = ?", flag(query.background)],
    ]
    return this.#scanTable<TaskRecord>("tasks", query.order, filters, limit, cursor)
  }

  submission(id: SubmissionId): Effect.Effect<SubmissionRecord | undefined, StorageError> {
    return this.#admit(this.#readRecord<SubmissionRecord>("SELECT record FROM submissions WHERE id = ?", id))
  }

  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<SubmissionRecord>, ReadError> {
    const filters: [string, SqliteValue | undefined][] = [
      ["conversation_id = ?", query.conversationId],
      ["status = ?", query.status],
    ]
    return this.#scanTable<SubmissionRecord>("submissions", query.order, filters, limit, cursor)
  }

  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
  ): Effect.Effect<SubmissionRecord | undefined, StorageError> {
    return this.#admit(
      this.#readRecord<SubmissionRecord>(
        "SELECT record FROM submissions WHERE conversation_id = ? AND request_id = ?",
        conversationId,
        encodeIndexedString(requestId),
      ),
    )
  }

  findDocument(address: DocumentAddress, at: DocumentPoint): Effect.Effect<DocumentRecord | undefined, StorageError> {
    const parts = addressParts(address)
    const where = "kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?"
    const params: SqliteValue[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]
    const sql =
      at === "current"
        ? `SELECT record FROM documents WHERE ${where} AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
        : `SELECT record FROM documents WHERE ${where} AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
            ORDER BY created_at DESC LIMIT 1`
    if (at !== "current") params.push(at, at)
    return this.#admit(this.#readRecord<DocumentRecord>(sql, ...params))
  }

  document(id: DocumentId, at: DocumentPoint): Effect.Effect<StoredDocument | undefined, ReadError> {
    // The record and revision queries must see one committed state; a commit between them can replace the base.
    return this.#admit(this.#db.transaction((transaction) => materializeDocument(transaction, id, at)))
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<DocumentRecord>, ReadError> {
    return this.#admit(
      Effect.gen({ self: this }, function* () {
        const after = cursor?.after
        if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after))) {
          return yield* new StorageRequestError({ message: "Invalid storage cursor" })
        }
        const scope = scopeColumns(query.scope)
        const clauses = ["scope_kind = ?", "owner_id = ?", "id > ?"]
        const params: SqliteValue[] = [scope.scopeKind, scope.ownerId, after ?? -1]
        if (query.kind !== undefined) {
          clauses.push("kind = ?")
          params.push(encodeIndexedString(query.kind))
        }
        if (query.at === "current") {
          clauses.push("retired_at IS NULL")
        } else {
          clauses.push("created_at <= ?", "(retired_at IS NULL OR retired_at > ?)")
          params.push(query.at, query.at)
        }
        params.push(limit + 1)
        const rows = yield* this.#db.all<JsonRow>(
          `SELECT record FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
          ...params,
        )
        return page(
          rows.map((row) => parseJson<DocumentRecord>(row.record)),
          limit,
          "ascending",
        )
      }),
    )
  }

  close(): Effect.Effect<void, StorageError> {
    // The close runs on its own fiber and every caller awaits it, so interrupting a caller only stops its wait.
    return Effect.suspend(() => {
      if (this.#closing !== undefined) return Deferred.await(this.#closing)
      const closing = Deferred.makeUnsafe<void, StorageError>()
      this.#closing = closing
      const close = Effect.gen({ self: this }, function* () {
        if (this.#calls > 0) {
          this.#callsDrained = Deferred.makeUnsafe<void>()
          yield* Deferred.await(this.#callsDrained)
        }
        yield* this.#db.close()
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(closing, exit)),
      )
      return Effect.andThen(Effect.forkDetach(close, { startImmediately: true }), Deferred.await(closing))
    })
  }

  /**
   * Runs a call on open storage, and fails it once storage is closing. Close waits for the calls underway, so none of
   * their queries reaches a closed database.
   */
  #admit<A, E>(call: Effect.Effect<A, E>): Effect.Effect<A, E | StorageError> {
    return Effect.suspend((): Effect.Effect<A, E | StorageError> => {
      if (this.#closing !== undefined) return Effect.fail(StorageError.because("SqliteStorage is closed"))
      this.#calls++
      return Effect.ensuring(
        call,
        Effect.sync(() => {
          if (--this.#calls === 0 && this.#callsDrained !== undefined)
            Deferred.doneUnsafe(this.#callsDrained, Effect.void)
        }),
      )
    })
  }

  #readConversation(id: ConversationId): Effect.Effect<ConversationRecord | undefined, StorageError> {
    return this.#readRecord<ConversationRecord>("SELECT record FROM conversations WHERE id = ?", id)
  }

  #readRecord<T>(sql: string, ...params: SqliteValue[]): Effect.Effect<T | undefined, StorageError> {
    return Effect.map(this.#db.get<JsonRow>(sql, ...params), (row) =>
      row === undefined ? undefined : parseJson<T>(row.record),
    )
  }

  /** A table scan in ID order, with each defined filter as one condition. */
  #scanTable<T extends { readonly id: Id<string> }>(
    table: string,
    order: ScanOrder | undefined,
    filters: readonly (readonly [string, SqliteValue | undefined])[],
    limit: number,
    cursor: Cursor | undefined,
  ): Effect.Effect<Page<T>, ReadError> {
    return this.#admit(
      Effect.gen({ self: this }, function* () {
        const start = yield* scanStart(order, cursor, "ascending")
        const scan = scanSql(start)
        const clauses = [scan.clause]
        const params: SqliteValue[] = [scan.param]
        for (const [clause, value] of filters) {
          if (value === undefined) continue
          clauses.push(clause)
          params.push(value)
        }
        params.push(limit + 1)
        const rows = yield* this.#db.all<JsonRow>(
          `SELECT record FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
          ...params,
        )
        return page(
          rows.map((row) => parseJson<T>(row.record)),
          limit,
          start.order,
        )
      }),
    )
  }
}

const readMetadata = (executor: SqliteExecutor): Effect.Effect<MetadataRow, StorageError> =>
  Effect.flatMap(
    executor.get<MetadataRow>("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1"),
    (metadata) =>
      metadata === undefined
        ? Effect.fail(StorageError.because("Durable SQLite metadata is missing"))
        : Effect.succeed(metadata),
  )

/**
 * One incarnation's value at `at`: the newest base at or before it and the delta tail after it. A historical read of a
 * current-only document is invalid; a missing base or a tail crossing a version is corruption.
 */
const materializeDocument = (
  executor: SqliteExecutor,
  id: DocumentId,
  at: DocumentPoint,
): Effect.Effect<StoredDocument | undefined, ReadError> =>
  Effect.gen(function* () {
    const row = yield* executor.get<JsonRow>("SELECT record FROM documents WHERE id = ?", id)
    if (row === undefined) return undefined
    const record = parseJson<DocumentRecord>(row.record)
    if (at !== "current" && isCurrentOnly(record)) {
      return yield* new StorageRequestError({ message: `Document ${id} does not retain historical content` })
    }
    if (!isAliveAt(record, at)) return undefined
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at
    const base = yield* executor.get<RevisionRow>(
      `SELECT seq, kind, version, content FROM document_revisions
        WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
      id,
      upper,
    )
    if (base === undefined) return yield* StorageError.because(`Document ${id} is missing a required base`)
    const tail = yield* executor.all<RevisionRow>(
      `SELECT seq, kind, version, content FROM document_revisions
        WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
      id,
      base.seq,
      upper,
    )
    let value = parseJson<JsonObject>(base.content)
    for (const revision of tail) {
      if (revision.kind !== "delta" || revision.version !== base.version) {
        return yield* StorageError.because(`Document ${id} crosses a stored version boundary without a base`)
      }
      value = yield* Effect.try({
        try: () => apply(value, parseJson<readonly Op[]>(revision.content)) as JsonObject,
        catch: StorageError.of,
      })
    }
    return { record, version: base.version, value, deltasSinceBase: tail.length }
  })

/** `executor`, calling `failed` when one of its calls fails. */
const watchCalls = (executor: SqliteExecutor, failed: () => void): SqliteExecutor => {
  const watch = <A>(call: Effect.Effect<A, StorageError>) => Effect.tapError(call, () => Effect.sync(failed))
  return {
    exec: (sql) => watch(executor.exec(sql)),
    run: (sql, ...params) => watch(executor.run(sql, ...params)),
    runCounted: (sql, ...params) => watch(executor.runCounted(sql, ...params)),
    get: (sql, ...params) => watch(executor.get(sql, ...params)),
    all: (sql, ...params) => watch(executor.all(sql, ...params)),
  }
}
