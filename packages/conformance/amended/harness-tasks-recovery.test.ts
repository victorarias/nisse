// Amends upstream/test/harness-tasks-recovery.test.ts > "rejects a runtime commit of the old invocation queued behind
// its handover commit" (spec 7.5): the same tasks, handover, late commit and checks, except for how the late commit gets
// queued behind the handover commit. Upstream holds the line with an unrelated blocker commit in storage and gives the
// handover commit one `setTimeout(0)` to queue behind it before the late commit is made; the Effect kernel reaches the
// handover through fibers dispatched with `setImmediate`, so under load the late commit can queue first, complete the
// task and resolve instead of rejecting. No public signal says the handover commit is queued, so the test holds the
// handover commit itself in storage instead: storage holds the next commit after the `b` checkpoint commit, and its
// `entered` says the handover commit is in storage before the late commit is made.
import type { Context } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineTask,
	type Task,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { addTask } from "../upstream/test/harness-support.ts";
import { ControlledStorage, context, flush } from "../upstream/test/session-support.ts";
import { abortedWith, completed, deferred, eventually, openTasks } from "../upstream/test/task-support.ts";

type OpenHarness = Awaited<ReturnType<typeof openTasks>>["harness"];

async function createIn<S extends { phase: string }, R>(
	harness: OpenHarness,
	task: Task<null, S, R, object>,
): Promise<TaskId<R>> {
	const root = await harness.root(context);
	return root.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
}

describe("definition handover", () => {
	type Handover = { phase: "a" } | { phase: "b" } | { phase: "c" };
	type Gates = { readonly a?: Promise<void>; readonly b?: Promise<void>; readonly onEnd?: () => void };

	function handoverTask(
		label: string,
		version: number,
		log: string[],
		options: { readonly gates?: Gates; readonly migrate?: () => { input: null; checkpoint: Handover } } = {},
	) {
		const advance =
			(phase: "a" | "b", next: Handover) =>
			async (_task: unknown, runtime: TaskRuntime<null, Handover, null, object>, ctx: Context) => {
				log.push(`${label}:${phase} start`);
				await options.gates?.[phase];
				await runtime.commit(() => ({ status: "running", checkpoint: next }), ctx);
				// Leave room for a wrongly dispatched successor before this invocation ends.
				await flush();
				options.gates?.onEnd?.();
				log.push(`${label}:${phase} end`);
			};
		return defineTask<null, Handover, null>({
			name: "test.handover",
			version,
			initial: () => ({ phase: "a" }),
			phases: {
				a: advance("a", { phase: "b" }),
				b: advance("b", { phase: "c" }),
				c: async (_task, runtime, ctx) => {
					log.push(`${label}:c`);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async (_task, runtime, ctx) => {
				log.push(`${label}:abort`);
				await runtime.commit(() => abortedWith(label), ctx);
			},
			...(options.migrate === undefined ? {} : { migrate: options.migrate }),
		});
	}

	it("rejects a runtime commit of the old invocation queued behind its handover commit", async () => {
		const log: string[] = [];
		const gate = deferred();
		const storage = new ControlledStorage();
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		let oldRuntime: TaskRuntime<null, Handover, null, object> | undefined;
		const registry = createRegistry();
		const Old = defineTask<null, Handover, null>({
			name: "test.handover",
			version: 1,
			initial: () => ({ phase: "a" }),
			phases: {
				a: async (_task, runtime, ctx) => {
					oldRuntime = runtime;
					await gate.promise;
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "b" } }), ctx);
					// Hold the next commit, the handover, in storage.
					held = storage.holdCommits();
				},
				b: async () => {},
				c: async () => {},
			},
			abort: async () => {},
		});
		addTask(registry, Old);
		const { harness } = await openTasks(storage, [], { registry });
		const id = await createIn(harness, Old);
		harness.resume();
		await eventually(() => oldRuntime !== undefined);
		// The same extension name replaces the old one in place.
		addTask(registry, handoverTask("new", 1, log));
		gate.resolve();
		await eventually(() => held !== undefined);
		await held!.entered;
		// Queued behind the handover commit while the invocation has not ended yet.
		const late = oldRuntime!.commit(() => completed(null), context);
		held!.release();
		await expect(late).rejects.toThrow("invocation has ended");
		await harness.waitForTask(id, context);
		expect(log).toEqual(["new:b start", "new:b end", "new:c"]);
		await harness.close(context);
	});
});
