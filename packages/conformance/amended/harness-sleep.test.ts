// Amends two tests of upstream/test/harness-sleep.test.ts (spec 5.6, amendments.json). The decision that removed
// alarms (D5) takes away `HarnessOptions.onWake` and the host's `setTimer`: the kernel arms its sleep timer on Effect's
// Clock. What stays is the sleep itself.
// - "sleeps without an invocation and resumes at its checkpoint once due" keeps upstream's task and checks, without
//   `onWake` and the wakes it recorded. `wake()` is read for `at`, which the stored sleep sets; `active` follows the
//   invocation's end, which only `onWake` announced. Upstream waits with polls and 20 ms sleeps; this waits on the
//   phase's own signals, the graph watch and `waitForTask()`, each with a deadline. That early wakes run nothing is
//   checked after a task started later has completed, so the scheduling passes they started are done.
// - "resumes a due sleep with its timer without onWake, with background timers declined" checks the timer itself: on
//   the real clock, with no host timers and no `resume()` after the first, the sleep's own timer runs the next phase.
//   It waits on that phase's signal rather than `waitForTask()`, which calls `resume()` and would wake the sleep itself.
import { defineTask, MemoryStorage, type TaskGraph, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, onValue } from "../upstream/test/session-support.ts";
import { abortedWith, completed, deferred, openTasks } from "../upstream/test/task-support.ts";

/** Settles with `promise`, or fails naming `what` once `ms` pass without it. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Each wait below takes well under 100 ms on an idle machine; the deadline only names a wait that never ends, before
// vitest's 5 s test timeout does.
const DEADLINE_MS = 4_000;

type NapState = { phase: "start" } | { phase: "after"; slept: number };

/** Sleeps `delay` ms on the Harness clock, then completes with the time it resumed at; signals both steps. */
function napTask(delay: number) {
	const stored = deferred();
	const resumed = deferred<number>();
	const runs = { after: 0 };
	const task = defineTask<null, NapState, number>({
		name: "test.nap",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (_task, runtime, ctx) => {
				await runtime.sleepUntil(runtime.now() + delay, { phase: "after", slept: delay }, ctx);
				stored.resolve();
			},
			after: async (_task, runtime, ctx) => {
				runs.after++;
				const at = runtime.now();
				resumed.resolve(at);
				await runtime.commit(() => completed(at), ctx);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => abortedWith("test"), ctx);
		},
	});
	return { task, stored: stored.promise, resumed: resumed.promise, runs };
}

/** A task that completes at once: its completion shows the scheduling passes before it were done. */
const Marker = defineTask<null, { phase: "run" }, null>({
	name: "test.marker",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: { run: (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx) },
	abort: async () => {},
});

describe("sleeping tasks", () => {
	it("sleeps without an invocation and resumes at its checkpoint once due", async () => {
		let clock = 1_000;
		const nap = napTask(1_000);
		const { harness } = await openTasks(new MemoryStorage(), [nap.task, Marker], { now: () => clock });
		const asleep = deferred();
		const graph = await harness.watchTaskGraph(context);
		let id: TaskId<number> | undefined;
		graph.start(
			onValue(async ({ value }) => {
				const state = id === undefined ? undefined : (value as TaskGraph).tasks[String(id)]?.state;
				if (state?.status === "sleeping") asleep.resolve();
			}),
		);
		const root = await harness.root(context);
		id = await root.commit((tx) => tx.createTask(nap.task, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await within(nap.stored, DEADLINE_MS, "the stored sleep");
		expect((await harness.getTask(id, context))?.state).toEqual({
			status: "sleeping",
			checkpoint: { phase: "after", slept: 1_000 },
			until: 2_000,
		});
		const inspection = await harness.inspect(context);
		expect(inspection.tasks.find((task) => task.record.id === id)?.state).toEqual({ kind: "sleeping", until: 2_000 });
		await within(asleep.promise, DEADLINE_MS, "the sleeping task in the graph");
		expect(graph.value.tasks[String(id)]?.state).toEqual({ status: "sleeping", phase: "after", until: 2_000 });
		expect(harness.wake().at).toBe(2_000);

		// Early and repeated wakes run nothing.
		clock = 1_999;
		harness.resume();
		harness.resume();
		const marker = await root.commit(
			(tx) => tx.createTask(Marker, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await within(harness.waitForTask(marker, context), DEADLINE_MS, "the marker task");
		expect(nap.runs.after).toBe(0);
		expect((await harness.getTask(id, context))?.state.status).toBe("sleeping");

		clock = 2_000;
		harness.resume();
		harness.resume();
		const receipt = await within(harness.waitForTask(id, context), DEADLINE_MS, "the nap's outcome");
		expect(receipt.state.outcome).toEqual({ status: "completed", result: 2_000 });
		expect(nap.runs.after).toBe(1);
		expect(harness.wake().at).toBeUndefined();
		await graph.stop();
		await harness.close(context);
	});

	it("resumes a due sleep with its timer without onWake, with background timers declined", async () => {
		const nap = napTask(50);
		const { harness } = await openTasks(new MemoryStorage(), [nap.task]);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(nap.task, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await within(nap.stored, DEADLINE_MS, "the stored sleep");
		const sleeping = (await harness.getTask(id, context))?.state;
		expect(sleeping?.status).toBe("sleeping");
		const until = (sleeping as { until: number }).until;
		// Nothing calls `resume()` again: only the sleep's timer can run the next phase.
		const resumedAt = await within(nap.resumed, DEADLINE_MS, "the phase after the sleep");
		expect(resumedAt).toBeGreaterThanOrEqual(until);
		const receipt = await within(harness.waitForTask(id, context), DEADLINE_MS, "the nap's outcome");
		expect(receipt.state.outcome).toEqual({ status: "completed", result: resumedAt });
		await harness.close(context);
	});
});
