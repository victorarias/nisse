// Amends four tests of upstream/test/harness-scheduler-retention.test.ts (spec sections 5.4 and 5.5,
// amendments.json). Each keeps its tree and its outcome, through public calls only:
// - "holds a live owner for work later created in a forgotten conversation, loading its chain again" keeps the holding
//   assertions and drops the bound on upstream's scheduler index sizes.
// - "aborts work created in a forgotten conversation below an abort-marked owner before it runs" marks the owner with
//   abortTask() instead of writing the mark with a private setTask(), and its live child holds it with a slow abort
//   handler, so P is still cancelling when the late work is created.
// - "withdraws an input queued two ended levels below an owner whose intent appears later" fails the owner from its own
//   phase instead of writing its state with a private setTask(), and waits on the submission status alone.
// - "loads the chain of new work below a forgotten conversation before admitting it, and keeps the scope busy" (5.4)
//   keeps the reopen and the held chain read, and drops upstream's check that the commit waits for that read: when the
//   chain loads is the scheduler's own choice, since the spec promises no outcome that depends on it. It checks what
//   section 5.4's idle traversal promises instead: Harness idle and the conversation's idle stay pending while the
//   chain read is held and after it, and resolve once the new task ends.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTask, type Harness, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../upstream/src/storage/sqlite/node.ts";
import { context } from "../upstream/test/session-support.ts";
import { aborted, type Deferred, deferred, eventually, openTasks, settled } from "../upstream/test/task-support.ts";

const gates = new Map<string, Deferred<void>>();
function gate(name: string): Deferred<void> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<void>();
		gates.set(name, found);
	}
	return found;
}

/** How often each named task started its phase. */
const runs = new Map<string, number>();

/**
 * Holds until its gate opens, then completes, or fails with `fail`; its abort handler ends it `aborted`, with
 * `slowAbort` once the gate `abort.<name>` opens.
 */
const Hold = defineTask<{ name: string; fail?: boolean; slowAbort?: boolean }, { phase: "hold" }, null>({
	name: "test.retention.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			runs.set(task.input.name, (runs.get(task.input.name) ?? 0) + 1);
			const opened = await Promise.race([gate(task.input.name).promise.then(() => true), aborted(runtime.signal)]);
			if (opened !== true) return;
			await runtime.commit(
				() =>
					task.input.fail === true
						? { status: "terminal", outcome: { status: "failed", error: { message: "x" } } }
						: { status: "terminal", outcome: { status: "completed", result: null } },
				ctx,
			);
		},
	},
	abort: async (task, runtime, ctx) => {
		if (task.input.slowAbort === true) await gate(`abort.${task.input.name}`).promise;
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

const directories: string[] = [];
afterEach(async () => {
	gates.clear();
	runs.clear();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-retention-"));
	directories.push(directory);
	return join(directory, "session.sqlite");
}

async function open(storage?: Awaited<ReturnType<typeof openNodeSqliteStorage>>) {
	const opened = await openTasks(storage ?? (await openNodeSqliteStorage(await sqlitePath())), [Hold]);
	const root = await opened.harness.root(context);
	opened.harness.resume();
	return { ...opened, root };
}

async function status(harness: Harness, id: TaskId) {
	return (await harness.getTask(id, context))!.state;
}

describe("scheduler retention", () => {
	it("holds a live owner for work later created in a forgotten conversation, loading its chain again", async () => {
		const { harness, root } = await open();
		// Live P -> ended B -> ended A -> conversation C, empty: forgotten.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			return { p, b, a, c: c.id };
		}, context);
		gate("a").resolve();
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		const c = (await harness.conversation(tree.c, context))!;
		const d = await c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		gate("p").resolve();
		// P holds for D: the scheduler loaded the chain from C up to P again.
		await eventually(async () => (await status(harness, tree.p)).status === "completing");
		gate("d").resolve();
		expect((await harness.waitForTask(d, context)).state.outcome.status).toBe("completed");
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("aborts work created in a forgotten conversation below an abort-marked owner before it runs", async () => {
		const { harness, root } = await open();
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			const keep = await tx.createTask(
				Hold,
				{ name: "keep", slowAbort: true },
				{ ownership: { kind: "task", taskId: p } },
			);
			return { p, b, c: c.id, keep };
		}, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		// P cancels; its live child keeps it holding until its own abort ends.
		const aborting = harness.abortTask(tree.p, context);
		await eventually(async () => (await harness.getTask(tree.keep, context))!.abortRequested);
		const c = (await harness.conversation(tree.c, context))!;
		const late = await c.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		expect((await harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		expect(runs.get("late") ?? 0).toBe(0);
		gate("abort.keep").resolve();
		await aborting;
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("withdraws an input queued two ended levels below an owner whose intent appears later", async () => {
		const { harness, root } = await open();
		// Live P -> ended B -> ended A -> conversation C with no task, and a live child keeping P holding.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p", fail: true }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			const keep = await tx.createTask(Hold, { name: "keep" }, { ownership: { kind: "task", taskId: p } });
			return { p, b, c: c.id, keep };
		}, context);
		gate("a").resolve();
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		const c = (await harness.conversation(tree.c, context))!;
		await c.commit(async (tx) => {
			(await tx.doc(LiveDoc, tree.c)).run = { taskId: tree.keep, inputs: [], turns: 0 };
		}, context);
		// Queued while nothing cancels.
		const queued = (await c.submit({ type: "input", content: "later" }, context)).id;
		// P fails while its child runs: it holds the failed outcome, which is cancellation intent.
		gate("p").resolve();
		await eventually(
			async () => (await (await harness.submission(queued, context))!.status(context)).status === "unanswered",
		);
		expect(await (await harness.submission(queued, context))!.status(context)).toMatchObject({ reason: "aborted" });
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("failed");
		await harness.close(context);
	});
	it("loads the chain of new work below a forgotten conversation before admitting it, and keeps the scope busy", async () => {
		const path = await sqlitePath();
		const { harness, root } = await open(await openNodeSqliteStorage(path));
		const tree = await root.commit(async (tx) => {
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "conversation" } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			return { b, c: c.id };
		}, context);
		gate("b").resolve();
		await harness.waitForTask(tree.b, context);
		await harness.close(context);
		// Reopen, so that B is in no cache: the chain load reads it from Storage. Hold that read.
		const reopened = await openNodeSqliteStorage(path);
		const read = reopened.task.bind(reopened);
		const held = deferred<void>();
		const reached = deferred<void>();
		let holding = false;
		reopened.task = async (id, readContext) => {
			if (holding && id === tree.b) {
				reached.resolve();
				await held.promise;
			}
			return read(id, readContext);
		};
		const second = (await open(reopened)).harness;
		const c = (await second.conversation(tree.c, context))!;
		holding = true;
		const committing = c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await reached.promise;
		// D is live below C while its chain is unknown: both scopes that may hold it stay busy.
		const idle = second.waitForIdle(context);
		const conversationIdle = c.waitForIdle(context);
		expect(await settled(idle)).toBe(false);
		expect(await settled(conversationIdle)).toBe(false);
		held.resolve();
		const d = await committing;
		expect(await settled(idle)).toBe(false);
		expect(await settled(conversationIdle)).toBe(false);
		gate("d").resolve();
		expect((await second.waitForTask(d, context)).state.outcome.status).toBe("completed");
		await idle;
		await conversationIdle;
		await second.close(context);
	});
});
