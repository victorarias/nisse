// Replaces chord/src/sqlite/node.ts: the same SqliteDatabase contract over bun:sqlite. Names stay `Node*` so durable's
// storage/sqlite/node.ts compiles unchanged.
import { Database, type Statement } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";

export type NodeSqliteMode = "read-write" | "read-only";
export type NodeSqliteDatabaseOptions = {
	readonly mode?: NodeSqliteMode;
	readonly walAutoCheckpointPages?: number;
	readonly busyTimeoutMs?: number;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATEMENT_CACHE_LIMIT = 256;
const ignore = (): void => {};

class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	run<T>(operation: () => T): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		this.pending++;
		const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
		this.tail = barrier;
		let started: Promise<T>;
		try {
			started = operation();
		} catch (error) {
			started = Promise.reject(error);
		}
		return started.finally(() => {
			this.pending--;
			releaseBarrier();
		});
	}

	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		this.pending++;
		return this.release(this.tail.then(operation));
	}

	private release<T>(operation: Promise<T>): Promise<T> {
		const settled = operation.finally(() => {
			this.pending--;
		});
		this.tail = settled.then(ignore, ignore);
		return settled;
	}
}

abstract class BunSqliteExecutor implements SqliteExecutor {
	protected readonly database: Database;
	protected readonly statements: Map<string, Statement>;

	constructor(database: Database, statements: Map<string, Statement>) {
		this.database = database;
		this.statements = statements;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement(sql).run(...params);
		});
	}

	runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		return this.runOperation(() => Number(this.statement(sql).run(...params).changes));
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => (this.statement(sql).get(...params) ?? undefined) as T | undefined);
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement(sql).all(...params) as T[]);
	}

	protected abstract runOperation<T>(operation: () => T): Promise<T>;

	private statement(sql: string): Statement {
		const statements = this.statements;
		let statement = statements.get(sql);
		if (statement !== undefined) {
			if (statements.size > STATEMENT_CACHE_LIMIT / 2) {
				statements.delete(sql);
				statements.set(sql, statement);
			}
			return statement;
		}
		statement = this.database.prepare(sql);
		statements.set(sql, statement);
		if (statements.size > STATEMENT_CACHE_LIMIT) {
			const oldest = statements.keys().next().value!;
			statements.get(oldest)?.finalize?.();
			statements.delete(oldest);
		}
		return statement;
	}
}

type TransactionScope = { active: boolean };

class BunSqliteTransaction extends BunSqliteExecutor {
	private readonly scope: TransactionScope;
	constructor(database: Database, statements: Map<string, Statement>, scope: TransactionScope) {
		super(database, statements);
		this.scope = scope;
	}
	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

export class NodeSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private readonly mode: NodeSqliteMode;
	private closed = false;

	constructor(database: Database, mode: NodeSqliteMode = "read-write") {
		super(database, new Map());
		this.mode = mode;
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec(this.mode === "read-only" ? "BEGIN" : "BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			for (const statement of this.statements.values()) statement.finalize?.();
			this.statements.clear();
			try {
				if (this.mode === "read-write") this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
		});
	}

	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

export async function openNodeSqliteDatabase(path: string, options: NodeSqliteDatabaseOptions = {}): Promise<NodeSqliteDatabase> {
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (options.mode === "read-only") {
		const database = new Database(path, { readonly: true });
		database.exec(`PRAGMA busy_timeout = ${timeout}`);
		return new NodeSqliteDatabase(database, "read-only");
	}
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const database = new Database(path, { create: true });
	database.exec(`PRAGMA busy_timeout = ${timeout}`);
	const adapter = new NodeSqliteDatabase(database);
	try {
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		throw error;
	}
}
