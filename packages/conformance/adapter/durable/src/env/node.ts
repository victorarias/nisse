import { type ExecutionEnv, ExecutionError, FileError } from "@nisse/env";
import { LocalExecutionEnv, type LocalExecutionEnvOptions } from "@nisse/env/local";
import { Cause, Effect, Exit } from "effect";
import type { Context } from "../../../chord/src/context/index.ts";
import { err, ok, type Result } from "./index.ts";

/** Runs an env effect for a Promise-and-Context caller. An abort of the context interrupts the fiber. */
async function run<A, E>(
	effect: Effect.Effect<A, E>,
	context: Context,
	aborted: () => E,
): Promise<Result<A, E>> {
	const signal = context.abortSignal;
	if (signal?.aborted) return err(aborted());
	const exit = await Effect.runPromiseExit(effect, signal === undefined ? undefined : { signal });
	if (Exit.isSuccess(exit)) return ok(exit.value);
	if (Cause.hasInterruptsOnly(exit.cause)) return err(aborted());
	const failure = Cause.findError(exit.cause);
	if (failure._tag === "Success") return err(failure.success);
	throw Cause.squash(exit.cause);
}

const file =
	(context: Context) =>
	<A>(effect: Effect.Effect<A, FileError>) =>
		run(effect, context, () => new FileError("aborted", "aborted"));

const closing = (effect: Effect.Effect<void>, context: Context) => file(context)(effect).then(() => undefined);

/** Makes spill files come from the outer environment, where a subclass may override them. */
class Bridged extends LocalExecutionEnv {
	constructor(
		options: LocalExecutionEnvOptions,
		private readonly outer: NodeExecutionEnv,
		private readonly context: Context,
	) {
		super(options);
	}

	override createTempFile(options?: { prefix?: string; suffix?: string }) {
		return Effect.flatMap(
			Effect.promise(() => this.outer.createTempFile(options, this.context)),
			(result) => (result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)),
		);
	}

	localTempFile(options?: { prefix?: string; suffix?: string }) {
		return super.createTempFile(options);
	}
}

const BACKGROUND = { abortSignal: undefined } as Context;

export class NodeExecutionEnv {
	readonly id: string;
	readonly cwd: string;
	readonly #env: Bridged;

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv; watch?: LocalExecutionEnvOptions["watch"] }) {
		this.#env = new Bridged(options, this, BACKGROUND);
		this.id = this.#env.id;
		this.cwd = this.#env.cwd;
	}

	absolutePath = (path: string, context: Context) => file(context)(this.#env.absolutePath(path));
	joinPath = (parts: string[], context: Context) => file(context)(this.#env.joinPath(parts));
	readTextFile = (path: string, context: Context) => file(context)(this.#env.readTextFile(path));
	readTextLines = (path: string, options: { maxLines?: number } | undefined, context: Context) =>
		file(context)(this.#env.readTextLines(path, options));
	readBinaryFile = (path: string, context: Context) => file(context)(this.#env.readBinaryFile(path));
	writeFile = (path: string, content: string | Uint8Array, context: Context) => file(context)(this.#env.writeFile(path, content));
	appendFile = (path: string, content: string | Uint8Array, context: Context) => file(context)(this.#env.appendFile(path, content));
	truncateFile = (path: string, size: number, context: Context) => file(context)(this.#env.truncateFile(path, size));
	flushFile = (path: string, context: Context) => file(context)(this.#env.flushFile(path));
	renameFile = (source: string, destination: string, context: Context) => file(context)(this.#env.renameFile(source, destination));
	fileInfo = (path: string, context: Context) => file(context)(this.#env.fileInfo(path));
	listDir = (path: string, context: Context) => file(context)(this.#env.listDir(path));
	canonicalPath = (path: string, context: Context) => file(context)(this.#env.canonicalPath(path));
	exists = (path: string, context: Context) => file(context)(this.#env.exists(path));
	createDir = (path: string, options: { recursive?: boolean } | undefined, context: Context) =>
		file(context)(this.#env.createDir(path, options));
	remove = (path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) =>
		file(context)(this.#env.remove(path, options));
	createTempDir = (prefix: string | undefined, context: Context) => file(context)(this.#env.createTempDir(prefix));

	// A method, not a field, so that a subclass can override it.
	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		return file(context)(this.#env.localTempFile(options));
	}

	async openTextLineReader(path: string, context: Context) {
		const opened = await file(context)(this.#env.openTextLineReader(path));
		if (!opened.ok) return opened;
		const reader = opened.value;
		return ok({
			readLine: (ctx: Context) => file(ctx)(reader.readLine()),
			close: (ctx: Context) => closing(reader.close(), ctx),
		});
	}

	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
		const opened = await file(context)(this.#env.openBinaryReader(path, options));
		if (!opened.ok) return opened;
		const reader = opened.value;
		return ok({
			info: (ctx: Context) => file(ctx)(reader.info()),
			read: (offset: number, length: number, ctx: Context) => file(ctx)(reader.read(offset, length)),
			scanLines: (o: { startLine: number; endLine?: number }, ctx: Context) => file(ctx)(reader.scanLines(o)),
			close: (ctx: Context) => closing(reader.close(), ctx),
		});
	}

	async openDirReader(path: string, context: Context) {
		const opened = await file(context)(this.#env.openDirReader(path));
		if (!opened.ok) return opened;
		const reader = opened.value;
		return ok({
			next: (maxEntries: number, ctx: Context) => file(ctx)(reader.next(maxEntries)),
			close: (ctx: Context) => closing(reader.close(), ctx),
		});
	}

	async watch(targets: Parameters<ExecutionEnv["watch"]>[0], onChange: Parameters<ExecutionEnv["watch"]>[1], context: Context) {
		const opened = await file(context)(this.#env.watch(targets, onChange));
		if (!opened.ok) return opened;
		const watcher = opened.value;
		return ok({
			get mode() {
				return watcher.mode;
			},
			stop: (ctx: Context) => closing(watcher.stop(), ctx),
		});
	}

	async exec(
		command: string | readonly string[],
		options:
			| (Omit<NonNullable<Parameters<ExecutionEnv["exec"]>[1]>, "onOutput" | "onSpill"> & {
					onOutput?: (text: string, context: Context, info: { stream: "stdout" | "stderr" }) => void;
			  })
			| undefined,
		context: Context,
	) {
		let spillPath: string | undefined;
		const { onOutput, ...rest } = options ?? {};
		return run(
			this.#env.exec(command, {
				...rest,
				onSpill: (path) => {
					spillPath = path;
				},
				...(onOutput === undefined ? {} : { onOutput: (text: string, info: { stream: "stdout" | "stderr" }) => onOutput(text, context, info) }),
			}),
			context,
			() => {
				const aborted = new ExecutionError("aborted", "aborted");
				if (spillPath !== undefined) aborted.spillPath = spillPath;
				return aborted;
			},
		);
	}

	cleanup = (context: Context) => closing(this.#env.cleanup(), context);
}
