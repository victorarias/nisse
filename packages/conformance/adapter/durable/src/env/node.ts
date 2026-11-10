import { type ExecutionEnv, ExecutionError, FileError } from "@nisse/env";
import { LocalExecutionEnv, type LocalExecutionEnvOptions } from "@nisse/env/local";
import { Cause, Effect, Exit } from "effect";
import { BACKGROUND_CONTEXT, type Context } from "../../../chord/src/context/index.ts";
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

// Closing ignores the context, as upstream's does: a reader closed after a cancelled read must still close.
const closing = (effect: Effect.Effect<void>, _context: Context) => Effect.runPromise(effect);

/** Routes the env's own temp-file calls through the outer environment, where a subclass may override them. */
class Bridged extends LocalExecutionEnv {
	constructor(
		options: LocalExecutionEnvOptions,
		private readonly outer: NodeExecutionEnv,
		private readonly context: Context,
	) {
		super(options);
	}

	override createTempDir(prefix?: string) {
		return fromResult(() => this.outer.createTempDir(prefix, this.context));
	}

	override createTempFile(options?: { prefix?: string; suffix?: string }) {
		return fromResult(() => this.outer.createTempFile(options, this.context));
	}

	localTempDir(prefix?: string) {
		return super.createTempDir(prefix);
	}

	localTempFile(options?: { prefix?: string; suffix?: string }) {
		return super.createTempFile(options);
	}
}

const fromResult = <A>(call: () => Promise<Result<A, FileError>>) =>
	Effect.flatMap(Effect.promise(call), (result) => (result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)));

export class NodeExecutionEnv {
	readonly id: string;
	readonly cwd: string;
	readonly #env: Bridged;

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv; watch?: LocalExecutionEnvOptions["watch"] }) {
		this.#env = new Bridged(options, this, BACKGROUND_CONTEXT);
		this.id = this.#env.id;
		this.cwd = this.#env.cwd;
	}

	// Methods, so a subclass overrides them; the wrapped environment is found also from an `Object.create` of this one.
	static #innerOf(self: object): Bridged {
		for (let at: object | null = self; at !== null; at = Object.getPrototypeOf(at)) {
			if (#env in at) return (at as NodeExecutionEnv).#env;
		}
		throw new TypeError("not a NodeExecutionEnv");
	}

	absolutePath(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).absolutePath(path));
	}

	joinPath(parts: string[], context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).joinPath(parts));
	}

	readTextFile(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).readTextFile(path));
	}

	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).readTextLines(path, options));
	}

	readBinaryFile(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).readBinaryFile(path));
	}

	writeFile(path: string, content: string | Uint8Array, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).writeFile(path, content));
	}

	appendFile(path: string, content: string | Uint8Array, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).appendFile(path, content));
	}

	truncateFile(path: string, size: number, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).truncateFile(path, size));
	}

	flushFile(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).flushFile(path));
	}

	renameFile(source: string, destination: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).renameFile(source, destination));
	}

	fileInfo(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).fileInfo(path));
	}

	listDir(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).listDir(path));
	}

	canonicalPath(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).canonicalPath(path));
	}

	exists(path: string, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).exists(path));
	}

	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).createDir(path, options));
	}

	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
		return file(context)(NodeExecutionEnv.#innerOf(this).remove(path, options));
	}

	// Methods, not fields, so that a subclass can override them.
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return file(context)(NodeExecutionEnv.#innerOf(this).localTempDir(prefix));
	}


	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		return file(context)(NodeExecutionEnv.#innerOf(this).localTempFile(options));
	}

	async openTextLineReader(path: string, context: Context) {
		const opened = await file(context)(NodeExecutionEnv.#innerOf(this).openTextLineReader(path));
		if (!opened.ok) return opened;
		const reader = opened.value;
		return ok({
			readLine: (ctx: Context) => file(ctx)(reader.readLine()),
			close: (ctx: Context) => closing(reader.close(), ctx),
		});
	}

	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
		const opened = await file(context)(NodeExecutionEnv.#innerOf(this).openBinaryReader(path, options));
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
		const opened = await file(context)(NodeExecutionEnv.#innerOf(this).openDirReader(path));
		if (!opened.ok) return opened;
		const reader = opened.value;
		return ok({
			next: (maxEntries: number, ctx: Context) => file(ctx)(reader.next(maxEntries)),
			close: (ctx: Context) => closing(reader.close(), ctx),
		});
	}

	async watch(targets: Parameters<ExecutionEnv["watch"]>[0], onChange: Parameters<ExecutionEnv["watch"]>[1], context: Context) {
		const opened = await file(context)(NodeExecutionEnv.#innerOf(this).watch(targets, onChange));
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
			NodeExecutionEnv.#innerOf(this).exec(command, {
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

	cleanup(context: Context) {
		return closing(NodeExecutionEnv.#innerOf(this).cleanup(), context);
	}

}
