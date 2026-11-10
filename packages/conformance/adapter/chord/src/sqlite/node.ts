// chord's Promise-shaped SQLite database over the kernel's facade. `SqliteStorage.open` unwraps it, so storage runs on
// the kernel's own facade; any other database the suite passes, such as a test double, goes through a bridge.
import { Effect } from "effect";
import { BunSqliteDatabase, openSqliteDatabase, type SqliteExecutor } from "../../../../../kernel/src/index.ts";
import { run } from "../../../kernel.ts";

/** A chord executor over a kernel executor. */
export function promiseExecutor(executor: SqliteExecutor) {
	return {
		exec: (sql: string) => run(executor.exec(sql)),
		run: (sql: string, ...params: unknown[]) => run(executor.run(sql, ...(params as never[]))),
		runCounted: (sql: string, ...params: unknown[]) => run(executor.runCounted(sql, ...(params as never[]))),
		get: (sql: string, ...params: unknown[]) => run(executor.get(sql, ...(params as never[]))),
		all: (sql: string, ...params: unknown[]) => run(executor.all(sql, ...(params as never[]))),
	};
}

export class NodeSqliteDatabase {
	/** The kernel database this wraps. */
	readonly kernel: BunSqliteDatabase;
	// chord's contract: calls on the database wait for a transaction underway, whose callback may suspend.
	#tail: Promise<unknown> = Promise.resolve();

	/** Takes a `bun:sqlite` or `node:sqlite` connection, or a kernel database. */
	constructor(connection: unknown) {
		this.kernel = connection instanceof BunSqliteDatabase ? connection : new BunSqliteDatabase(connection as never);
	}

	exec(sql: string) {
		return this.#queue(() => promiseExecutor(this.kernel).exec(sql));
	}
	run(sql: string, ...params: unknown[]) {
		return this.#queue(() => promiseExecutor(this.kernel).run(sql, ...params));
	}
	runCounted(sql: string, ...params: unknown[]) {
		return this.#queue(() => promiseExecutor(this.kernel).runCounted(sql, ...params));
	}
	get(sql: string, ...params: unknown[]) {
		return this.#queue(() => promiseExecutor(this.kernel).get(sql, ...params));
	}
	all(sql: string, ...params: unknown[]) {
		return this.#queue(() => promiseExecutor(this.kernel).all(sql, ...params));
	}
	transaction<T>(callback: (transaction: ReturnType<typeof promiseExecutor>) => Promise<T>): Promise<T> {
		return this.#queue(() =>
			run(
				this.kernel.transaction((transaction) =>
					// The callback's own rejection, as it rejected.
					Effect.tryPromise({ try: () => callback(promiseExecutor(transaction)), catch: (error) => error }),
				),
			),
		);
	}
	close() {
		return this.#queue(() => run(this.kernel.close()));
	}

	#queue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

export async function openNodeSqliteDatabase(
	path: string,
	options: { readonly walAutoCheckpointPages?: number; readonly mode?: string; readonly busyTimeoutMs?: number } = {},
): Promise<NodeSqliteDatabase> {
	if (options.mode !== undefined || options.busyTimeoutMs !== undefined) {
		throw new Error("conformance adapter: the kernel's SQLite database has no mode or busyTimeoutMs option");
	}
	const walAutoCheckpointPages = options.walAutoCheckpointPages;
	return new NodeSqliteDatabase(
		await run(openSqliteDatabase(path, walAutoCheckpointPages === undefined ? {} : { walAutoCheckpointPages })),
	);
}
