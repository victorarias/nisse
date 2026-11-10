// Amends upstream/test/sqlite-storage.test.ts > "rolls SQL rows and sequence allocation back as one transaction"
// (spec section 10, amendments.json): the same commit and checks, without V8's JSON.stringify message, which
// JavaScriptCore words differently ("JSON.stringify cannot serialize cyclic structures.").
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../upstream/src/storage/sqlite/node.ts";
import { commitWrites } from "../upstream/src/testing/commit-writes.ts";
import type { EntryId, TaskId } from "../upstream/src/types.ts";
import { ROOT_CONVERSATION_ID } from "../upstream/src/types.ts";

const context = BACKGROUND_CONTEXT;
const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

const entry = (id: EntryId) => ({ id, conversationId: ROOT_CONVERSATION_ID, kind: "message" });

describe("Pico SqliteStorage", () => {
	it("rolls SQL rows and sequence allocation back as one transaction", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-sqlite-"));
		directories.add(directory);
		const path = join(directory, "storage.sqlite");
		const storage = await openNodeSqliteStorage(path);
		try {
			await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
			const transientId = await storage.mintId<EntryId>();
			const transientTaskId = await storage.mintId<TaskId<JsonValue>>();
			const circular: { self?: unknown } = {};
			circular.self = circular;
			await expect(
				commitWrites(
					storage,
					[
						{ type: "entry", value: entry(transientId) },
						{
							type: "task",
							value: {
								id: transientTaskId,
								conversationId: ROOT_CONVERSATION_ID,
								kind: "test.task",
								version: 1,
								input: circular as unknown as JsonValue,
								state: { status: "pending", checkpoint: { phase: "ready" } },
								background: false,
								abortRequested: false,
							},
						},
					],
					context,
				),
			).rejects.toThrow(TypeError);
			expect(await storage.entry(transientId, context)).toBeUndefined();
			expect(await storage.task(transientTaskId, context)).toBeUndefined();
			const committedId = await storage.mintId<EntryId>();
			expect(await commitWrites(storage, [{ type: "entry", value: entry(committedId) }], context)).toBe(2);
		} finally {
			await storage.close(context);
		}

		const db = new DatabaseSync(path, { readOnly: true });
		try {
			expect((db.prepare("SELECT count(*) AS value FROM entries").get() as { value: number }).value).toBe(1);
			expect(
				(db.prepare("SELECT next_seq AS value FROM durable_metadata WHERE singleton = 1").get() as { value: number })
					.value,
			).toBe(3);
		} finally {
			db.close();
		}
	});
});
