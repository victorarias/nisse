// Amends upstream/test/session-checkpoints-migrations.test.ts > "writes the required base on the first successful
// transaction, then writes deltas" (spec 3.6): the same documents, watches, commits and checks, except that the
// older-shape watch's root replacement is awaited. Upstream samples it after one `setTimeout(0)`, which holds only while
// a delivery takes no macrotask; the Effect kernel runs a watch's deliveries on a fiber resumed with `setImmediate`,
// which on a loaded machine can take a second turn. The `flush()` that follows stays: it precedes the check that the
// current-shape watch received nothing.
import { defineDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, documentChanges, flush, onValue, openTestSession } from "../upstream/test/session-support.ts";
import { deferred } from "../upstream/test/task-support.ts";

describe("Session document migrations", () => {
	it("writes the required base on the first successful transaction, then writes deltas", async () => {
		const Old = defineDoc<{ count: number }>({
			checkpointWhen: () => false,
			kind: "migration.transition",
			version: 1,
			scope: "session",
			initial: () => ({ count: 4 }),
		});
		let checkpoints = 0;
		const Current = defineDoc<{ count: number }>({
			kind: "migration.transition",
			version: 3,
			scope: "session",
			initial: () => ({ count: 0 }),
			migrate: (value, fromVersion) => ({ count: (value.count as number) + fromVersion - 1 }),
			checkpointWhen: () => {
				checkpoints++;
				return false;
			},
		});
		const { session, storage, publications } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		// An observer of the older shape.
		const watch = (await session.watchDoc(Old, context))!;
		const frames: unknown[] = [];
		const framed = deferred();
		watch.start(
			onValue(async ({ value, ops }) => {
				frames.push({ value, ops });
				framed.resolve();
			}),
		);
		expect(await session.snapshot(Current, context)).toEqual({ count: 4 });
		const snapshot = await session.snapshot(Current, context);
		// An observer of the new shape: the migration changes nothing it sees.
		const current = (await session.watchDoc(Current, context))!;
		const currentFrames: unknown[] = [];
		current.start(
			onValue(async ({ value }) => {
				currentFrames.push(value);
			}),
		);

		await session.commit((tx) => tx.doc(Current).then(() => undefined), context);
		await framed.promise;
		await flush();
		expect(storage.commits.at(-1)![0]).toMatchObject({
			type: "document.change",
			content: { kind: "base", version: 3, value: { count: 4 } },
		});
		expect(checkpoints).toBe(0);
		// The migration-only base is published, so the older-shape watch receives the new value as a root replacement.
		expect(documentChanges(publications.at(-1)!)).toMatchObject([{ version: 3, value: { count: 4 }, ops: [] }]);
		expect(frames).toEqual([{ value: { count: 4 }, ops: [["r", { count: 4 }]] }]);
		expect(currentFrames).toEqual([]);
		await watch.stop();
		await current.stop();
		expect(await session.snapshot(Current, context)).toBe(snapshot);

		await session.commit(async (tx) => {
			(await tx.doc(Current)).count = 7;
		}, context);
		expect(storage.commits.at(-1)![0]).toMatchObject({
			type: "document.change",
			content: { kind: "delta", version: 3 },
		});
		expect(checkpoints).toBe(1);
		await session.unloadDocuments();
		expect(await session.snapshot(Current, context)).toEqual({ count: 7 });
	});
});
