// The SQLite facade storage is written against (D6): chord's `SqliteDatabase` shape, with every call an Effect. The real
// database is `Effect.sync` over `bun:sqlite`; a test double may suspend, because storage waits for each call.
import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Exit, Semaphore } from "effect"
import { StorageError } from "../errors.ts"

/** Values a statement binds. */
export type SqliteValue = null | number | bigint | string | Uint8Array

/**
 * SQL calls shared by a database and its transaction handles. `exec` runs SQL text without bindings, possibly several
 * statements. `run`, `get` and `all` run one statement with positional bindings; `runCounted` also returns the rows it
 * inserted, updated or deleted. Statements may be cached by SQL text, so pass values as bindings.
 */
export interface SqliteExecutor {
  exec(sql: string): Effect.Effect<void, StorageError>
  run(sql: string, ...params: SqliteValue[]): Effect.Effect<void, StorageError>
  runCounted(sql: string, ...params: SqliteValue[]): Effect.Effect<number, StorageError>
  get<T extends object>(sql: string, ...params: SqliteValue[]): Effect.Effect<T | undefined, StorageError>
  all<T extends object>(sql: string, ...params: SqliteValue[]): Effect.Effect<T[], StorageError>
}

/**
 * A SQLite database. `transaction` gives `body` a handle for all of its work, invalid once the body ends; it commits
 * when the body succeeds and rolls back when it fails or is interrupted. A failed rollback fails with a `StorageError`,
 * so no caller mistakes the body's own failure for a guaranteed rollback. Calls on the database wait while a
 * transaction is open, so they never see its uncommitted writes; the body must use its handle, not the database.
 */
export interface SqliteDatabase extends SqliteExecutor {
  transaction<A, E, R>(
    body: (transaction: SqliteExecutor) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StorageError, R>
  close(): Effect.Effect<void, StorageError>
}

export type SqliteDatabaseOptions = {
  /** WAL pages after which SQLite checkpoints. Default 1,000, SQLite's own. */
  readonly walAutoCheckpointPages?: number
}

// F3 measured a commit at 0.04 to 0.05 ms median and about 0.5 ms p99: a lock held 5 s is far past any healthy holder.
const BUSY_TIMEOUT_MS = 5_000
const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000

/** A call to the driver, its throw as a `StorageError`. */
const call = <A>(operation: () => A): Effect.Effect<A, StorageError> =>
  Effect.try({ try: operation, catch: StorageError.of })

class BunSqliteExecutor implements SqliteExecutor {
  readonly #connection: BunSqliteConnection
  readonly #active: () => boolean
  readonly #admit: <A>(call: Effect.Effect<A, StorageError>) => Effect.Effect<A, StorageError>

  constructor(
    connection: BunSqliteConnection,
    active: () => boolean,
    admit: <A>(call: Effect.Effect<A, StorageError>) => Effect.Effect<A, StorageError> = (call) => call,
  ) {
    this.#connection = connection
    this.#active = active
    this.#admit = admit
  }

  exec(sql: string): Effect.Effect<void, StorageError> {
    return this.#call((connection) => connection.exec(sql))
  }

  run(sql: string, ...params: SqliteValue[]): Effect.Effect<void, StorageError> {
    return this.#call((connection) => void connection.statement(sql).run(...params))
  }

  runCounted(sql: string, ...params: SqliteValue[]): Effect.Effect<number, StorageError> {
    return this.#call((connection) => Number(connection.statement(sql).run(...params).changes))
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Effect.Effect<T | undefined, StorageError> {
    // bun:sqlite returns null for no row.
    return this.#call((connection) => (connection.statement(sql).get(...params) ?? undefined) as T | undefined)
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Effect.Effect<T[], StorageError> {
    return this.#call((connection) => connection.statement(sql).all(...params) as T[])
  }

  #call<A>(operation: (connection: BunSqliteConnection) => A): Effect.Effect<A, StorageError> {
    return this.#admit(
      call(() => {
        if (!this.#active()) throw new Error("SQLite transaction handle is no longer active")
        return operation(this.#connection)
      }),
    )
  }
}

/** One `bun:sqlite` connection and its prepared statements, cached by SQL text. */
class BunSqliteConnection {
  readonly database: Database
  // Storage's SQL comes from a fixed set of templates (filters, directions and power-of-two row counts), not from data,
  // so the cache is bounded by the code.
  readonly #statements = new Map<string, Statement>()

  constructor(database: Database) {
    this.database = database
  }

  exec(sql: string): void {
    this.database.exec(sql)
  }

  statement(sql: string): Statement {
    let statement = this.#statements.get(sql)
    if (statement === undefined) {
      statement = this.database.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }

  close(): void {
    for (const statement of this.#statements.values()) statement.finalize?.()
    this.#statements.clear()
    try {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } finally {
      this.database.close()
    }
  }
}

/**
 * A `SqliteDatabase` over one `bun:sqlite` connection. Every call runs synchronously, but a transaction's body can
 * suspend, if only when the runtime yields its fiber, so one permit orders the connection's calls and transactions.
 */
export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  readonly #connection: BunSqliteConnection
  readonly #permit: Semaphore.Semaphore
  #closed = false

  /** Takes ownership of `database`: closing this closes it. */
  constructor(database: Database) {
    const connection = new BunSqliteConnection(database)
    const permit = Semaphore.makeUnsafe(1)
    super(connection, () => true, Semaphore.withPermit(permit))
    this.#connection = connection
    this.#permit = permit
  }

  transaction<A, E, R>(
    body: (transaction: SqliteExecutor) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StorageError, R> {
    // Only the body is interruptible: an interrupted body still ends in a rollback, so the connection never stays inside
    // the transaction.
    return Semaphore.withPermit(this.#permit)(
      Effect.uninterruptibleMask((restore) => {
        const connection = this.#connection
        const handle = transactionHandle()
        return call(() => connection.exec("BEGIN IMMEDIATE")).pipe(
          Effect.andThen(Effect.exit(restore(body(new BunSqliteExecutor(connection, handle.active))))),
          Effect.flatMap((exit): Effect.Effect<A, E | StorageError> => {
            handle.end()
            if (Exit.isSuccess(exit)) {
              return call(() => connection.exec("COMMIT")).pipe(
                Effect.catch((error) => Effect.andThen(rollback(connection, error), Effect.fail(error))),
                Effect.as(exit.value),
              )
            }
            return Effect.andThen(rollback(connection, exit.cause), exit)
          }),
        )
      }),
    )
  }

  close(): Effect.Effect<void, StorageError> {
    return Semaphore.withPermit(this.#permit)(
      call(() => {
        if (this.#closed) return
        this.#closed = true
        this.#connection.close()
      }),
    )
  }
}

/**
 * Whether a transaction's handle may still run calls. Made outside the transaction's scope so the handle's executor
 * keeps no reference to the transaction body, which holds its commit's values.
 */
function transactionHandle(): { readonly active: () => boolean; end(): void } {
  let active = true
  return {
    active: () => active,
    end: () => {
      active = false
    },
  }
}

/** Rolls back after `failure`; a rollback that fails too fails with both. */
const rollback = (connection: BunSqliteConnection, failure: unknown): Effect.Effect<void, StorageError> =>
  call(() => connection.exec("ROLLBACK")).pipe(
    Effect.mapError((error) =>
      StorageError.of(new AggregateError([failure, error.cause], "SQLite transaction failed and rollback failed")),
    ),
  )

/** Opens or creates the database at `path` (or `:memory:`) in WAL mode with synchronous `NORMAL`. */
export function openSqliteDatabase(
  path: string,
  options: SqliteDatabaseOptions = {},
): Effect.Effect<BunSqliteDatabase, StorageError> {
  return call(() => {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    const database = new Database(path, { create: true })
    try {
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      database.exec("PRAGMA journal_mode = WAL")
      database.exec("PRAGMA synchronous = NORMAL")
      database.exec(
        `PRAGMA wal_autocheckpoint = ${options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES}`,
      )
    } catch (error) {
      database.close()
      throw error
    }
    return new BunSqliteDatabase(database)
  })
}
