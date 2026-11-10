// pi-durable's Promise Harness over @nisse/harness's Effect Harness. The Session part is the adapter's Session over the
// harness's kernel Session; conversations, tasks and the registry are the harness's, with upstream's extension code
// converted at install (`convert.ts`). Submissions, views, usage and compaction belong to later children.
import { Effect } from "effect";
import * as H from "../../../../../harness/src/index.ts";
import { ROOT_CONVERSATION_ID } from "../../../../../kernel/src/index.ts";
import { promiseSeam } from "../../../ai/index.ts";
import { BACKGROUND_CONTEXT, type Context, withoutAbortSignal } from "../../../chord/src/context/index.ts";
import { unimplemented } from "../../../../unimplemented.ts";
import {
	CallbackFailed,
	documentRetention,
	run,
	run as runIn,
	runCommit,
	runSync,
	SessionImpl,
	Transaction,
	upstreamCause,
	upstreamError,
} from "../session/session.ts";
import { kernelStorage } from "../session/storage-bridge.ts";
import {
	callback,
	harnessReader,
	promised,
	signalled,
	unwrap,
	upstreamAgent,
	upstreamHandle,
	upstreamHookApi,
	upstreamSnapshot,
	upstreamSubmission,
	upstreamSubmit,
} from "./convert.ts";

type Any = any;

/** Key of the Harness's internal index-size getter, for tests. */
export const SCHEDULER_INDEX_SIZES = Symbol.for("pi-durable.schedulerIndexSizes");
/** Key of the Harness's internal idle-state getter; the harness keeps no contexts (D14). */
export const SCHEDULER_IDLE_STATE = Symbol.for("pi-durable.schedulerIdleState");

export const DEFAULT_HARNESS_IDENTITY = H.DEFAULT_HARNESS_IDENTITY;

export function safeNow(now: (() => number) | undefined, report: (error: unknown, info: Any) => void): () => number {
	return now === undefined ? Date.now : H.safeNow(now, (error) => report(error, { kind: "host_error", callback: "now" }));
}

const init = (init: Any) =>
	init === undefined
		? undefined
		: (tx: Any, id: Any) => promised(() => init(new Transaction(tx), id));

const createOptions = (options: Any) => ({
	...(options?.ownership === undefined ? {} : { ownership: options.ownership }),
	...(options?.agent === undefined ? {} : { agent: options.agent }),
	...(options?.init === undefined ? {} : { init: init(options.init) }),
});

/** Promise conversation handle over a harness Conversation. */
class ConversationImpl {
	readonly id: Any;
	readonly #conversation: H.Conversation;
	readonly #harness: HarnessImpl;

	constructor(conversation: H.Conversation, harness: HarnessImpl) {
		this.id = conversation.id;
		this.#conversation = conversation;
		this.#harness = harness;
	}

	agent(context: Context) {
		return this.#harness.usable(() => run(this.#conversation.agent, context).then(upstreamAgent));
	}

	configure(change: Any, context: Context) {
		return this.#harness.usable(() => run(this.#conversation.configure(change), context));
	}

	submit(first: Any, second: Any) {
		return this.#harness.usable(() => upstreamSubmit(this.#conversation.submit.bind(this.#conversation) as Any)(first, second));
	}

	compact(instructions: string | undefined, context: Context) {
		return this.#harness.usable(() => run(this.#conversation.compact(instructions), context));
	}

	watch(): never {
		return unimplemented("Conversation.watch", "harness-views")();
	}

	reset(handoff: string | undefined, context: Context) {
		return this.#harness.usable(() => run(this.#conversation.reset(handoff), context));
	}

	commit(change: Any, context: Context) {
		return this.#harness.usable(() =>
			runCommit((returned) => this.#conversation.commit(callback(change, returned)), context).catch(unwrap),
		);
	}

	context(context: Context, options?: { readonly at?: Any }) {
		return this.#harness.usable(() => run(this.#conversation.context(options), context));
	}

	entries(query: Any, limit: number, cursor: Any, context: Context) {
		return this.#harness.usable(() => run(this.#conversation.entries(query, limit, cursor), context));
	}

	fork(at: Any, options: Any, context: Context) {
		return this.#harness.usable(() =>
			run(this.#conversation.fork(at, createOptions(options) as Any), context)
				.catch(unwrap)
				.then((conversation) => new ConversationImpl(conversation, this.#harness)),
		);
	}

	abort(context: Context, options?: { readonly background?: boolean }) {
		return this.#harness.usable(() => run(this.#conversation.abort(options), context));
	}

	waitForIdle(context: Context) {
		return this.#harness.usable(() => run(this.#conversation.waitForIdle, context));
	}
}

/** pi-durable's Harness: the adapter's Session over the harness's kernel Session, plus the harness. */
export class HarnessImpl extends SessionImpl {
	readonly #harness: H.Harness<Any>;
	readonly #options: Any;

	constructor(storage: Any, harness: H.Harness<Any>, options: Any) {
		super(storage, undefined, undefined, undefined, options.readOnly === true, harness.session);
		this.#harness = harness;
		this.#options = options;
	}

	/** Runs `operation` unless the Harness failed or closed, rejecting as upstream does. */
	usable<T>(operation: () => Promise<T>): Promise<T> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return operation();
	}

	override report(error: unknown, info: Any = { kind: "listener_error" }): void {
		hostReport(this.#options, error, info);
	}

	resume(): void {
		this.assertUsable();
		runSync(this.#harness.resume);
	}

	wake(): Any {
		this.assertUsable();
		return this.#harness.wake();
	}

	root(context: Context, options?: Any) {
		return this.usable(() =>
			run(this.#harness.root(createOptions(options) as Any), context)
				.catch(unwrap)
				.then((conversation) => new ConversationImpl(conversation, this)),
		);
	}

	conversation(id: Any, context: Context) {
		return this.usable(() =>
			run(this.#harness.conversation(id), context).then((conversation) =>
				conversation === undefined ? undefined : new ConversationImpl(conversation, this),
			),
		);
	}

	createConversation(options: Any, context: Context) {
		return this.usable(() =>
			run(this.#harness.createConversation(createOptions(options) as Any), context)
				.catch(unwrap)
				.then((conversation) => new ConversationImpl(conversation, this)),
		);
	}

	getTask(id: Any, context: Context) {
		return this.usable(() => run(this.#harness.getTask(id), context));
	}

	abortTask(id: Any, context: Context) {
		return this.usable(() => run(this.#harness.abortTask(id), context));
	}

	waitForTask(id: Any, context: Context) {
		return this.usable(() => run(this.#harness.waitForTask(id), context));
	}

	waitForIdle(context: Context) {
		return this.usable(() => run(this.#harness.waitForIdle, context));
	}

	inspect(context: Context) {
		return this.usable(async () => {
			const { scheduling, tasks, submissions } = await run(this.#harness.inspect, context);
			// The kernel calls a task that can run now `ready`; pi-durable calls it `pending`.
			const upstreamTasks = tasks.map((task: Any) =>
				task.state.kind === "ready" ? { ...task, state: { ...task.state, kind: "pending" } } : task,
			);
			return { scheduling, tasks: upstreamTasks, submissions };
		});
	}

	submission(id: Any, context: Context) {
		return this.usable(() =>
			run(this.#harness.submission(id), context).then((submission) =>
				submission === undefined ? undefined : upstreamSubmission(submission),
			),
		);
	}

	abortSubmission(id: Any, context: Context, conversationId?: Any) {
		return this.usable(() => run(this.#harness.abortSubmission(id, conversationId), context));
	}

	usage(context: Context) {
		return this.usable(() => run(this.#harness.usage, context));
	}

	watchTaskGraph(): never {
		return unimplemented("Harness.watchTaskGraph", "harness-views")();
	}

	observeTaskGraph(): never {
		return unimplemented("Harness.observeTaskGraph", "harness-views")();
	}

	observeConversation(): never {
		return unimplemented("Harness.observeConversation", "harness-views")();
	}

	get [SCHEDULER_INDEX_SIZES](): Any {
		return this.#harness.indexSizes;
	}

	/** Upstream's runtime of each invocation, keyed by its signal, with the kernel runtime and services of its phase. */
	readonly #runtimes = new WeakMap<AbortSignal, { current: { runtime: Any; api: H.TaskApi }; made: Any }>();

	/**
	 * The Promise runtime of an upstream task handler over the kernel runtime and the task services. Upstream gives an
	 * invocation one runtime object, so its phases share it, each reading through its own kernel runtime and services.
	 */
	promiseRuntime(runtime: Any, api: H.TaskApi, _task: Any): Any {
		const known = this.#runtimes.get(runtime.signal);
		if (known !== undefined) {
			known.current = { runtime, api };
			return known.made;
		}
		const entry = { current: { runtime, api }, made: undefined as Any };
		this.#runtimes.set(runtime.signal, entry);
		entry.made = this.#promiseRuntime(entry);
		return entry.made;
	}

	#promiseRuntime(entry: { readonly current: { runtime: Any; api: H.TaskApi } }): Any {
		const harness = this;
		const models = this.#options.models;
		const ended = () => runIn(entry.current.runtime.guard(Effect.void));
		// An ended invocation wins over the caller's cancelled context, as upstream checks the invocation first.
		const run = <A>(effect: Effect.Effect<A, unknown>, context?: Context): Promise<A> =>
			context?.abortSignal?.aborted === true ? ended().then(() => runIn(effect, context)) : runIn(effect, context);
		const split = (token: Any, args: readonly Any[], extra = 0): [Any[], Context | undefined] => {
			const length = (token.definition.scope === "session" ? 0 : 1) + (token.definition.family === true ? 1 : 0) + extra;
			return [args.slice(0, length), args[length]];
		};
		const sync = <A>(read: () => A): A => {
			try {
				return read();
			} catch (error) {
				throw upstreamError(error);
			}
		};
		return {
			taskId: entry.current.runtime.taskId,
			conversationId: entry.current.runtime.conversationId,
			signal: entry.current.runtime.signal,
			get registry() {
				return upstreamSnapshot(entry.current.runtime.registry);
			},
			agent: (context: Context) => run(entry.current.api.agent, context).then(upstreamAgent),
			get settings() {
				return entry.current.api.settings();
			},
			get models() {
				return typeof models === "function" ? models() : models;
			},
			env: (context: Context) => run(entry.current.api.env, context),
			hooks: {
				each: (name: string, invoke: (handler: Any) => Any) =>
					run(
						entry.current.api.hooks.each(name, (handler: Any) =>
							promised(() => invoke((...args: Any[]) => run(handler(...args)))),
						),
					),
			},
			commit: (change: Any, context: Context) => run(entry.current.runtime.commit(callback(change)), context).catch(unwrap),
			memo: (name: string, ...rest: Any[]) =>
				rest.length <= 1 ? run(entry.current.runtime.memo(name), rest[0]) : run(entry.current.runtime.memo(name, rest[0]), rest[1]),
			getTask: (id: Any, context: Context) => run(entry.current.runtime.getTask(id), context),
			waitForTask: (id: Any, context: Context) => run(entry.current.runtime.waitForTask(id), context),
			abortOwned: (id: Any, context: Context) => run(entry.current.runtime.abortOwned(id), context),
			ownedTasks: (context: Context) =>
				run(entry.current.runtime.ownedTasks(), context).then((records: Any[]) => records.map((record) => structuredClone(record))),
			outcomes: (ids: Any, context: Context) => run(entry.current.runtime.outcomes(ids), context),
			conversation: (id: Any, context: Context) =>
				run(entry.current.api.conversation(id), context).then((handle) =>
					handle === undefined
						? undefined
						: upstreamHandle(handle),
				),
			entry: (...args: Any[]) =>
				args.length === 2
					? run(entry.current.runtime.entry(args[0]), args[1])
					: run(entry.current.runtime.entry(args[1]), args[2]).then((entry: Any) =>
							entry?.kind === args[0].kind ? entry : undefined,
						),
			entries: (query: Any, limit: number, cursor: Any, context: Context) =>
				run(entry.current.runtime.entries(query, limit, cursor), context),
			context: (conversationId: Any, context: Context, options?: Any) =>
				run(entry.current.api.context(conversationId, options), context),
			now: () => sync(() => entry.current.runtime.now()),
			setTimer: (fire: () => void, delayMs: number) => {
				if (entry.current.runtime.signal.aborted) return () => {};
				const disarm = () => {
					clearTimeout(timer);
					entry.current.runtime.signal.removeEventListener("abort", disarm);
				};
				const timer = setTimeout(() => {
					disarm();
					if (!entry.current.runtime.signal.aborted) fire();
				}, delayMs);
				entry.current.runtime.signal.addEventListener("abort", disarm, { once: true });
				return disarm;
			},
			report: (error: unknown, from?: Any) =>
				sync(() =>
					entry.current.api.report(
						error,
						from === undefined
							? undefined
							: from.kind === "extension"
								? from
								: { kind: "host", callback: from.callback },
					),
				),
			sleepUntil: (until: number, checkpoint: Any, context: Context) =>
				run(entry.current.runtime.sleepUntil(until, checkpoint), context),
			snapshot: (token: Any, ...args: Any[]) => {
				const [address, context] = split(token, args);
				return run(entry.current.runtime.snapshot(token, ...address), context);
			},
			snapshotAsOf: (token: Any, ...args: Any[]) => {
				const [address, context] = split(token, args, 1);
				return run((entry.current.api.snapshotAsOf as Any)(token, ...address), context);
			},
			observeDoc: async (...args: Any[]) => {
				await ended();
				return (harness.observeDoc as Any)(...args);
			},
			watchDoc: async (token: Any, ...args: Any[]) => {
				// The invocation's end stops the watch, not the handler context's abort. The harness ends the kernel watch;
				// upstream names that end `stopped`, which only a stop gives the handle.
				const [address, context] = split(token, args);
				const acquire = (entry.current.api.watchDoc as Any)(token, ...address);
				const watch = await harness.watchWith(acquire, withoutAbortSignal(context ?? BACKGROUND_CONTEXT));
				const signal = entry.current.runtime.signal;
				if (watch !== undefined) signal.addEventListener("abort", () => void watch.stop(), { once: true });
				return watch;
			},
		};
	}
}

/** Durable agent harness over one Session. */
export const Harness = {
	async open(storage: Any, options: Any, context: Context): Promise<HarnessImpl> {
		context.abortSignal?.throwIfAborted();
		let harness: HarnessImpl | undefined;
		// Tasks run only after `resume`, once `harness` is set.
		const host = { promiseRuntime: (...args: Any[]) => (harness!.promiseRuntime as Any)(...args) };
		const models = options.models;
		const hostSettings = () => (typeof options.settings === "function" ? options.settings() : options.settings);
		const opened = await run(
			H.openHarness(kernelStorage(storage), {
				registry: harnessReader(options.registry, host),
				models: typeof models === "function" ? () => promiseSeam(models()) : promiseSeam(models),
				...(options.identity === undefined ? {} : { identity: options.identity }),
				settings: () => {
					const settings = hostSettings();
					return { ...settings, documentRetentionMs: documentRetention(settings?.documentRetentionMs) };
				},
				...(options.now === undefined ? {} : { now: options.now }),
				readOnly: options.readOnly === true,
				// Reports during open, before `harness` exists, reach the host too.
				onReport: (report: Any) =>
					hostReport(
						options,
						report.kind === "storage_failed" ? upstreamCause(report.error) : report.error,
						withoutError(report),
					),
				...(options.env === undefined
					? {}
					: {
							env: (target: Any) =>
								promised((callContext) =>
									options.env(
										{
											conversationId: target.conversationId,
											...(target.cwd === undefined ? {} : { cwd: target.cwd }),
											read: harness,
										},
										callContext,
									),
								),
						}),
				...(options.conversationCreated === undefined
					? {}
					: {
							conversationCreated: (tx: Any, record: Any) =>
								promised(() => options.conversationCreated(new Transaction(tx), record)),
						}),
			}),
			withoutAbortSignal(context),
		);
		harness = new HarnessImpl(storage, opened, options);
		return harness;
	},
};

/** Forwards a report to the host's `onReport`; one that throws or rejects is dropped, as reporting it would report again. */
function hostReport(options: Any, error: unknown, info: Any): void {
	try {
		const result = options.onReport?.({ ...info, error });
		if (typeof result?.then === "function") Promise.resolve(result).catch(() => {});
	} catch {
		// Dropped: see above.
	}
}

const withoutError = ({ error: _error, ...info }: Any): Any => info;

export { ROOT_CONVERSATION_ID, signalled };
