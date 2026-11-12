// Amends upstream/test/harness-blocked.test.ts > "tells the graph and the host when a migration fails" (spec 9.4,
// amendments.json). The host half is `HarnessOptions.onWake`, which the decision that removed alarms (D5) takes away.
// The graph half stays: a task whose stored version its definition cannot migrate shows as blocked with
// `migration_failed` in the task graph, and no other row checks that. Upstream polls for the graph's value; this waits
// on the watch's own call, with a deadline.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, defineExtension, defineTask, type TaskGraph } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../upstream/src/storage/sqlite/node.ts";
import { context, onValue } from "../upstream/test/session-support.ts";
import { deferred, openTasks } from "../upstream/test/task-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-blocked-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** Settles with `promise`, or fails naming `what` once `ms` pass without it. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

describe("tasks that cannot run", () => {
	it("tells the graph and the host when a migration fails", async () => {
		const path = await sqlitePath();
		const run = { phases: { run: async () => {} }, abort: async () => {} } as const;
		const V1 = defineTask<null, { phase: "run" }, null>({
			name: "test.migrating",
			version: 1,
			initial: () => ({ phase: "run" }),
			...run,
		});
		const V2 = defineTask<null, { phase: "run" }, null>({
			name: "test.migrating",
			version: 2,
			initial: () => ({ phase: "run" }),
			...run,
			migrate: () => {
				throw new Error("cannot migrate");
			},
		});
		const first = createRegistry();
		first.install(defineExtension({ name: "v1", tasks: [V1] }));
		const before = await openTasks(await openNodeSqliteStorage(path), [], { registry: first });
		// Created, never run: scheduling stays off.
		const id = await (await before.harness.root(context)).commit(
			(tx) => tx.createTask(V1, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await before.harness.close(context);

		const second = createRegistry();
		second.install(defineExtension({ name: "v2", tasks: [V2] }));
		const { harness } = await openTasks(await openNodeSqliteStorage(path), [], { registry: second });
		const graph = await harness.watchTaskGraph(context);
		const blocked = deferred();
		const check = (value: TaskGraph) => {
			if (value.tasks[String(id)]?.blocked === "migration_failed") blocked.resolve();
		};
		check(graph.value);
		graph.start(onValue(async ({ value }) => check(value as TaskGraph)));
		harness.resume();
		await within(blocked.promise, 4_000, "the blocked task in the graph");
		expect(graph.value.tasks[String(id)]?.blocked).toBe("migration_failed");
		await graph.stop();
		await harness.close(context);
	});
});
