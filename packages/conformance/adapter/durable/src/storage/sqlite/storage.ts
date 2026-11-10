// pi-durable's Promise-and-Context SqliteStorage over the kernel's Effect SqliteStorage. Contexts are ignored, as
// upstream's SQLite storage ignores them.
import { Effect } from "effect";
import {
	SqliteStorage as KernelStorage,
	StorageError,
	StorageRequestError,
	type SqliteDatabase,
} from "../../../../../../kernel/src/index.ts";
import { NodeSqliteDatabase } from "../../../../chord/src/sqlite/node.ts";
import { run } from "../../../../kernel.ts";
import { StorageRequestError as UpstreamRequestError } from "../../errors.ts";

type PromiseExecutor = {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: unknown[]): Promise<void>;
	runCounted(sql: string, ...params: unknown[]): Promise<number>;
	get(sql: string, ...params: unknown[]): Promise<unknown>;
	all(sql: string, ...params: unknown[]): Promise<unknown[]>;
};
type PromiseDatabase = PromiseExecutor & {
	transaction<T>(callback: (transaction: PromiseExecutor) => Promise<T>): Promise<T>;
	close(): Promise<void>;
};

// A kernel failure passes through a Promise database as itself; anything else the database throws is its own failure.
const failure = (error: unknown) =>
	error instanceof StorageError || error instanceof StorageRequestError ? error : StorageError.of(error);

const kernelExecutor = (executor: PromiseExecutor) => ({
	exec: (sql: string) => Effect.tryPromise({ try: () => executor.exec(sql), catch: failure }),
	run: (sql: string, ...params: unknown[]) => Effect.tryPromise({ try: () => executor.run(sql, ...params), catch: failure }),
	runCounted: (sql: string, ...params: unknown[]) =>
		Effect.tryPromise({ try: () => executor.runCounted(sql, ...params), catch: failure }),
	get: (sql: string, ...params: unknown[]) => Effect.tryPromise({ try: () => executor.get(sql, ...params), catch: failure }),
	all: (sql: string, ...params: unknown[]) => Effect.tryPromise({ try: () => executor.all(sql, ...params), catch: failure }),
});

/** The kernel facade of a database the suite passes: the kernel's own one unwrapped, any other bridged. */
export function kernelDatabase(database: PromiseDatabase): SqliteDatabase {
	if (database instanceof NodeSqliteDatabase) return database.kernel;
	return {
		...kernelExecutor(database),
		transaction: (body: (transaction: never) => Effect.Effect<unknown, unknown>) =>
			Effect.tryPromise({
				try: () => database.transaction((transaction) => Effect.runPromise(body(kernelExecutor(transaction) as never))),
				catch: failure,
			}),
		close: () => Effect.tryPromise({ try: () => database.close(), catch: failure }),
	} as unknown as SqliteDatabase;
}

export class SqliteStorage {
	readonly #kernel: KernelStorage;
	#closing: Promise<void> | undefined;

	private constructor(kernel: KernelStorage) {
		this.#kernel = kernel;
	}

	/** The kernel storage behind it, which a Session uses directly. */
	get kernel(): KernelStorage {
		return this.#kernel;
	}

	static async open(database: PromiseDatabase, options: { readonly prefix?: string } = {}): Promise<SqliteStorage> {
		if (options.prefix !== undefined) throw new Error("conformance adapter: the table prefix is removed (D5)");
		return new SqliteStorage(await run(KernelStorage.open(kernelDatabase(database))));
	}

	/** A refusal is a plain Error, as upstream's storage refuses. */
	async commit(batches: never, receive: (index: number, seq: never) => void, _context?: unknown) {
		const result = await run(this.#kernel.commit(batches, receive));
		if (result.refused === undefined) return result;
		const { message, cause } = result.refused;
		return { stored: result.stored, refused: new Error(message, cause === undefined ? undefined : { cause }) };
	}
	mintId() {
		return run(this.#kernel.mintId());
	}
	conversation(id: never, _context?: unknown) {
		return run(this.#kernel.conversation(id));
	}
	scanConversations(query: never, limit: number, cursor: never, _context?: unknown) {
		return run(this.#kernel.scanConversations(query, limit, cursor));
	}
	entry(first: never, second: unknown, context?: unknown) {
		if (context === undefined) return run(this.#kernel.entry(first));
		if (typeof second !== "number") {
			return Promise.reject(new UpstreamRequestError("Storage.entry() requires an entry ID"));
		}
		return run(this.#kernel.entry(first, second as never));
	}
	findLatestHeadMarker(conversationId: never, atOrBeforeEntryId: never, _context?: unknown) {
		return run(this.#kernel.findLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}
	scanEntries(query: never, limit: number, cursor: never, _context?: unknown) {
		return run(this.#kernel.scanEntries(query, limit, cursor));
	}
	task(id: never, _context?: unknown) {
		return run(this.#kernel.task(id));
	}
	scanTasks(query: never, limit: number, cursor: never, _context?: unknown) {
		return run(this.#kernel.scanTasks(query, limit, cursor));
	}
	submission(id: never, _context?: unknown) {
		return run(this.#kernel.submission(id));
	}
	scanSubmissions(query: never, limit: number, cursor: never, _context?: unknown) {
		return run(this.#kernel.scanSubmissions(query, limit, cursor));
	}
	submissionByRequest(conversationId: never, requestId: string, _context?: unknown) {
		return run(this.#kernel.submissionByRequest(conversationId, requestId));
	}
	findDocument(address: never, at: never, _context?: unknown) {
		return run(this.#kernel.findDocument(address, at));
	}
	document(id: never, at: never, _context?: unknown) {
		return run(this.#kernel.document(id, at));
	}
	scanDocuments(query: never, limit: number, cursor: never, _context?: unknown) {
		return run(this.#kernel.scanDocuments(query, limit, cursor));
	}
	/** Closing again returns the same promise. */
	close(_context?: unknown): Promise<void> {
		this.#closing ??= run(this.#kernel.close());
		return this.#closing;
	}
}
