// @sigma/tools as upstream's Promise-and-Context tools, and upstream's Promise environments and image processors as the
// Effect ones those tools take. Conversions are cached both ways, so an object comes back as itself.
import type * as Env from "@sigma/env";
import type * as T from "@sigma/tools";
import { Effect } from "effect";
import { fromPromise } from "../../../../../kernel/src/index.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../../chord/src/context/index.ts";
import { signalled, upstream, upstreamToolApi } from "../harness/convert.ts";
import { run } from "../session/session.ts";

type Any = any;

const toEffect = new WeakMap<object, Any>();
const toPromise = new WeakMap<object, Any>();

function both<T extends object>(from: T, made: Any, forward: WeakMap<object, Any>, back: WeakMap<object, Any>): Any {
	forward.set(from, made);
	back.set(made, from);
	return made;
}

/** An upstream call `(…, context)` returning a Result, as an Effect failing with the Result's error. */
const result = <A>(call: (context: Context) => PromiseLike<Any>): Effect.Effect<A, Any> =>
	Effect.flatMap(
		fromPromise((signal) => Promise.resolve().then(() => call(signal === undefined ? BACKGROUND_CONTEXT : signalled(signal)))),
		(value: Any) => (value.ok ? Effect.succeed(value.value as A) : Effect.fail(value.error)),
	);

/** An upstream close `(context)`, which never fails. */
const closing = (call: (context: Context) => PromiseLike<unknown>): Effect.Effect<void> =>
	Effect.ignore(fromPromise(() => Promise.resolve().then(() => call(BACKGROUND_CONTEXT))));

/** A Promise reader's methods as Effects. */
const reader = (opened: Any): Any =>
	Object.fromEntries(
		Object.entries({
			readLine: () => result((c) => opened.readLine(c)),
			info: () => result((c) => opened.info(c)),
			read: (offset: number, length: number) => result((c) => opened.read(offset, length, c)),
			scanLines: (options: Any) => result((c) => opened.scanLines(options, c)),
			next: (maxEntries: number) => result((c) => opened.next(maxEntries, c)),
		}).filter(([name]) => typeof opened[name] === "function"),
	);

/** Upstream's Promise environment as @sigma/env's Effect one; each call goes to the upstream object, so overrides hold. */
export function effectEnv(env: Any): Env.ExecutionEnv | undefined {
	if (env === undefined) return undefined;
	const known = toEffect.get(env);
	if (known !== undefined) return known;
	if (toPromise.has(env)) return env;
	const opened = (open: (context: Context) => PromiseLike<Any>) =>
		Effect.map(result<Any>(open), (handle) => ({ ...reader(handle), close: () => closing((c) => handle.close(c)) }));
	const made: Env.ExecutionEnv = {
		get id() {
			return env.id;
		},
		get cwd() {
			return env.cwd;
		},
		absolutePath: (path) => result((c) => env.absolutePath(path, c)),
		joinPath: (parts) => result((c) => env.joinPath(parts, c)),
		readTextFile: (path) => result((c) => env.readTextFile(path, c)),
		openTextLineReader: (path) => opened((c) => env.openTextLineReader(path, c)),
		readTextLines: (path, options) => result((c) => env.readTextLines(path, options, c)),
		readBinaryFile: (path) => result((c) => env.readBinaryFile(path, c)),
		openBinaryReader: (path, options) => opened((c) => env.openBinaryReader(path, options, c)),
		writeFile: (path, content) => result((c) => env.writeFile(path, content, c)),
		appendFile: (path, content) => result((c) => env.appendFile(path, content, c)),
		truncateFile: (path, size) => result((c) => env.truncateFile(path, size, c)),
		flushFile: (path) => result((c) => env.flushFile(path, c)),
		renameFile: (source, destination) => result((c) => env.renameFile(source, destination, c)),
		fileInfo: (path) => result((c) => env.fileInfo(path, c)),
		listDir: (path) => result((c) => env.listDir(path, c)),
		openDirReader: (path) => opened((c) => env.openDirReader(path, c)),
		watch: (targets, onChange) =>
			Effect.map(result<Any>((c) => env.watch(targets, onChange, c)), (watcher) => ({
				get mode() {
					return watcher.mode;
				},
				stop: () => closing((c) => watcher.stop(c)),
			})),
		canonicalPath: (path) => result((c) => env.canonicalPath(path, c)),
		exists: (path) => result((c) => env.exists(path, c)),
		createDir: (path, options) => result((c) => env.createDir(path, options, c)),
		remove: (path, options) => result((c) => env.remove(path, options, c)),
		createTempDir: (prefix) => result((c) => env.createTempDir(prefix, c)),
		createTempFile: (options) => result((c) => env.createTempFile(options, c)),
		exec: (command, options) => {
			const { onOutput, onSpill: _onSpill, ...rest } = options ?? {};
			return result((c) =>
				env.exec(
					command,
					{ ...rest, ...(onOutput === undefined ? {} : { onOutput: (text: string, _c: Context, info: Any) => onOutput(text, info) }) },
					c,
				),
			);
		},
		cleanup: () => closing((c) => env.cleanup(c)),
	};
	return both(env, made, toEffect, toPromise);
}

/** The upstream environment an Effect one came from; one made elsewhere passes as it is. */
export const promiseEnv = (env: Any): Any => (env === undefined ? undefined : (toPromise.get(env) ?? env));

/** The upstream API and context behind a harness API this bridge made for a direct `execute` call. */
const origins = new WeakMap<object, { readonly api: Any; readonly context: Context }>();

/** A harness tool API over an upstream one a test passed to `execute`, for the tools this package has. */
function harnessApi(api: Any, context: Context): Any {
	const made = {
		taskId: api.taskId,
		conversationId: api.conversationId,
		callId: api.callId,
		signal: context.abortSignal ?? new AbortController().signal,
		get registry() {
			return api.registry;
		},
		agent: fromPromise((signal) => api.agent(signal === undefined ? context : signalled(signal))),
		models: () => api.models,
		env: effectEnv(api.env),
		now: () => api.now(),
		output: (chunk: Any, skipped?: Any) => api.output(chunk, skipped),
		get outputWindow() {
			return api.outputWindow;
		},
		retainedOutput: () => api.retainedOutput(),
		diagnostic: (diagnostic: Any) => api.diagnostic(diagnostic),
		details: (value: Any) => fromPromise(() => api.details(value, context)),
	};
	origins.set(made, { api, context });
	return made;
}

/** The upstream form of an Effect image processor; an upstream processor passed back comes out as itself. */
export function promiseImages(images: T.ImageProcessor): Any {
	const known = toPromise.get(images);
	if (known !== undefined) return known;
	return both(images, { prepare: (...args: Parameters<T.ImageProcessor["prepare"]>) => Effect.runPromise(images.prepare(...args)) }, toPromise, toEffect);
}

/** The Effect form of an upstream image processor. */
export function effectImages(images: Any): T.ImageProcessor | undefined {
	if (images === undefined) return undefined;
	const known = toEffect.get(images);
	if (known !== undefined) return known;
	return both(
		images,
		{ prepare: (...args: Parameters<T.ImageProcessor["prepare"]>) => Effect.tryPromise({ try: () => images.prepare(...args), catch: (error) => error as Error }) },
		toEffect,
		toPromise,
	);
}

/**
 * Upstream's form of a tool of this package: `execute(args, api, context)` runs the Effect over a harness API made from
 * `api`. Installed in a registry, it converts back to the tool itself, which the harness runs with its own API.
 */
export const upstreamTool = (tool: Any): Any =>
	upstream(tool, (tool) => ({
		...tool,
		execute: (args: Any, api: Any, context: Context = BACKGROUND_CONTEXT) =>
			run(tool.execute(args, harnessApi(api, context)), context).catch((error: unknown) => {
				// An aborted call is interrupted, as upstream's tools say.
				if (context.abortSignal?.aborted && error === context.abortSignal.reason) throw new Error("Operation aborted");
				throw error;
			}),
	}));

/** Upstream's form of an extension of this package's tools. */
export const upstreamExtension = (extension: Any): Any =>
	upstream(extension, (extension) => ({ ...extension, tools: extension.tools.map(upstreamTool) }));

/** A `prepare` of `bash` options given as upstream's `(execution, api, context)`. */
export const harnessPrepare =
	(prepare: Any) =>
	(execution: Any, api: Any): Effect.Effect<void, unknown> => {
		const origin = origins.get(api);
		if (origin !== undefined) return fromPromise(() => Promise.resolve(prepare(execution, origin.api, origin.context)));
		return fromPromise((signal) =>
			Promise.resolve(prepare(execution, upstreamToolApi(api), signal === undefined ? BACKGROUND_CONTEXT : signalled(signal))),
		);
	};
