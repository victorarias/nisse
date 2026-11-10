// pi-durable's Promise-and-Context Session over the kernel's Effect Session (packages/kernel). Each call runs the
// kernel's Effect and fails as upstream throws: kernel errors become the upstream classes, defects reject as thrown,
// and an aborted context interrupts the call. What upstream adds around the kernel for hosts stays here: reports, the
// microtask delay of commit observers, observer guards and the Promise watch handle.
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import {
	CommitRefused,
	InvocationEnded,
	makeSession,
	ReadOnlySession as KernelReadOnly,
	type Session as KernelSession,
	SessionClosed,
	SessionFailed as KernelSessionFailed,
	StorageError,
	StorageRequestError as KernelRequestError,
	ReadAfterWrite as KernelReadAfterWrite,
	type Tx as KernelTx,
} from "../../../../../kernel/src/index.ts";
import type { Transaction as KernelTransaction } from "../../../../../kernel/src/session/transaction.ts";
import { BACKGROUND_CONTEXT, type Context, withoutAbortSignal } from "../../../chord/src/context/index.ts";
import type { WatchEnd } from "../../../chord/src/watch.ts";
import {
	errorMessage,
	ReadAfterWrite,
	ReadOnlySession,
	SessionFailed,
	StorageRequestError,
	ConversationBusy,
	ConversationIdle,
} from "../errors.ts";
import { kernelStorage } from "./storage-bridge.ts";

type Any = any;

/** Default document retention: ten minutes. */
let defaultRetention = 600_000;

/** Internal, for tests: the retention of every Session that keeps the default, as a suite run with eviction at once. */
export function setDefaultDocumentRetention(ms: number): void {
	defaultRetention = ms;
}

/** A retention as given when it is a number of milliseconds, `0` or more; otherwise the default. */
export function documentRetention(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : defaultRetention;
}

/** Deferred commits are gone (D5); kept for the suite's imports. */
export function persistWithin(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : 1_000;
}

export function createSession(
	storage: Any,
	options?: { readonly now?: () => number; readonly documentRetentionMs?: number },
): SessionImpl {
	const retention = options?.documentRetentionMs;
	return new SessionImpl(storage, options?.now, retention === undefined ? undefined : () => retention);
}

// Errors

/** The error a kernel failure is as pi-durable throws it. */
export function upstreamError(error: unknown): unknown {
	if (error instanceof InvocationEnded) {
		// pi-durable words a commit refused by close as its Harness's closed error.
		return new Error(error.message.endsWith("the scheduler is closing") ? "Harness is closed" : error.message);
	}
	if (error instanceof StorageError) return error.cause;
	if (error instanceof KernelRequestError) return new StorageRequestError(error.message);
	if (error instanceof KernelSessionFailed) return new SessionFailed(upstreamCause(error.cause));
	if (error instanceof SessionClosed) return new Error("Session is closed");
	if (error instanceof KernelReadOnly) {
		return new ReadOnlySession(error.message.includes("running tasks") ? "running tasks" : "a commit with writes");
	}
	if (error instanceof CommitRefused) return refusal(error);
	// The harness's admission refusals, by tag: the session module does not import the harness.
	const tag = (error as { _tag?: unknown } | null)?._tag;
	if (tag === "ConversationBusy") return new ConversationBusy((error as { conversationId: never }).conversationId);
	if (tag === "ConversationIdle") return new ConversationIdle((error as { conversationId: never }).conversationId);
	if (error instanceof KernelReadAfterWrite) {
		const operation = /^(.+?) reads a table after/.exec(error.message)?.[1] ?? "Tx";
		return new ReadAfterWrite(operation);
	}
	return error;
}

/** What failed a kernel Session, as upstream records it: the storage's own error. */
export function upstreamCause(cause: unknown): unknown {
	if (cause instanceof StorageError) return cause.cause;
	if (cause instanceof CommitRefused) return refusal(cause);
	return cause;
}

/** What a storage refused a batch with, `undefined` and `null` included. */
function refusal(error: CommitRefused): unknown {
	return "cause" in error ? error.cause : new Error(error.message);
}

function rejection(cause: Cause.Cause<unknown>, context: Context | undefined): unknown {
	const reason = cause.reasons[0];
	if (reason?._tag === "Fail") return upstreamError(reason.error);
	if (reason?._tag === "Die") return upstreamError(reason.defect);
	const signal = context?.abortSignal;
	if (signal?.aborted) return signal.reason ?? new Error("aborted");
	return new Error("interrupted");
}

/** Runs a kernel Effect as a Promise; aborting `context` interrupts it. */
export function run<A>(effect: Effect.Effect<A, unknown>, context?: Context): Promise<A> {
	const signal = context?.abortSignal;
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
	return new Promise<A>((resolve, reject) => {
		const fiber = Effect.runFork(effect);
		const abort = (): void => void Effect.runFork(Fiber.interrupt(fiber));
		signal?.addEventListener("abort", abort, { once: true });
		fiber.addObserver((exit) => {
			signal?.removeEventListener("abort", abort);
			if (Exit.isSuccess(exit)) resolve(exit.value);
			else reject(rejection(exit.cause, context));
		});
	});
}

/** Runs a synchronous kernel Effect, throwing as upstream does. */
export function runSync<A>(effect: Effect.Effect<A, unknown>): A {
	const exit = Effect.runSyncExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	throw rejection(exit.cause, undefined);
}

/** The kernel failure of a callback's rejection: the rejection itself, so it passes through unchanged. */
export class CallbackFailed {
	constructor(readonly error: unknown) {}
}

// Transactions

/** A transaction operation's promise: its rejection is observed even when the callback never awaits it. */
function observed<A>(promise: Promise<A>): Promise<A> {
	promise.catch(() => {});
	return promise;
}

/** pi-durable's Promise Tx over a kernel Tx. */
export class Transaction {
	readonly #tx: KernelTx;
	constructor(tx: KernelTx) {
		this.#tx = tx;
	}
	/** Internal: the kernel Tx, for later children's adapters. */
	get kernel(): KernelTx {
		return this.#tx;
	}
	conversation(id: Any) {
		return observed(run(this.#tx.conversation(id)));
	}
	entry(first: Any, second?: Any) {
		return observed(run(second === undefined ? this.#tx.entry(first) : this.#tx.entry(first, second)));
	}
	task(id: Any) {
		return observed(run(this.#tx.task(id)));
	}
	scanConversations(query: Any, limit: number, cursor?: Any) {
		return observed(run(this.#tx.scanConversations(query, limit, cursor)));
	}
	scanEntries(query: Any, limit: number, cursor?: Any) {
		return observed(run(this.#tx.scanEntries(query, limit, cursor)));
	}
	scanTasks(query: Any, limit: number, cursor?: Any) {
		return observed(run(this.#tx.scanTasks(query, limit, cursor)));
	}
	submission(id: Any) {
		return observed(run(this.#tx.submission(id)));
	}
	submissionByRequest(conversationId: Any, requestId: string) {
		return observed(run(this.#tx.submissionByRequest(conversationId, requestId)));
	}
	latestHeadMarker(conversationId: Any) {
		return observed(run(this.#tx.latestHeadMarker(conversationId)));
	}
	latestEntryId(conversationId: Any) {
		return observed(run(this.#tx.latestEntryId(conversationId)));
	}
	createConversation(options: Any) {
		return observed(run(this.#tx.createConversation(options)));
	}
	forkConversation(parent: Any, at: Any, options: Any) {
		return observed(run(this.#tx.forkConversation(parent, at, options)));
	}
	appendEntry(first: Any, second: Any, third?: Any) {
		return observed(run(third === undefined ? this.#tx.appendEntry(first, second) : this.#tx.appendEntry(first, second, third)));
	}
	createTask(task: Any, input: Any, options: Any) {
		return observed(run(this.#tx.createTask(task, input, options)));
	}
	/** Internal: the scheduler's whole-record replacement; throws as upstream does. */
	setTask(value: Any): void {
		(this.#tx as KernelTransaction).setTask(value);
	}
	createSubmission(create: Any) {
		return observed(run(this.#tx.createSubmission(create)));
	}
	settleSubmission(id: Any, settlement: Any): void {
		runSync(this.#tx.settleSubmission(id, settlement));
	}
	placeSubmission(id: Any, entry: Any): void {
		runSync(this.#tx.placeSubmission(id, entry));
	}
	doc(token: Any, ...args: Any[]) {
		return observed(run((this.#tx.doc as Any)(token, ...args)));
	}
	retireDoc(token: Any, ...args: Any[]) {
		return observed(run((this.#tx.retireDoc as Any)(token, ...args)));
	}
}

/** Deferred commits are gone (D5). */
export const storeHeld = (): never => {
	throw new Error("conformance adapter: deferred commits are removed (D5)");
};

// Observer guards, as upstream exports them

export function contained(callback: () => unknown, onError: (error: unknown) => void): void {
	try {
		const result = callback();
		if (typeof (result as { then?: unknown } | null)?.then === "function") Promise.resolve(result).catch(onError);
	} catch (error) {
		onError(error);
	}
}

type SyncObserver<A> = { advance(call: A, context: Context): void; end(end: WatchEnd): void };
export type GuardedObserver<A> = SyncObserver<A> & { detach(): void };

/**
 * `observer` behind the rule for observers that run at a publication: one that throws, or whose `advance` returns a
 * promise that rejects, is reported, detached and ended `listener_error`; nothing reaches it after its detach or end.
 */
export function guardObserver<A>(
	observer: SyncObserver<A>,
	detach: () => void,
	report: (error: unknown, context?: Context) => void,
): GuardedObserver<A> {
	type Attached = { readonly observer: SyncObserver<A>; readonly detach: () => void; readonly report: typeof report };
	let attached: Attached | undefined = { observer, detach, report };
	const release = (): Attached | undefined => {
		const released = attached;
		attached = undefined;
		released?.detach();
		return released;
	};
	const fault = (current: Attached, error: unknown, context: Context): void => {
		current.report(error, context);
		if (release() !== undefined) {
			const end: WatchEnd = { kind: "listener_error", error: toError(error) };
			contained(() => current.observer.end(end), current.report);
		}
	};
	return {
		advance: (call, context) => {
			const current = attached;
			if (current === undefined) return;
			try {
				const result: unknown = current.observer.advance(call, context);
				if (typeof (result as { then?: unknown } | null)?.then === "function") {
					Promise.resolve(result).catch((error: unknown) => fault(current, error, context));
				}
			} catch (error) {
				fault(current, error, context);
			}
		},
		end: (end) => {
			const ending = release();
			if (ending !== undefined) contained(() => ending.observer.end(end), ending.report);
		},
		detach: () => {
			release();
		},
	};
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	try {
		return new Error(String(error));
	} catch {
		return new Error(Object.prototype.toString.call(error));
	}
}

export const ENDED: WatchEnd = { kind: "ended" };

/** How a close ends what follows the Session: a watch `ended`, an observer `failed` with "session closed". */
export function closeEnds(failure: { readonly error: unknown } | undefined): {
	readonly watch: WatchEnd;
	readonly observer: WatchEnd;
} {
	if (failure !== undefined) {
		const failed: WatchEnd = { kind: "failed", error: failure.error };
		return { watch: failed, observer: failed };
	}
	return { watch: ENDED, observer: { kind: "failed", error: new Error("session closed") } };
}

export function closeEndOf(follower: unknown, ends: ReturnType<typeof closeEnds>): WatchEnd {
	return follower instanceof DocumentWatchHandle ? ends.watch : ends.observer;
}

export function observation<T>(value: T, guarded: { detach(): void }): { readonly value: T; detach(): void } {
	return { value, detach: () => guarded.detach() };
}

// The watch handle

type Listener = (call: Any, context: Context) => Promise<void>;

/**
 * Chord's WatchHandle over a kernel document watch: the kernel folds what waits while the listener runs, and this
 * handle serializes the listener and owns the watch's end.
 */
class DocumentWatchHandle {
	#value: Any;
	readonly #closed = Promise.withResolvers<WatchEnd>();
	#scope: Scope.Closeable | undefined;
	#changes: Stream.Stream<Any, unknown> | undefined;
	#fiber: Fiber.Fiber<void, unknown> | undefined;
	#started = false;
	#end: WatchEnd | undefined;
	#report: ((error: unknown) => void) | undefined;
	#unsubscribe: (() => void) | undefined;
	#abort: { readonly signal: AbortSignal; readonly listener: () => void } | undefined;

	constructor(
		value: Any,
		changes: Stream.Stream<Any, unknown>,
		scope: Scope.Closeable,
		report: (error: unknown) => void,
	) {
		this.#value = value;
		this.#changes = changes;
		this.#scope = scope;
		this.#report = report;
	}

	get value(): Any {
		return this.#value;
	}

	get closed(): Promise<WatchEnd> {
		return this.#closed.promise;
	}

	/** Internal: ends the watch at the Session's close. */
	followClose(subscribe: (end: () => void) => () => void, endOf: () => WatchEnd): void {
		this.#unsubscribe = subscribe(() => this.terminate(endOf()));
	}

	observeAbort(signal: AbortSignal): void {
		if (this.#end !== undefined) return;
		const listener = () => this.terminate({ kind: "aborted" });
		this.#abort = { signal, listener };
		signal.addEventListener("abort", listener, { once: true });
		if (signal.aborted) listener();
	}

	start(listener: Listener): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#end !== undefined) throw new Error("Watch is stopped");
		this.#started = true;
		const changes = this.#changes!;
		// Never inline: the first call comes from a later task.
		queueMicrotask(() => {
			if (this.#end !== undefined) return;
			this.#fiber = Effect.runFork(
				Stream.runForEach(changes, (call) =>
					Effect.suspend(() => {
						this.#value = call.value;
						return Effect.tryPromise({
							try: () => listener({ kind: "value", ...call }, withoutAbortSignal(BACKGROUND_CONTEXT)),
							catch: (error) => new ListenerFailed(error),
						});
					}),
				),
			);
			this.#fiber.addObserver((exit) => {
				if (Exit.isSuccess(exit)) return this.terminate(ENDED);
				const reason = exit.cause.reasons[0];
				if (reason?._tag === "Fail" && reason.error instanceof ListenerFailed) {
					if (this.#end === undefined) this.#report?.(reason.error.error);
					return this.terminate({ kind: "listener_error", error: toError(reason.error.error) });
				}
				if (reason?._tag === "Fail" && reason.error instanceof KernelSessionFailed) {
					return this.terminate({ kind: "failed", error: upstreamCause(reason.error.cause) });
				}
				if (reason?._tag === "Die") return this.terminate({ kind: "failed", error: reason.defect });
			});
		});
	}

	stop(): Promise<WatchEnd> {
		this.terminate({ kind: "stopped" });
		return this.#closed.promise;
	}

	/** Ends once: detaches, drops every reference into the source, and settles `closed`. A running callback goes on. */
	terminate(end: WatchEnd): void {
		if (this.#end !== undefined) return;
		this.#end = end;
		const fiber = this.#fiber;
		const scope = this.#scope;
		this.#fiber = undefined;
		this.#scope = undefined;
		this.#changes = undefined;
		this.#report = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (this.#abort !== undefined) this.#abort.signal.removeEventListener("abort", this.#abort.listener);
		this.#abort = undefined;
		if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
		if (scope !== undefined) Effect.runFork(Scope.close(scope, Exit.void));
		this.#closed.resolve(end);
	}
}

class ListenerFailed {
	constructor(readonly error: unknown) {}
}

// The Session

/**
 * pi-durable's Session over a kernel Session. `now` and `documentRetentionMs` feed the kernel's document cache; the
 * other constructor arguments belong to removed features (D5) or later children.
 */
export class SessionImpl {
	readonly #kernel: KernelSession;
	readonly #storage: Any;
	readonly #closeListeners = new Set<() => void>();
	#closing: Promise<void> | undefined;
	#hostObservers: Set<GuardedObserver<Any>> | undefined;
	/** Calls on the line whose outcome is not delivered yet. */
	#outstanding = 0;
	#reads = 0;

	constructor(
		storage: Any,
		now: () => number = Date.now,
		documentRetentionMs: () => number | undefined = () => undefined,
		_setTimer?: unknown,
		readOnly = false,
		/** A kernel Session opened over `storage` already, such as a Harness's. */
		kernel?: KernelSession,
	) {
		this.#storage = storage;
		this.#kernel =
			kernel ??
			Effect.runSync(
				makeSession(kernelStorage(storage), {
					readOnly,
					now,
					documentRetentionMs: () => documentRetention(documentRetentionMs()),
				}),
			);
		this.#kernel.subscribeClose(() => {
			const listeners = [...this.#closeListeners];
			this.#closeListeners.clear();
			for (const listener of listeners) contained(listener, (error) => this.report(error));
		});
	}

	/** Internal: the kernel Session, for later children's adapters. */
	get kernel(): KernelSession {
		return this.#kernel;
	}

	get failure(): { readonly error: unknown } | undefined {
		const failure = this.#kernel.failure;
		return failure === undefined ? undefined : { error: upstreamCause(failure.error) };
	}

	get closed(): Promise<Any> {
		return run(
			Effect.map(this.#kernel.closed, (end) =>
				end.kind === "failed" ? { kind: "failed", error: upstreamCause(end.error) } : end,
			),
		);
	}

	/**
	 * Internal, for tests that bound memory: calls on the line without an outcome yet. The kernel publishes each commit
	 * before its outcome and keeps no read cache, so nothing is ever unpublished or read in flight between jobs.
	 */
	/**
	 * Upstream's line counters, measured at this boundary: calls not yet settled, and of them the reads. The kernel
	 * publishes a commit in the line job that stores it, with no group commit (D5), so none is ever stored unpublished.
	 */
	get lineSizes() {
		return { outstanding: this.#outstanding, unpublished: 0, reads: this.#reads };
	}

	get documentCacheSizes() {
		return { ...this.#kernel.documentCacheSizes, sweeps: 0, held: 0, taskDocuments: 0, tails: 0 };
	}

	/** Internal: listener errors and the like; a plain Session drops them. */
	report(_error: unknown, _info: Any = { kind: "listener_error" }, _context?: Context): void {}

	assertUsable(): void {
		const failure = this.failure;
		if (failure !== undefined) throw new SessionFailed(failure.error);
		if (this.#closing !== undefined) throw new Error("Session is closed");
	}

	commit<T>(change: (tx: Any) => T | Promise<T>, context: Context = BACKGROUND_CONTEXT, _options?: unknown): Promise<T> {
		return this.commitWith(change, context);
	}

	commitWith<T>(change: (tx: Any) => T | Promise<T>, context: Context = BACKGROUND_CONTEXT, _scope?: unknown): Promise<T> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		const commit = this.#kernel.commit((tx) =>
			Effect.tryPromise({
				try: async () => change(new Transaction(tx)),
				catch: (error) => new CallbackFailed(error),
			}),
		);
		return this.#counted(run(commit, context)).catch((error: unknown) => {
			throw error instanceof CallbackFailed ? error.error : error;
		});
	}

	snapshot(token: Any, ...args: Any[]): Promise<Any> {
		const [address, context] = split(token, args, 0);
		return this.#read((this.#kernel.snapshot as Any)(token, ...address), context);
	}

	snapshotAsOf(token: Any, ...args: Any[]): Promise<Any> {
		const [address, context] = split(token, args, 1);
		return this.#read((this.#kernel.snapshotAsOf as Any)(token, ...address), context);
	}

	observeDoc(token: Any, ...args: Any[]): Promise<Any> {
		const [address, context, observer] = split(token, args, 0, true);
		// The kernel detaches an observer that throws or rejects and ends it `listener_error`; the host also reports it.
		const kernelObserver = {
			advance: (change: Any) => observer.advance({ kind: "value", ...change }, BACKGROUND_CONTEXT),
			end: (end: Any) => {
				if (end.kind === "listener_error") this.report(end.error, { kind: "listener_error" }, BACKGROUND_CONTEXT);
				contained(
					() => observer.end(end.kind === "ended" ? closeEnds(undefined).observer : observerEnd(end)),
					(error) => this.report(error, { kind: "listener_error" }),
				);
			},
		};
		return this.#read((this.#kernel.observeDoc as Any)(token, ...address, kernelObserver), context);
	}

	watchDoc(token: Any, ...args: Any[]): Promise<Any> {
		const [address, context] = split(token, args, 0);
		return this.watchWith((this.#kernel.watchDoc as Any)(token, ...address), context);
	}

	/** Internal: upstream's watch handle over a kernel watch `acquire` makes in a scope the handle's stop closes. */
	watchWith(acquire: Effect.Effect<Any, unknown, Scope.Scope>, context: Context | undefined): Promise<Any> {
		let scope: Scope.Closeable | undefined;
		return this.#read(
			Effect.gen(function* () {
				scope = yield* Scope.make();
				return yield* Scope.provide(scope)(acquire);
			}) as Effect.Effect<Any, unknown>,
			context,
		).then(
			(watch: Any) => {
				if (watch === undefined) {
					if (scope !== undefined) Effect.runFork(Scope.close(scope, Exit.void));
					return undefined;
				}
				const handle = new DocumentWatchHandle(watch.value, watch.changes, scope!, (error) => this.report(error));
				handle.followClose(
					(end) => this.#kernel.subscribeClose(end),
					() => closeEnds(this.failure).watch,
				);
				const signal = context?.abortSignal;
				if (signal !== undefined) handle.observeAbort(signal);
				return handle;
			},
			(error: unknown) => {
				if (scope !== undefined) Effect.runFork(Scope.close(scope, Exit.void));
				throw error;
			},
		);
	}

	/** Internal: runs `job` on the line with the suite's Storage, between commits. */
	readOnLine<T>(job: (storage: Any) => Promise<T>): Promise<T> {
		return this.#read(
			this.#kernel.read(() =>
				Effect.tryPromise({ try: () => job(this.#storage), catch: (error) => new CallbackFailed(error) }),
			),
			undefined,
		).catch((error: unknown) => {
			throw error instanceof CallbackFailed ? error.error : error;
		});
	}

	unloadDocuments(): Promise<void> {
		return run(this.#kernel.unloadDocuments);
	}

	/**
	 * Host commit observers run one microtask after the publication, as upstream calls them: those attached when that
	 * microtask runs.
	 */
	observeCommits(observer: Any): { detach(): void } {
		this.assertUsable();
		if (this.#hostObservers === undefined) {
			const observers = new Set<GuardedObserver<Any>>();
			this.#hostObservers = observers;
			this.#kernel.observeCommits({
				advance: (publication) =>
					void queueMicrotask(() => {
						for (const guarded of [...observers]) guarded.advance(publication, BACKGROUND_CONTEXT);
					}),
				// After the last publication's dispatch, which is a microtask behind it.
				end: (end) =>
					void queueMicrotask(() => {
						const ending = end.kind === "ended" ? closeEnds(undefined).observer : observerEnd(end);
						const all = [...observers];
						observers.clear();
						for (const guarded of all) guarded.end(ending);
					}),
			});
		}
		const observers = this.#hostObservers;
		const guarded = guardObserver<Any>(
			observer,
			() => observers.delete(guarded),
			(error, ctx) => this.report(error, { kind: "listener_error" }, ctx),
		);
		observers.add(guarded);
		return { detach: () => guarded.detach() };
	}

	/** Internal: follows every stored commit synchronously at its publication. */
	followCommits(listener: (publication: Any, context: Context) => void): () => void {
		this.assertUsable();
		const observation = this.#kernel.observeCommits({
			advance: (publication) => {
				try {
					listener({ kind: "stored", ...publication }, BACKGROUND_CONTEXT);
				} catch (error) {
					// The kernel detaches a throwing observer silently; the host also reports it.
					this.report(error, { kind: "listener_error" }, BACKGROUND_CONTEXT);
					throw error;
				}
			},
			end: () => {},
		});
		return () => observation.detach();
	}

	subscribeClose(listener: () => void): () => void {
		this.assertUsable();
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		this.#closing ??= run(this.#kernel.close);
		return this.#closing;
	}

	/** A read of the kernel Session, refused as upstream refuses once the Session failed or closed. */
	#read<A>(effect: Effect.Effect<A, unknown>, context: Context | undefined): Promise<A> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		this.#reads++;
		const promise = this.#counted(run(effect, context));
		const settle = () => void this.#reads--;
		promise.then(settle, settle);
		return promise;
	}

	#counted<A>(promise: Promise<A>): Promise<A> {
		this.#outstanding++;
		const settle = () => void this.#outstanding--;
		promise.then(settle, settle);
		return promise;
	}
}

function observerEnd(end: Any): WatchEnd {
	if (end.kind === "failed") return { kind: "failed", error: upstreamCause(end.error) };
	if (end.kind === "listener_error") return { kind: "listener_error", error: toError(end.error) };
	return end;
}

/**
 * Splits upstream's overloaded arguments: the address the token needs and `extra` arguments after it (an entry ID),
 * then the observer when `observed`, then the context.
 */
function split(token: Any, args: readonly Any[], extra: number, observed = false): [Any[], Context | undefined, Any] {
	const definition = token.definition;
	const owner = definition.scope === "session" ? 0 : 1;
	const length = owner + (definition.family === true ? 1 : 0) + extra;
	const address = args.slice(0, length);
	const observer = observed ? args[length] : undefined;
	const context = args[observed ? length + 1 : length] as Context | undefined;
	return [address, context, observer];
}

export { errorMessage };
