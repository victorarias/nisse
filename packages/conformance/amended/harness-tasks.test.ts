// Amends upstream/test/harness-tasks.test.ts > "commits results with entries atomically, keeps memos until terminal,
// and retires task documents" (spec section 3.2, amendments.json): the same task, commits and checks, with the task
// document's retirement shown through a snapshot instead of upstream's document-scan and cache counters.
import type { Context } from "@earendil-works/chord/context";
import {
	defineDoc,
	defineEntry,
	defineTask,
	type EntryId,
	MemoryStorage,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { user } from "../upstream/test/harness-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { completed, openTasks } from "../upstream/test/task-support.ts";

type Step = { phase: "run" };

function oneStep(
	name: string,
	run: (runtime: TaskRuntime<null, Step, null, object>, context: Context) => Promise<void>,
) {
	return defineTask<null, Step, null>({
		name,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (_task, runtime, ctx) => run(runtime, ctx) },
		abort: async () => {},
	});
}

describe("task phases", () => {
	it("commits results with entries atomically, keeps memos until terminal, and retires task documents", async () => {
		const Progress = defineDoc<{ lines: string[] }>({
			checkpointWhen: () => false,
			kind: "test.task-progress",
			version: 1,
			scope: "task",
			initial: () => ({ lines: [] }),
		});
		const Answer = defineEntry("answer");
		const Child = oneStep("test.child", async (runtime, ctx) => {
			await runtime.commit(() => completed(null), ctx);
		});
		let childId: TaskId | undefined;
		let progressSeen: unknown;
		const Writer = defineTask<null, { phase: "write" } | { phase: "answer" }, { entryId: EntryId }>({
			name: "test.writer",
			version: 1,
			initial: () => ({ phase: "write" }),
			phases: {
				write: async (task, runtime, ctx) => {
					expect(await runtime.memo("choice", ctx)).toBeUndefined();
					const winners = await Promise.all([runtime.memo("choice", "a", ctx), runtime.memo("choice", "b", ctx)]);
					expect(winners).toEqual(["a", "a"]);
					expect(await runtime.memo("choice", ctx)).toBe("a");
					// Memo names never resolve to inherited object properties.
					expect(await runtime.memo("toString", ctx)).toBeUndefined();
					expect(await runtime.memo("toString", "own", ctx)).toBe("own");
					await runtime.commit(async (tx) => {
						(await tx.doc(Progress, task.id)).lines.push("wrote");
						// Task creation defaults to the task's own conversation.
						childId = await tx.createTask(Child, null, { ownership: { kind: "conversation" } });
						return { status: "running", checkpoint: { phase: "answer" } };
					}, ctx);
				},
				answer: async (task, runtime, ctx) => {
					expect(task.memos).toEqual({ choice: "a", toString: "own" });
					await runtime.commit(async (tx) => {
						progressSeen = [...(await tx.doc(Progress, task.id)).lines];
					}, ctx);
					await runtime.commit(async (tx, current) => {
						const entry = await tx.appendEntry(current.conversationId, { kind: "answer", model: [user("done")] });
						return completed({ entryId: entry.id });
					}, ctx);
				},
			},
			abort: async () => {},
		});
		const { harness } = await openTasks(new MemoryStorage(), [Writer, Child]);
		const root = await harness.root(context);
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const id = await conversation.commit(
			(tx) => tx.createTask(Writer, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state).not.toHaveProperty("checkpoint");
		expect(receipt).not.toHaveProperty("memos");
		const outcome = receipt.state.outcome;
		if (outcome.status !== "completed") throw new Error("expected completion");
		const entry = await harness.commit((tx) => tx.entry(outcome.result.entryId), context);
		expect(Answer.is(entry)).toBe(true);
		expect(entry?.conversationId).toBe(conversation.id);
		expect(progressSeen).toEqual(["wrote"]);
		// The terminal commit retired the task's document: no snapshot reads it any more.
		expect(await harness.snapshot(Progress, id, context)).toBeUndefined();
		expect(await harness.getTask(id, context)).toEqual(receipt);
		expect((await harness.waitForTask(childId!, context)).conversationId).toBe(conversation.id);
		expect(root.id).not.toBe(conversation.id);
		await harness.close(context);
	});
});
