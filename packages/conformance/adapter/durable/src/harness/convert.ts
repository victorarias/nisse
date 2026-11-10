// Upstream's Promise-and-Context extension code as @nisse/harness's Effect-shaped code, and back. Every conversion is
// cached both ways, so an object the suite installed comes back from a snapshot as itself.
import { Effect, Option, Tracer } from "effect";
import * as H from "../../../../../harness/src/index.ts";
import { defineTask as kernelDefineTask, fromPromise } from "../../../../../kernel/src/index.ts";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal, withTelemetry } from "../../../chord/src/context/index.ts";
import { promiseModels } from "../../../ai/index.ts";
import { CallbackFailed, run, Transaction, upstreamError } from "../session/session.ts";
import { telemetryOfSpan } from "../telemetry-bridge.ts";

type Any = any;

/** Upstream objects to the harness objects they stand for, and harness objects to their upstream forms. */
const toHarness = new WeakMap<object, Any>();
const toUpstream = new WeakMap<object, Any>();

/** The harness form of an upstream object, made once; a harness object comes back as itself. */
function cached<T extends object>(value: T, make: (value: T) => Any): Any {
	const known = toHarness.get(value);
	if (known !== undefined) return known;
	if (toUpstream.has(value)) return value;
	const made = make(value);
	toHarness.set(value, made);
	toUpstream.set(made, value);
	return made;
}

/** The upstream form of a harness object, made once; an upstream object comes back as itself. */
function upstream<T extends object>(value: T, make: (value: T) => Any): Any {
	const known = toUpstream.get(value);
	if (known !== undefined) return known;
	if (toHarness.has(value)) return value;
	const made = make(value);
	toUpstream.set(value, made);
	toHarness.set(made, value);
	return made;
}

/** A Context whose signal is `signal`. */
export const signalled = (signal: AbortSignal): Context => withAbortSignal(signal, BACKGROUND_CONTEXT);

/** Upstream Promise work as an Effect, with a context whose signal the Effect's interruption aborts. */
export const promised = <A>(work: (context: Context) => PromiseLike<A> | A): Effect.Effect<A, unknown> =>
	Effect.flatMap(Effect.serviceOption(Tracer.ParentSpan), (parent) => {
		// Upstream code reads the span it runs in, such as a phase's, as `context.telemetry`.
		const span = telemetryOfSpan(Option.getOrUndefined(parent));
		const traced = (context: Context): Context => (span === undefined ? context : withTelemetry(span, context));
		return fromPromise((signal) =>
			Promise.resolve().then(() => work(traced(signal === undefined ? BACKGROUND_CONTEXT : signalled(signal)))),
		);
	});

// Commits

/** A commit callback's own rejection passes through unchanged. */
export const unwrap = (error: unknown): never => {
	throw error instanceof CallbackFailed ? error.error : error;
};

/** Upstream's commit callback as a kernel one: an upstream Transaction over the kernel Tx. */
export const callback =
	(change: (tx: Any, ...rest: Any[]) => Any, returned: () => void = () => {}) =>
	(tx: Any, ...rest: Any[]) =>
		Effect.tryPromise({
			try: async () => {
				const result = await change(new Transaction(tx), ...rest);
				returned();
				return result;
			},
			catch: (error) => new CallbackFailed(error),
		});

/** A document address's arguments and the context after them. */
export const split = (token: Any, args: readonly Any[], extra = 0): [Any[], Context | undefined] => {
	const length = (token.definition.scope === "session" ? 0 : 1) + (token.definition.family === true ? 1 : 0) + extra;
	return [args.slice(0, length), args[length]];
};

/** A synchronous harness read, failing as upstream does. */
const sync = <A>(read: () => A): A => {
	try {
		return read();
	} catch (error) {
		throw upstreamError(error);
	}
};

/** An upstream memo call: `(name, context)` or `(name, candidate, context)`. */
const memo = (memo: Any) => (name: string, ...rest: Any[]) =>
	rest.length <= 1 ? run(memo(name), rest[0]) : run(memo(name, rest[0]), rest[1]);

/** An upstream entry read: `(id, context)`, or `(token, id, context)` for an entry of the token's kind. */
const entry = (read: (id: Any) => Effect.Effect<Any, unknown>) => (...args: Any[]) =>
	args.length === 2
		? run(read(args[0]), args[1])
		: run(read(args[1]), args[2]).then((entry: Any) => (entry?.kind === args[0].kind ? entry : undefined));

// Submissions and conversations

/** A Harness operation's rejection: pi-durable words a close of its Session as its Harness's. */
const harnessClosed = (error: unknown): never => {
	throw error instanceof Error && error.message === "Session is closed" ? new Error("Harness is closed") : error;
};

/** Upstream's handle of a submission. */
export const upstreamSubmission = (submission: H.Submission): Any => ({
	id: submission.id,
	status: (context: Context) => run(submission.status, context).catch(harnessClosed),
	wait: (context: Context) => run(submission.wait, context).catch(harnessClosed),
	abort: (context: Context) => run(submission.abort, context).catch(harnessClosed),
});

/** Upstream's `submit(draft, context)` and `submit(tx, draft)` over the harness's two forms. */
export const upstreamSubmit =
	(submit: { (draft: Any): Effect.Effect<H.Submission, unknown>; (tx: Any, draft: Any): Effect.Effect<Any, unknown> }) =>
	(first: Any, second: Any): Promise<Any> =>
		typeof first?.type === "string"
			? run(submit(first), second).then(upstreamSubmission)
			: run(submit(kernelOf(first), second));

/** The kernel Tx behind a suite's Transaction; anything else as it is, for the harness to refuse. */
const kernelOf = (tx: Any): Any => {
	try {
		return tx.kernel ?? tx;
	} catch {
		return tx;
	}
};

/** Upstream's handle of a conversation a task or tool holds. */
export const upstreamHandle = (handle: H.ConversationHandle): Any => ({
	id: handle.id,
	submit: upstreamSubmit(handle.submit.bind(handle) as Any),
	abort: (context: Context, options?: Any) => run(handle.abort(options), context),
	waitForIdle: (context: Context) => run(handle.waitForIdle, context),
});

// Hook and tool APIs

const hookApis = new WeakMap<object, Any>();

/** Upstream's hook API over the harness's; the same object for the same API. */
export function upstreamHookApi(api: H.HookApi): Any {
	const known = hookApis.get(api);
	if (known !== undefined) return known;
	const made = {
		taskId: api.taskId,
		conversationId: api.conversationId,
		get models() {
			return promiseModels(api.models());
		},
		memo: memo(api.memo.bind(api)),
		entry: entry((id) => api.entry(id)),
		entries: (query: Any, limit: number, cursor: Any, context: Context) => run(api.entries(query, limit, cursor), context),
		snapshot: (token: Any, ...args: Any[]) => {
			const [address, context] = split(token, args);
			return run((api.snapshot as Any)(token, ...address), context);
		},
	};
	hookApis.set(api, made);
	return made;
}

/** Whether a hook's last argument is the harness's hook API, which upstream's handlers take as API and context. */
const isHookApi = (value: Any): value is H.HookApi =>
	typeof value === "object" && value !== null && typeof value.models === "function" && value.signal instanceof AbortSignal;

/** Upstream's tool execution API over the harness's. */
export function upstreamToolApi(api: H.ToolExecutionApi): Any {
	return {
		taskId: api.taskId,
		conversationId: api.conversationId,
		callId: api.callId,
		get registry() {
			return upstreamSnapshot(api.registry);
		},
		agent: (context: Context) => run(api.agent, context).then(upstreamAgent),
		get models() {
			return promiseModels(api.models());
		},
		get env() {
			return api.env;
		},
		now: () => sync(() => api.now()),
		output: (chunk: Any, skipped?: Any) => sync(() => api.output(chunk, skipped)),
		get outputWindow() {
			return api.outputWindow;
		},
		retainedOutput: () => sync(() => api.retainedOutput()),
		diagnostic: (diagnostic: Any) => sync(() => api.diagnostic(diagnostic)),
		details: (value: Any, context: Context) => run(api.details(value), context),
		commit: (change: Any, context: Context) => run(api.commit(callback(change)), context).catch(unwrap),
		memo: memo(api.memo.bind(api)),
		createTask: (task: Any, input: Any, options: Any, context: Context) =>
			run(api.createTask(harnessTask(task), input, options), context),
		executeTool: (name: string, args: Any, context: Context, options?: Any) =>
			run(api.executeTool(name, args, options), context),
		getTask: (id: Any, context: Context) => run(api.getTask(id), context),
		waitForTask: (id: Any, context: Context) => run(api.waitForTask(id), context),
		conversation: (id: Any, context: Context) =>
			run(api.conversation(id), context).then((handle) => (handle === undefined ? undefined : upstreamHandle(handle))),
		snapshot: (token: Any, ...args: Any[]) => {
			const [address, context] = split(token, args);
			return run((api.snapshot as Any)(token, ...address), context);
		},
	};
}

// Tools

export const harnessTool = (tool: Any): Any =>
	cached(tool, (tool) => ({
		...tool,
		execute: (args: Any, api: Any) => promised((context) => tool.execute(args, upstreamToolApi(api), context)),
	}));

export const upstreamTool = (tool: Any): Any =>
	upstream(tool, (tool) => ({ ...tool, execute: (args: Any, api: Any, context: Context) => run(tool.execute(args, api), context) }));

// Sections

export const harnessSection = (section: Any): Any =>
	cached(section, (section) => ({
		key: section.key,
		...(section.tag === undefined ? {} : { tag: section.tag }),
		render: (input: Any) => promised((context) => section.render(upstreamInput(input), context)),
	}));

export const upstreamSection = (section: Any): Any =>
	upstream(section, (section) => ({
		key: section.key,
		...(section.tag === undefined ? {} : { tag: section.tag }),
		render: (input: Any, context: Context) => run(section.render(harnessInput(input)), context),
	}));

/** The number of address arguments a token takes. */
const addressLength = (token: Any): number =>
	(token.definition.scope === "session" ? 0 : 1) + (token.definition.family === true ? 1 : 0);

export function upstreamInput(input: Any): Any {
	return {
		...input,
		agent: upstreamAgent(input.agent),
		read: {
			snapshot: (token: Any, ...args: Any[]) =>
				run(input.read.snapshot(token, ...args.slice(0, addressLength(token))), args[addressLength(token)]),
		},
	};
}

export function harnessInput(input: Any): Any {
	return {
		...input,
		agent: harnessAgent(input.agent),
		read: {
			snapshot: (token: Any, ...address: Any[]) =>
				promised((context) => input.read.snapshot(token, ...address, context)),
		},
	};
}

// Hooks

/** Handlers whose functions return Effects, each calling the upstream function with its own `this`. */
const harnessHandlers = (handlers: Any): Any =>
	cached(handlers, (handlers) =>
		Object.fromEntries(
			Object.keys(handlers).map((name) => [
				name,
				typeof handlers[name] === "function"
					? (...args: Any[]) => {
							// The harness passes its hook API last; upstream's handlers take an API and a context there.
							const api = args.at(-1);
							if (!isHookApi(api)) return promised(() => handlers[name].apply(handlers, args));
							const upstreamArgs = [...args.slice(0, -1), upstreamHookApi(api)];
							return promised((context) => handlers[name].apply(handlers, [...upstreamArgs, context]));
						}
					: handlers[name],
			]),
		),
	);

// Wraps

const harnessWrap = (wrap: Any): Any =>
	cached(wrap, (wrap) =>
		"tool" in wrap
			? { tool: wrap.tool, wrap: (tool: Any) => harnessTool(wrap.wrap(upstreamTool(tool))) }
			: { section: wrap.section, wrap: (section: Any) => harnessSection(wrap.wrap(upstreamSection(section))) },
	);

// Tasks

/** What runs an upstream task handler: a Harness, which gives it upstream's Promise runtime. */
export type RuntimeHost = { promiseRuntime(runtime: Any, api: H.TaskApi, task: Any): Any };

/**
 * The registry's form of an upstream task: its name, version, initial state and migration. A Harness runs the form
 * `boundTask` makes of it, whose handlers get that Harness's Promise runtime.
 */
export const harnessTask = (task: Any): Any =>
	cached(task, (task) => {
		const definition = task.definition;
		const unbound = () => Effect.die(new Error(`Task ${definition.name} runs only through a Harness`));
		return kernelDefineTask({
			name: definition.name,
			version: definition.version,
			initial: (input: Any) => definition.initial(input),
			phases: Object.fromEntries(Object.keys(definition.phases).map((name) => [name, unbound])),
			abort: unbound,
			...(definition.migrate === undefined
				? {}
				: { migrate: (input: Any, checkpoint: Any, from: number) => definition.migrate(input, checkpoint, from) }),
		});
	});

export const upstreamTask = (task: Any): Any => toUpstream.get(task) ?? task;

const bound = new WeakMap<RuntimeHost, WeakMap<object, Any>>();

/** A registry task as `host` runs it: an upstream one with handlers over `host`'s Promise runtime; others as they are. */
function boundTask(task: Any, host: RuntimeHost): Any {
	const original = toUpstream.get(task);
	if (original === undefined || task === undefined) return task;
	let tasks = bound.get(host);
	if (tasks === undefined) bound.set(host, (tasks = new WeakMap()));
	const known = tasks.get(task);
	if (known !== undefined) return known;
	const definition = original.definition;
	const handler = (phase: Any) => (record: Any, runtime: Any) =>
		Effect.gen(function* () {
			const api = yield* H.TaskServices;
			yield* fromPromise(() => phase(record, host.promiseRuntime(runtime, api, original), signalled(runtime.signal)));
		});
	const made = kernelDefineTask({
		...task.definition,
		phases: Object.fromEntries(Object.entries(definition.phases).map(([name, phase]) => [name, handler(phase)])),
		abort: handler(definition.abort.bind(definition)),
	});
	tasks.set(task, made);
	toUpstream.set(made, original);
	return made;
}

// Extensions

export const harnessExtension = (extension: Any): Any =>
	cached(extension, (extension) => ({
		name: extension.name,
		...(extension.tools === undefined ? {} : { tools: extension.tools.map(harnessTool) }),
		...(extension.sections === undefined ? {} : { sections: extension.sections.map(harnessSection) }),
		...(extension.hooks === undefined
			? {}
			: { hooks: extension.hooks.map((hook: Any) => ({ task: hook.task, handlers: harnessHandlers(hook.handlers) })) }),
		...(extension.wraps === undefined ? {} : { wraps: extension.wraps.map(harnessWrap) }),
		...(extension.tasks === undefined ? {} : { tasks: extension.tasks.map(harnessTask) }),
	}));

export const upstreamExtension = (extension: Any): Any =>
	extension === undefined ? undefined : (toUpstream.get(extension) ?? extension);

// Agents

export function upstreamAgent(agent: Any): Any {
	return upstream(agent, (agent) => ({
		...agent,
		extensions: agent.extensions.map(upstreamExtension),
		tools: agent.tools.map(upstreamTool),
		callable: agent.callable.map(upstreamTool),
		deferred: agent.deferred.map(upstreamTool),
		sections: agent.sections.map(upstreamSection),
	}));
}

export function harnessAgent(agent: Any): Any {
	return cached(agent, (agent) => ({
		...agent,
		extensions: agent.extensions.map(harnessExtension),
		tools: agent.tools.map(harnessTool),
		callable: agent.callable.map(harnessTool),
		deferred: agent.deferred.map(harnessTool),
		sections: agent.sections.map(harnessSection),
	}));
}

// Snapshots and registries

const HARNESS_SNAPSHOT = Symbol("harness snapshot");

/** Upstream's snapshot over a harness one; the same object for the same harness snapshot. */
export const upstreamSnapshot = (snapshot: Any): Any =>
	upstream(snapshot, (snapshot) => ({
		[HARNESS_SNAPSHOT]: snapshot,
		installed: () => snapshot.installed().map(upstreamExtension),
		extension: (name: string) => upstreamExtension(snapshot.extension(name)),
		tools: () =>
			snapshot.tools().map(({ extension, tool }: Any) => ({ extension: upstreamExtension(extension), tool: upstreamTool(tool) })),
		sections: () =>
			snapshot
				.sections()
				.map(({ extension, section }: Any) => ({ extension: upstreamExtension(extension), section: upstreamSection(section) })),
		tasks: () => snapshot.tasks().map(upstreamTask),
		task: (name: string) => {
			const task = snapshot.task(name);
			return task === undefined ? undefined : upstreamTask(task);
		},
	}));

/** The harness snapshot behind one of upstream's; a snapshot the suite built by hand is converted. */
export function harnessSnapshot(snapshot: Any): Any {
	return snapshot[HARNESS_SNAPSHOT] ?? cached(snapshot, plainSnapshot);
}

/** A built-in harness task as it is; an upstream task converted. */
const anyTask = (task: Any): Any => (H.BUILTIN_TASKS.includes(task) ? task : harnessTask(task));

const plainSnapshot = (snapshot: Any): Any => ({
	installed: () => snapshot.installed().map(harnessExtension),
	extension: (name: string) => {
		const extension = snapshot.extension(name);
		return extension === undefined ? undefined : harnessExtension(extension);
	},
	tools: () =>
		snapshot.tools().map(({ extension, tool }: Any) => ({ extension: harnessExtension(extension), tool: harnessTool(tool) })),
	sections: () =>
		snapshot
			.sections()
			.map(({ extension, section }: Any) => ({ extension: harnessExtension(extension), section: harnessSection(section) })),
	tasks: () => snapshot.tasks().map(anyTask),
	task: (name: string) => {
		const task = snapshot.task(name);
		return task === undefined ? undefined : anyTask(task);
	},
});

const boundSnapshots = new WeakMap<RuntimeHost, WeakMap<object, Any>>();

/** A harness snapshot whose tasks `host` runs; the same object for the same snapshot and host. */
function boundSnapshot(snapshot: Any, host: RuntimeHost): Any {
	let snapshots = boundSnapshots.get(host);
	if (snapshots === undefined) boundSnapshots.set(host, (snapshots = new WeakMap()));
	const known = snapshots.get(snapshot);
	if (known !== undefined) return known;
	const made = {
		installed: () => snapshot.installed(),
		extension: (name: string) => snapshot.extension(name),
		tools: () => snapshot.tools(),
		sections: () => snapshot.sections(),
		tasks: () => snapshot.tasks().map((task: Any) => boundTask(task, host)),
		task: (name: string) => boundTask(snapshot.task(name), host),
	};
	snapshots.set(snapshot, made);
	// Read back as upstream's snapshot of the registry, whose tasks are upstream's.
	toUpstream.set(made, upstreamSnapshot(snapshot));
	return made;
}

/** A harness registry reader over upstream's, whose tasks `host` runs. */
export const harnessReader = (reader: Any, host: RuntimeHost): H.RegistryReader => ({
	snapshot: () => boundSnapshot(harnessSnapshot(reader.snapshot()), host),
	subscribe: (listener) => reader.subscribe(listener),
});

/** Upstream's registry over @nisse/harness's: what is installed is converted once. */
export class Registry {
	readonly #inner = H.createRegistry<Any>();

	snapshot(): Any {
		return upstreamSnapshot(this.#inner.snapshot());
	}

	subscribe(listener: () => void): () => void {
		return this.#inner.subscribe(listener);
	}

	install(extension: Any): void {
		this.#inner.install(harnessExtension(extension));
	}

	uninstall(extension: Any): void {
		this.#inner.uninstall({ name: extension.name });
	}
}

export { run };
