// Amends two tests of upstream/test/harness-tasks.test.ts, listed in amendments.json: the same tasks, calls and checks,
// except that the task progress each test samples after one `setTimeout(0)` is awaited. That sample holds only while
// the progress takes no macrotask; the Effect kernel runs task phases and their commits on fibers dispatched with
// `setImmediate`, which on a loaded machine can take a second turn.
// - "resumes a waiting task once every task in `on` is terminal, whatever the outcome" (spec 5.5) awaits the waiter's
//   `waiting` commit, which the `wait` phase signals once it returns.
// - "does not signal a running abort handler when aborted again, and a cancelled caller leaves the mark durable"
//   (spec 5.4) awaits the start of the run phase before the first `abortTask`. Upstream assumes the run started within
//   one turn of `resume()`; under load it had not, and that `abortTask` returned "marked" at once instead of joining
//   the run, so its caller had nothing to give up on (seen in CI).
import type { Context } from "@earendil-works/chord/context";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineTask,
	MemoryStorage,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, flush } from "../upstream/test/session-support.ts";
import { abortedWith, completed, deferred, eventually, openTasks } from "../upstream/test/task-support.ts";

type Step = { phase: "run" };
type StepRuntime<R> = TaskRuntime<null, Step, R, object>;

/** A one-phase task; the default abort handler settles `aborted` with reason "test". */
function oneStep<R = null>(
	name: string,
	run: (task: { readonly id: TaskId<R> }, runtime: StepRuntime<R>, context: Context) => Promise<void>,
	abort: (runtime: StepRuntime<R>, context: Context) => Promise<void> = (runtime, ctx) =>
		runtime.commit(() => abortedWith("test"), ctx),
) {
	return defineTask<null, Step, R>({
		name,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, ctx) => run(task, runtime, ctx) },
		abort: (_task, runtime, ctx) => abort(runtime, ctx),
	});
}

async function start<R>(
	conversation: Conversation,
	task: ReturnType<typeof oneStep<R>>,
	options: { readonly background?: boolean } = {},
): Promise<TaskId<R>> {
	return conversation.commit(
		(tx) => tx.createTask(task, null, { ownership: { kind: "conversation" }, ...options }),
		context,
	);
}

async function openRoot(
	tasks: Parameters<typeof openTasks>[1],
	options: Parameters<typeof openTasks>[2] & { readonly storage?: MemoryStorage } = {},
) {
	const opened = await openTasks(options.storage ?? new MemoryStorage(), tasks, options);
	const root = await opened.harness.root(context);
	return { ...opened, root };
}

function withSignal(signal: AbortSignal): Context {
	return withAbortSignal(signal, context);
}

describe("task phases", () => {
	it("resumes a waiting task once every task in `on` is terminal, whatever the outcome", async () => {
		const gate = deferred();
		const waiting = deferred();
		const order: string[] = [];
		let on: TaskId[] = [];
		let outcomes: string[] = [];
		const Waiter = defineTask<null, { phase: "wait" } | { phase: "resume" }, null>({
			name: "test.waiter",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime, ctx) => {
					order.push("wait");
					const checkpoint = { phase: "resume" } as const;
					await runtime.commit(() => ({ status: "waiting", checkpoint, on, policy: "allSettled" }), ctx);
					waiting.resolve();
				},
				resume: async (_task, runtime, ctx) => {
					order.push("resume");
					outcomes = (await runtime.outcomes(on, ctx)).map((outcome) => outcome.status);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		const First = oneStep("test.first", async (_task, runtime, ctx) => {
			order.push("first");
			await gate.promise;
			await runtime.commit(() => completed(null), ctx);
		});
		const Faulting = oneStep("test.faulting", async () => {
			order.push("faulting");
			throw new Error("fails");
		});
		const { harness, root } = await openRoot([First, Faulting, Waiter]);
		const first = await start(root, First);
		const faulting = await start(root, Faulting);
		on = [first, faulting];
		const waiter = await root.commit(
			(tx) => tx.createTask(Waiter, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await eventually(() => order.length === 3);
		await waiting.promise;
		expect(order.sort()).toEqual(["faulting", "first", "wait"]);
		expect((await harness.getTask(waiter, context))?.state).toMatchObject({ status: "waiting", on });
		gate.resolve();
		await harness.waitForTask(waiter, context);
		expect(order.at(-1)).toBe("resume");
		expect(outcomes).toEqual(["completed", "faulted"]);
		await harness.close(context);
	});
});

describe("task abort", () => {
	it("does not signal a running abort handler when aborted again, and a cancelled caller leaves the mark durable", async () => {
		const reached = deferred();
		const proceed = deferred();
		const runStarted = deferred();
		const runRelease = deferred();
		let abortSignalled: boolean | undefined;
		let aborts = 0;
		const Run = oneStep(
			"test.abort-again",
			async () => {
				runStarted.resolve();
				// Ignores the signal, so the first caller is still joining when it gives up.
				await runRelease.promise;
			},
			async (runtime, ctx) => {
				aborts++;
				reached.resolve();
				await proceed.promise;
				abortSignalled = runtime.signal.aborted;
				await runtime.commit(() => abortedWith("once"), ctx);
			},
		);
		const { harness, root } = await openRoot([Run]);
		const id = await start(root, Run);
		harness.resume();
		await runStarted.promise;
		// This caller gives up while joining; the mark and the abort invocation are unaffected.
		const controller = new AbortController();
		const cancelled = harness.abortTask(id, withSignal(controller.signal));
		while (!(await harness.getTask(id, context))?.abortRequested) await flush();
		controller.abort(new Error("caller gave up"));
		await expect(cancelled).rejects.toThrow("caller gave up");
		runRelease.resolve();
		await reached.promise;
		expect(await harness.abortTask(id, context)).toBe("marked");
		proceed.resolve();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "once" });
		expect(abortSignalled).toBe(false);
		expect(aborts).toBe(1);
		await harness.close(context);
	});
});
