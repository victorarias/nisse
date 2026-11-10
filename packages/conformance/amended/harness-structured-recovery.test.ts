// Amends upstream/test/harness-structured.test.ts > recovery and recovery through ownership edges (spec 5.5,
// amendments.json): "resumes a parent whose awaited children finished before the crash", "marks failFast siblings a
// crash left unmarked", "finalizes a held outcome whose work drained before the crash, and keeps one whose work lives",
// "resumes a bottom-up abort a crash interrupted before the cascade", and "shows an abort-marked owner waiting for work
// in its owned conversation before resume after reopen". The same trees, records, reopens and checks, except how the
// crash-left records are written: upstream replaces them through the Session's internal `Transaction.setTask()` via a
// cast; these read each record back through the public Storage port (`Storage.task()`) and commit the changed record
// as a `task` write through `Storage.commit()` (src/testing's `commitWrites`), with no Session open, before opening the
// Harness. The trees themselves are still created through a Session, as upstream does.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	createSession,
	defineTask,
	type Harness,
	type NextTaskState,
	type Storage,
	type StorageWrite,
	type TaskId,
	type TaskOptions,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../upstream/src/storage/sqlite/node.ts";
import { commitWrites } from "../upstream/src/testing/commit-writes.ts";
import { waitFor } from "../upstream/test/chat-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { aborted, type Deferred, deferred, openTasks } from "../upstream/test/task-support.ts";

type NodeInput = { name: string };
type NodeCheckpoint = { phase: "run" } | { phase: "resume"; round: number };
type NodeRuntime = TaskRuntime<NodeInput, NodeCheckpoint, string, object>;
type Next = NextTaskState<NodeCheckpoint, string>;

const gates = new Map<string, Deferred<"completed">>();
/** Handler starts in order, such as `run:a`, `abort:a`. */
const log: string[] = [];

function gate(name: string): Deferred<"completed"> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<"completed">();
		gates.set(name, found);
	}
	return found;
}

function end(name: string): Next {
	return { status: "terminal", outcome: { status: "completed", result: name } };
}

/** Runs until its gate opens or it is aborted; resumes by completing; aborts by ending aborted. */
const Node = defineTask<NodeInput, NodeCheckpoint, string>({
	name: "test.node",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime: NodeRuntime, ctx: Context) => {
			const name = task.input.name;
			log.push(`run:${name}`);
			await Promise.race([gate(name).promise, aborted(runtime.signal)]);
			await runtime.commit(() => end(name), ctx);
		},
		resume: async (task, runtime: NodeRuntime, ctx: Context) => {
			log.push(`resume:${task.input.name}`);
			await runtime.commit(() => end(task.input.name), ctx);
		},
	},
	abort: async (task, runtime, ctx) => {
		const name = task.input.name;
		log.push(`abort:${name}`);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: name } }), ctx);
	},
});

const OWN_CONVERSATION: TaskOptions = { ownership: { kind: "conversation" } };

function spawn(tx: Tx, owner: TaskId, name: string): Promise<TaskId<string>> {
	return tx.createTask(Node, { name }, { ownership: { kind: "task", taskId: owner } });
}

async function openNodes(storage: Storage): Promise<{ harness: Harness; root: Conversation }> {
	const opened = await openTasks(storage, [Node]);
	const root = await opened.harness.root(context);
	opened.harness.resume();
	return { harness: opened.harness, root };
}

async function outcomeOf(harness: Harness, id: TaskId): Promise<string> {
	return (await harness.waitForTask(id, context)).state.outcome.status;
}

const directories = new Set<string>();

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "nisse-structured-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

afterEach(async () => {
	gates.clear();
	log.length = 0;
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

/** Create a tree through a Session over SQLite at `path`, then close it. */
async function build<T>(path: string, create: (tx: Tx) => Promise<T>): Promise<T> {
	const session = createSession(await openNodeSqliteStorage(path));
	const built = await session.commit(create, context);
	await session.close(context);
	return built;
}

/** Replace fields of stored task records through the Storage port, in one batch, as a crash could have left them. */
async function edit(path: string, patches: readonly (readonly [TaskId, object])[]): Promise<void> {
	const storage = await openNodeSqliteStorage(path);
	const writes: StorageWrite[] = [];
	for (const [id, patch] of patches) {
		const record = await storage.task(id, context);
		if (record === undefined) throw new Error(`Task ${id} is not stored`);
		writes.push({ type: "task", value: { ...record, ...patch } } as StorageWrite);
	}
	await commitWrites(storage, writes, context);
	await storage.close(context);
}

type Seeded = { parent: TaskId; children: TaskId[] };

/** `parent` in its own ownerless conversation, with children named `children`; `patches` then edits the records. */
async function seed(
	path: string,
	children: readonly string[],
	patches: (seeded: Seeded) => readonly (readonly [TaskId, object])[],
): Promise<Seeded> {
	const seeded = await build(path, async (tx) => {
		const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
		const parent = await tx.createTask(Node, { name: "parent" }, { ...OWN_CONVERSATION, conversationId: root.id });
		const ids: TaskId[] = [];
		for (const name of children) ids.push(await spawn(tx, parent, name));
		return { parent, children: ids };
	});
	await edit(path, patches(seeded));
	return seeded;
}

const COMPLETED = { status: "terminal", outcome: { status: "completed", result: "done" } };
const FAILED = { status: "terminal", outcome: { status: "failed", error: { message: "declined" } } };

describe("recovery", () => {
	it("resumes a parent whose awaited children finished before the crash", async () => {
		const path = await sqlitePath();
		const { parent, children } = await seed(path, ["c1"], ({ parent, children }) => [
			[children[0]!, { state: COMPLETED }],
			[parent, { state: { status: "waiting", checkpoint: { phase: "resume", round: 1 }, on: children, policy: "allSettled" } }],
		]);
		const { harness } = await openNodes(await openNodeSqliteStorage(path));
		expect(await outcomeOf(harness, parent)).toBe("completed");
		expect(log).toEqual(["resume:parent"]);
		expect(children).toHaveLength(1);
		await harness.close(context);
	});

	it("marks failFast siblings a crash left unmarked", async () => {
		const path = await sqlitePath();
		const { parent, children } = await seed(path, ["c1", "c2"], ({ parent, children }) => [
			[children[0]!, { state: FAILED }],
			[parent, { state: { status: "waiting", checkpoint: { phase: "resume", round: 1 }, on: children, policy: "failFast" } }],
		]);
		const { harness } = await openNodes(await openNodeSqliteStorage(path));
		expect(await outcomeOf(harness, children[1]!)).toBe("aborted");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		expect(log).not.toContain("run:c2");
		await harness.close(context);
	});

	it("finalizes a held outcome whose work drained before the crash, and keeps one whose work lives", async () => {
		const path = await sqlitePath();
		const held = { status: "completing", outcome: { status: "completed", result: "parent" } };
		const { parent, children } = await seed(path, ["c1"], ({ parent }) => [[parent, { state: held }]]);
		let opened = await openNodes(await openNodeSqliteStorage(path));
		await waitFor(() => log.includes("run:c1"));
		expect((await opened.harness.getTask(parent, context))!.state).toEqual(held);
		await opened.harness.close(context);

		opened = await openNodes(await openNodeSqliteStorage(path));
		gate("c1").resolve("completed");
		expect(await outcomeOf(opened.harness, children[0]!)).toBe("completed");
		expect(await outcomeOf(opened.harness, parent)).toBe("completed");
		await opened.harness.close(context);

		const drained = await sqlitePath();
		const second = await seed(drained, ["c1"], ({ parent, children }) => [
			[children[0]!, { state: COMPLETED }],
			[parent, { state: held }],
		]);
		opened = await openNodes(await openNodeSqliteStorage(drained));
		expect(await outcomeOf(opened.harness, second.parent)).toBe("completed");
		await opened.harness.close(context);
	});

	it("resumes a bottom-up abort a crash interrupted before the cascade", async () => {
		const path = await sqlitePath();
		const { parent, children } = await seed(path, ["c1"], ({ parent, children }) => [
			[
				parent,
				{
					abortRequested: true,
					state: { status: "waiting", checkpoint: { phase: "resume", round: 1 }, on: children, policy: "allSettled" },
				},
			],
		]);
		const { harness } = await openNodes(await openNodeSqliteStorage(path));
		expect(await outcomeOf(harness, parent)).toBe("aborted");
		expect(await outcomeOf(harness, children[0]!)).toBe("aborted");
		expect(log.filter((line) => line.startsWith("abort:"))).toEqual(["abort:c1", "abort:parent"]);
		await harness.close(context);
	});
});

describe("recovery through ownership edges", () => {
	it("shows an abort-marked owner waiting for work in its owned conversation before resume after reopen", async () => {
		const path = await sqlitePath();
		const tree = await build(path, async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const owner = await tx.createTask(Node, { name: "owner" }, { ...OWN_CONVERSATION, conversationId: conversation.id });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			const inner = await tx.createTask(Node, { name: "inner" }, { ...OWN_CONVERSATION, conversationId: child.id });
			return { owner, inner };
		});
		await edit(path, [[tree.owner, { abortRequested: true }]]);

		const { harness } = await openTasks(await openNodeSqliteStorage(path), [Node]);
		const inspected = (await harness.inspect(context)).tasks.find((task) => task.record.id === tree.owner);
		expect(inspected?.state).toEqual({ kind: "waiting", on: [tree.inner] });
		harness.resume();
		expect(await outcomeOf(harness, tree.owner)).toBe("aborted");
		expect(log.filter((line) => line.startsWith("abort:"))).toEqual(["abort:inner", "abort:owner"]);
		await harness.close(context);
	});
});
