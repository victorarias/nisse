// Amends upstream/test/harness-tasks.test.ts > "reads committed documents and context through the runtime, and forwards
// the clock and reports" (spec 5.1): the same task, reads and checks, except that the end of the invocation is awaited.
// Upstream expects reads to fail after one `setTimeout(0)` past the task's settlement; the Effect kernel ends an
// invocation through fibers dispatched with `setImmediate`, which under load can take a second turn (2 of 16 runs on a
// loaded machine, and both platforms in main's CI at 8ca1811).
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineTask, MemoryStorage, type TaskRuntime } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { user } from "../upstream/test/harness-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { completed, eventually, openTasks } from "../upstream/test/task-support.ts";

type Step = { phase: "run" };
type StepRuntime = TaskRuntime<null, Step, null, object>;

/** Whether `read` rejects with "invocation has ended". */
async function ended(read: () => Promise<unknown>): Promise<boolean> {
	try {
		await read();
		return false;
	} catch (error) {
		expect(String(error)).toContain("invocation has ended");
		return true;
	}
}

describe("task runtime", () => {
	it("reads committed documents and context through the runtime, and forwards the clock and reports", async () => {
		const Notes = defineDoc<{ text: string }>({
			checkpointWhen: () => false,
			kind: "test.runtime-notes",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ text: "" }),
		});
		let captured: StepRuntime | undefined;
		const seen: unknown[] = [];
		const Reader = defineTask<null, Step, null>({
			name: "test.reader",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, ctx: Context) => {
					captured = runtime;
					const [first, second] = [...(await runtime.context(runtime.conversationId, ctx)).entries].map(
						(entry) => entry.id,
					);
					seen.push((await runtime.snapshot(Notes, runtime.conversationId, ctx))?.text);
					seen.push((await runtime.snapshotAsOf(Notes, runtime.conversationId, first!, ctx))?.text);
					seen.push((await runtime.context(runtime.conversationId, ctx, { at: first })).entries.length);
					seen.push((await runtime.context(runtime.conversationId, ctx, { at: second })).messages.length);
					seen.push(runtime.now());
					runtime.report(new Error("reported"));
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		const { harness, reports } = await openTasks(new MemoryStorage(), [Reader], { now: () => 1234 });
		const root = await harness.root(context);
		for (const text of ["one", "two"]) {
			await root.commit(async (tx) => {
				(await tx.doc(Notes, root.id)).text = text;
				await tx.appendEntry(root.id, { kind: "message", model: [user(text)] });
			}, context);
		}
		const id = await root.commit(
			(tx) => tx.createTask(Reader, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await harness.waitForTask(id, context);
		expect(seen).toEqual(["two", "one", 1, 2, 1234]);
		expect(reports).toEqual([new Error("reported")]);
		// The step after the phase ends the invocation; then every read through it fails.
		await eventually(() => ended(() => captured!.snapshot(Notes, root.id, context)));
		expect(await ended(() => captured!.context(root.id, context))).toBe(true);
		await harness.close(context);
	});
});
