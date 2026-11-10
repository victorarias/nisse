// The kernel's Effect Storage over a Promise-and-Context Storage the suite passes, such as MemoryStorage or a test
// double: a rejection is a kernel StorageError carrying it, the upstream StorageRequestError the kernel's class, and a
// refused batch a CommitRefused carrying the refusal.
import { Effect } from "effect";
import {
	CommitRefused,
	type Storage as KernelStorage,
	StorageError,
	StorageRequestError,
} from "../../../../../kernel/src/index.ts";
import { BACKGROUND_CONTEXT } from "../../../chord/src/context/index.ts";
import { errorMessage, StorageRequestError as UpstreamRequestError } from "../errors.ts";
import { SqliteStorage } from "../storage/sqlite/storage.ts";
import type { Storage } from "../types.ts";

const context = BACKGROUND_CONTEXT;

const call = <A>(promise: () => Promise<A>): Effect.Effect<A, StorageError> =>
	Effect.tryPromise({ try: promise, catch: (error) => StorageError.of(error) });

/** A read: the upstream request error fails only that read. */
const read = <A>(promise: () => Promise<A>): Effect.Effect<A, StorageError | StorageRequestError> =>
	Effect.tryPromise({
		try: promise,
		catch: (error) =>
			error instanceof UpstreamRequestError
				? new StorageRequestError({ message: error.message })
				: StorageError.of(error),
	});

/** The kernel Storage behind `storage`: the kernel's own SQLite storage unwrapped, any other bridged call by call. */
export function kernelStorage(storage: Storage): KernelStorage {
	if (storage instanceof SqliteStorage) return storage.kernel;
	return {
		commit: (batches, receive) =>
			Effect.map(
				call(() => storage.commit(batches as never, receive, context)),
				// A refusal may be any value, `undefined` included: what was not stored says a batch was refused.
				(result) =>
					result.stored === batches.length
						? { stored: result.stored }
						: {
								stored: result.stored,
								refused: new CommitRefused({ message: errorMessage(result.refused), cause: result.refused }),
							},
			),
		mintId: () => call(() => storage.mintId()),
		conversation: (id) => call(() => storage.conversation(id as never, context)),
		scanConversations: (query, limit, cursor) =>
			read(() => storage.scanConversations(query as never, limit, cursor, context)) as never,
		entry: ((first: never, second?: never) =>
			second === undefined
				? read(() => storage.entry(first, context))
				: read(() => storage.entry(first, second, context))) as KernelStorage["entry"],
		findLatestHeadMarker: (conversationId, at) =>
			read(() => storage.findLatestHeadMarker(conversationId as never, at as never, context)) as never,
		scanEntries: (query, limit, cursor) => read(() => storage.scanEntries(query as never, limit, cursor, context)) as never,
		task: (id) => call(() => storage.task(id as never, context)) as never,
		scanTasks: (query, limit, cursor) => read(() => storage.scanTasks(query as never, limit, cursor, context)) as never,
		submission: (id) => call(() => storage.submission(id as never, context)) as never,
		scanSubmissions: (query, limit, cursor) =>
			read(() => storage.scanSubmissions(query as never, limit, cursor, context)) as never,
		submissionByRequest: (conversationId, requestId) =>
			call(() => storage.submissionByRequest(conversationId as never, requestId, context)) as never,
		findDocument: (address, at) => call(() => storage.findDocument(address as never, at as never, context)) as never,
		document: (id, at) => read(() => storage.document(id as never, at as never, context)) as never,
		scanDocuments: (query, limit, cursor) =>
			read(() => storage.scanDocuments(query as never, limit, cursor, context)) as never,
		close: () => call(() => storage.close(context)),
	};
}
