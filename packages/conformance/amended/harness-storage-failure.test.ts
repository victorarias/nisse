// Amends upstream/test/harness-storage-failure.test.ts > "keeps feeding the other observers of a view when one throws"
// (spec section 9.3, amendments.json): the throwing observer is attached through the public
// `Harness.observeConversation()` instead of the internal `conversationViews()`. The checks are upstream's: the error
// is reported once, the conversation's watch still advances, and the close ends it `ended`.
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, onValue } from "../upstream/test/session-support.ts";
import { openTasks } from "../upstream/test/task-support.ts";

describe("listener and report errors", () => {
	it("keeps feeding the other observers of a view when one throws", async () => {
		const { harness, reports } = await openTasks(new MemoryStorage(), []);
		const root = await harness.root(context);
		const failure = new Error("observer broke");
		await harness.observeConversation(
			root.id,
			{
				advance: () => {
					throw failure;
				},
				end: () => {},
			},
			context,
		);
		const watch = await root.watch(context);
		const seen: unknown[] = [];
		watch.start(
			onValue(async ({ value }) => {
				seen.push(value);
			}),
		);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(reports).toEqual([failure]);
		await harness.close(context);
		expect(await watch.closed).toEqual({ kind: "ended" });
	});
});
