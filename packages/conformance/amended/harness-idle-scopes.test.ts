// Amends seven "kept context ranges" tests of upstream/test/harness-idle-scopes.test.ts (spec section 5.1,
// amendments.json). Upstream reads its scheduler's idle-state counters (`SCHEDULER_IDLE_STATE`); these keep each
// test's steps and judge whether a conversation's kept context range survived by the entry rows the next read of it
// scans through Storage: none while the range is kept, the whole conversation once it was dropped.
// - "applies a shorter/longer/zero retention to idle ranges at an unrelated commit", "drops every idle range when
//   retention becomes zero, also one that went idle after the clock's now (review)" and "drops a range past its
//   retention when a task change makes it busy again, with background timers declined" read the range again.
// - "keeps an idle range's expiry when another task reads it again" keeps its row checks and drops the counter check;
//   a last read shows the first range expired at its first idle period's end.
// - "drops a range that goes idle with zero retention" reads the range from another task while its conversation is
//   busy, and again once it went idle.
import { createModels } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	type SetTimer,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { context, flush } from "../upstream/test/session-support.ts";
import { aborted, type Deferred, deferred } from "../upstream/test/task-support.ts";

const gates = new Map<string, Deferred<void>>();
/** Resolves once the named task's context read returned. */
const reads = new Map<string, Deferred<void>>();

function named<T>(map: Map<string, Deferred<T>>, name: string): Deferred<T> {
	let found = map.get(name);
	if (found === undefined) {
		found = deferred<T>();
		map.set(name, found);
	}
	return found;
}

afterEach(() => {
	gates.clear();
	reads.clear();
});

/** Reads the context of conversation `read` (when given), then holds until its gate opens and completes. */
const Work = defineTask<{ name: string; read?: number }, { phase: "run" }, null>({
	name: "test.idle.work",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			if (task.input.read !== undefined) {
				await runtime.context(task.input.read as ConversationId, ctx);
				named(reads, task.input.name).resolve();
			}
			const opened = await Promise.race([
				named(gates, task.input.name).promise.then(() => true),
				aborted(runtime.signal),
			]);
			if (opened !== true) return;
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Background timers declined, as Cloudflare Workers do; foreground ones on `setTimeout`. */
const declineBackground: SetTimer = (callback, delayMs, { background }) => {
	if (background) return undefined;
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
};

/**
 * A resumed Harness running `Work`, over MemoryStorage counting the entry rows each scan returns, with `clock` as its
 * time, the retention `retention` returns, and background timers declined.
 */
async function open(options: { clock?: () => number; retention?: () => number } = {}) {
	const scanned = { rows: 0 };
	const memory = new MemoryStorage();
	const storage = new Proxy<Storage>(memory, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (key === "scanEntries") {
				return async (...args: Parameters<Storage["scanEntries"]>) => {
					const page = await target.scanEntries(...args);
					scanned.rows += page.items.length;
					return page;
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "tasks", tasks: [Work] }));
	const retention = options.retention ?? (() => 600_000);
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry,
			settings: () => ({ contextRetentionMs: retention() }),
			...(options.clock === undefined ? {} : { now: options.clock }),
			setTimer: declineBackground,
		},
		context,
	);
	harness.resume();
	/** A new ownerless conversation with `entries` entries. */
	const conversation = async (entries = 2): Promise<Conversation> => {
		const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		for (let index = 0; index < entries; index++) {
			await created.commit((tx) => tx.appendEntry(created.id, { kind: "note", data: { index } }), context);
		}
		return created;
	};
	/** Start `Work` named `name` in `into`, reading conversation `read`, and wait for its read. */
	const work = async (name: string, into: Conversation, read?: ConversationId): Promise<TaskId> => {
		const input = read === undefined ? { name } : { name, read: read as number };
		const id = await into.commit(
			(tx) => tx.createTask(Work, input, { ownership: { kind: "conversation" }, conversationId: into.id }),
			context,
		);
		if (read !== undefined) await named(reads, name).promise;
		return id;
	};
	/** Open the gate of `name` and wait for its task, `id`, to end. */
	const end = async (name: string, id: TaskId): Promise<void> => {
		named(gates, name).resolve();
		await harness.waitForTask(id, context);
	};
	/** The entry rows a read of `read` from a new task in `into` scans. */
	const rowsOf = async (name: string, into: Conversation, read: ConversationId): Promise<number> => {
		const before = scanned.rows;
		const id = await work(name, into, read);
		const rows = scanned.rows - before;
		await end(name, id);
		return rows;
	};
	return { harness, conversation, work, end, rowsOf };
}

/** Flush until scheduler passes started by the last changes settled. */
async function quiet(): Promise<void> {
	for (let round = 0; round < 4; round++) await flush();
}

describe("kept context ranges", () => {
	it("drops a range past its retention when a task change makes it busy again, with background timers declined", async () => {
		let clock = 1_000;
		const { harness, conversation, work, end, rowsOf } = await open({ clock: () => clock, retention: () => 1_000 });
		const [x, z] = [await conversation(), await conversation(0)];
		await end("reader", await work("reader", z, x.id));
		clock = 2_500;
		// No timer expired it; the task change that makes X busy finds it past its retention.
		const busy = await work("busy", x);
		await quiet();
		expect(await rowsOf("again", z, x.id)).toBe(2);
		await end("busy", busy);
		await harness.close(context);
	});

	it("drops every idle range when retention becomes zero, also one that went idle after the clock's now (review)", async () => {
		let clock = 2_000;
		let retention = 1_000;
		const { harness, conversation, work, end, rowsOf } = await open({
			clock: () => clock,
			retention: () => retention,
		});
		const [a, z] = [await conversation(), await conversation(0)];
		await end("read", await work("read", z, a.id));
		expect(await rowsOf("kept", z, a.id)).toBe(0);
		// The clock goes back below A's idle start; then retention 0 and an unrelated task change.
		clock = 1_000;
		retention = 0;
		await end("unrelated", await work("unrelated", z));
		expect(await rowsOf("again", z, a.id)).toBe(2);
		await harness.close(context);
	});

	it("keeps an idle range's expiry when another task reads it again", async () => {
		let clock = 1_000;
		const { harness, conversation, work, end, rowsOf } = await open({
			clock: () => clock,
			retention: () => 1_000,
		});
		const [a, b, z] = [await conversation(3), await conversation(5), await conversation(0)];
		await end("read a", await work("read a", z, a.id));
		clock = 1_500;
		await end("read b", await work("read b", z, b.id));
		clock = 1_800;
		expect(await rowsOf("again a", z, a.id)).toBe(0);
		clock = 2_100;
		await end("unrelated", await work("unrelated", z));
		expect(await rowsOf("late b", z, b.id)).toBe(0);
		// A's idle period started at 1 000, not at the read at 1 800: it expired at 2 000.
		expect(await rowsOf("late a", z, a.id)).toBe(3);
		await harness.close(context);
	});

	it.each([
		["shorter", 400, 0],
		["longer", 10_000, 1],
		["zero", 0, 0],
	] as const)("applies a %s retention to idle ranges at an unrelated commit", async (_name, changed, kept) => {
		let clock = 1_000;
		let retention = 1_000;
		const { harness, conversation, work, end, rowsOf } = await open({
			clock: () => clock,
			retention: () => retention,
		});
		const [a, z] = [await conversation(), await conversation(0)];
		await end("read", await work("read", z, a.id));
		clock = 1_500;
		retention = changed;
		await end("unrelated", await work("unrelated", z));
		expect(await rowsOf("again", z, a.id)).toBe(kept === 1 ? 0 : 2);
		await harness.close(context);
	});

	it("drops a range that goes idle with zero retention", async () => {
		const { harness, conversation, work, end, rowsOf } = await open({ retention: () => 0 });
		const [a, z] = [await conversation(), await conversation(0)];
		const own = await work("own", a, a.id);
		await quiet();
		// Busy, A keeps its range for any task's read.
		expect(await rowsOf("busy", z, a.id)).toBe(0);
		await end("own", own);
		await quiet();
		expect(await rowsOf("idle", z, a.id)).toBe(2);
		await harness.close(context);
	});
});
