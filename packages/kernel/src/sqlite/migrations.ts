// The SQLite schema and its history (spec 11.2). Table and index names are pi-durable's (D2); the table prefix is gone (D5).
import { Effect } from "effect"
import { StorageError } from "../errors.ts"
import type { SqliteDatabase } from "./database.ts"

/** One schema version: the statements that take the previous version to it. */
export type SqliteMigration = { readonly version: number; readonly statements: readonly string[] }

const taskIndexes = [
  "CREATE INDEX tasks_by_status ON tasks (status, id)",
  "CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
  "CREATE INDEX tasks_by_kind ON tasks (kind, id)",
  "CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
  "CREATE INDEX tasks_by_background ON tasks (background, id)",
]

const taskTable = (name: string, statuses: string) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${statuses})),
  abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
  background INTEGER NOT NULL CHECK (background IN (0, 1)),
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT`

/** Every schema version in order. Never change or remove one: a change is a new version. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: [
      // next_id is TEXT because node:sqlite rejects INTEGER results outside JavaScript's safe integer range.
      `CREATE TABLE durable_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_id TEXT NOT NULL,
        next_seq INTEGER NOT NULL
      ) STRICT`,
      "INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)",
      `CREATE TABLE record_ids (
        id INTEGER PRIMARY KEY,
        record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
      ) STRICT`,
      `CREATE TABLE conversations (
        id INTEGER PRIMARY KEY,
        owner_conversation_id INTEGER,
        owner_task_id INTEGER,
        record TEXT NOT NULL CHECK (json_valid(record))
      ) STRICT`,
      "CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
      "CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
      `CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        head INTEGER,
        commit_seq INTEGER NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record))
      ) STRICT`,
      "CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
      "CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
      taskTable("tasks", "'pending', 'running', 'waiting', 'completing', 'terminal'"),
      ...taskIndexes,
      `CREATE TABLE submissions (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        request_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
        record TEXT NOT NULL CHECK (json_valid(record))
      ) STRICT`,
      "CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
      "CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
      "CREATE INDEX submissions_by_status ON submissions (status, id)",
      `CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        family INTEGER NOT NULL CHECK (family IN (0, 1)),
        key_value TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
        owner_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        retired_at INTEGER,
        record TEXT NOT NULL CHECK (json_valid(record))
      ) STRICT`,
      `CREATE INDEX documents_by_address
        ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
      "CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
      "CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
      `CREATE TABLE document_revisions (
        document_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
        version INTEGER NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content)),
        PRIMARY KEY (document_id, seq)
      ) STRICT`,
      "CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
    ],
  },
  {
    // The `sleeping` task status. SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
    version: 2,
    statements: [
      taskTable("tasks_v2", "'pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal'"),
      `INSERT INTO tasks_v2 (id, conversation_id, kind, status, abort_requested, background, record)
        SELECT id, conversation_id, kind, status, abort_requested, background, record FROM tasks`,
      "DROP TABLE tasks",
      "ALTER TABLE tasks_v2 RENAME TO tasks",
      ...taskIndexes,
    ],
  },
]

export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)!.version

type SchemaRow = { readonly version: number }

/**
 * Applies the migrations past the database's version in one transaction, so a failed one leaves the database as it
 * was. Fails for a database a newer version migrated.
 */
export function applySqliteMigrations(
  database: SqliteDatabase,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    for (const [index, migration] of migrations.entries()) {
      if (migration.version !== index + 1) {
        return yield* StorageError.because("SQLite migrations must have contiguous versions starting at 1")
      }
    }
    const latest = migrations.at(-1)?.version ?? 0
    yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL CHECK (version >= 0)
        ) STRICT`)
        yield* transaction.run(`INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)`)
        const row = yield* transaction.get<SchemaRow>(`SELECT version FROM durable_schema WHERE singleton = 1`)
        if (row === undefined) return yield* StorageError.because("SQLite schema metadata is missing")
        if (row.version > latest) {
          return yield* StorageError.because(
            `SQLite schema version ${row.version} is newer than supported version ${latest}`,
          )
        }
        for (const migration of migrations) {
          if (migration.version <= row.version) continue
          for (const statement of migration.statements) yield* transaction.exec(statement)
          yield* transaction.run(`UPDATE durable_schema SET version = ? WHERE singleton = 1`, migration.version)
        }
      }),
    )
  })
}
