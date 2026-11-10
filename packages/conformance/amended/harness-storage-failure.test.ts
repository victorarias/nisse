// Amends upstream/test/harness-storage-failure.test.ts > "keeps feeding the other observers of a view when one throws"
// (spec section 9.3, amendments.json): the throwing observer is attached through the public
// `Harness.observeConversation()` instead of the internal `conversationViews()`. The checks are upstream's: the error
// is reported once, the conversation's watch still advances, and the close ends it `ended`. Upstream polls for the
// watch's value with 1 ms sleeps; this waits on the value itself, with a deadline, and closes the Harness either way.
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, onValue } from "../upstream/test/session-support.ts";
import { deferred, openTasks } from "../upstream/test/task-support.ts";

/** Settles with `promise`, or fails naming `what` once `ms` pass without it. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

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
		const seen = deferred();
		watch.start(
			onValue(async () => {
				seen.resolve();
			}),
		);
		try {
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
			await within(seen.promise, 5_000, "the watch's value after the commit");
			expect(reports).toEqual([failure]);
		} finally {
			await harness.close(context);
		}
		expect(await within(watch.closed, 5_000, "the watch's end after the close")).toEqual({ kind: "ended" });
	});
});
