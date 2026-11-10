// Amends upstream/test/harness-structured.test.ts > "keeps running phases after spawning and waits on subsets in
// sequence" (spec 5.5): the same tasks, waits and checks, except that the opened child's wait is awaited. Upstream
// samples it after one `setTimeout(0)`, which holds only while a commit and its wake take no macrotask; the Effect
// kernel dispatches fibers with `setImmediate`, and about one run in a hundred needs a second turn.
import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineTask,
	type Harness,
	MemoryStorage,
	type NextTaskState,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { waitFor } from "../upstream/test/chat-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { type Deferred, deferred, openTasks } from "../upstream/test/task-support.ts";

type NodeInput = { name: string };
type NodeCheckpoint = { phase: "run" } | { phase: "resume"; round: number };
type Next = NextTaskState<NodeCheckpoint, string>;
type NodeRuntime = TaskRuntime<NodeInput, NodeCheckpoint, string, object>;

const gates = new Map<string, Deferred<void>>();
const log: string[] = [];
const gate = (name: string): Deferred<void> => {
	if (!gates.has(name)) gates.set(name, deferred<void>());
	return gates.get(name)!;
};
const done = (name: string): Next => ({ status: "terminal", outcome: { status: "completed", result: name } });

/** The parent spawns a, b and c, then waits on [a], then on [b, c]; each child ends once its gate opens. */
const ids: TaskId[] = [];
const Node = defineTask<NodeInput, NodeCheckpoint, string>({
	name: "test.node",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime: NodeRuntime, ctx: Context) => {
			const name = task.input.name;
			if (name !== "parent") {
				await gate(name).promise;
				return runtime.commit(() => done(name), ctx);
			}
			await runtime.commit(async (tx: Tx) => {
				for (const child of ["a", "b", "c"]) {
					ids.push(await tx.createTask(Node, { name: child }, { ownership: { kind: "task", taskId: runtime.taskId } }));
				}
				return { status: "running", checkpoint: { phase: "resume", round: 0 } };
			}, ctx);
		},
		resume: async (task, runtime: NodeRuntime, ctx: Context) => {
			const round = (task.state.checkpoint as { round: number }).round;
			log.push(`round:${round}`);
			if (round === 0) {
				return runtime.commit(() => ({ status: "waiting", checkpoint: { phase: "resume", round: 1 }, on: [ids[0]!], policy: "allSettled" }), ctx);
			}
			if (round === 1) {
				return runtime.commit(
					() => ({ status: "waiting", checkpoint: { phase: "resume", round: 2 }, on: [ids[1]!, ids[2]!], policy: "failFast" }),
					ctx,
				);
			}
			await runtime.commit(() => done("parent"), ctx);
		},
	},
	abort: async (_task, runtime: NodeRuntime, ctx: Context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: "aborted" } }), ctx);
	},
});

const state = async (harness: Harness, id: TaskId) => (await harness.getTask(id, context))!.state;

describe("waiting", () => {
	it("keeps running phases after spawning and waits on subsets in sequence", async () => {
		const { harness } = await openTasks(new MemoryStorage(), [Node]);
		const root: Conversation = await harness.root(context);
		harness.resume();
		const parent = await root.commit((tx) => tx.createTask(Node, { name: "parent" }, { ownership: { kind: "conversation" } }), context);
		await waitFor(() => log.includes("round:0"));
		await waitFor(async () => (await state(harness, parent)).status === "waiting");
		// b, in the second subset, ends first: the parent goes on waiting for a.
		gate("b").resolve();
		expect((await harness.waitForTask(ids[1]!, context)).state.outcome.status).toBe("completed");
		expect((await state(harness, parent)).status).toBe("waiting");
		expect(log).toEqual(["round:0"]);
		gate("a").resolve();
		await waitFor(() => log.includes("round:1"));
		gate("c").resolve();
		expect((await harness.waitForTask(parent, context)).state.outcome.status).toBe("completed");
		expect(log).toEqual(["round:0", "round:1", "round:2"]);
		await harness.close(context);
	});
});
