// Amends upstream/test/harness-storage-failure.test.ts > "keeps feeding the other observers of a view when one throws"
// (spec section 9.3, amendments.json): the throwing observer is attached through the public
// `Harness.observeConversation()` instead of the internal `conversationViews()`. The checks are upstream's: the error
// is reported once, the conversation's watch still advances, and the close ends it `ended`. Upstream polls for the
// watch's value with 1 ms sleeps; this waits on the value itself, with a deadline, and closes the Harness either way.
//
// Amends upstream/test/harness-storage-failure.test.ts > "does not fail it for a read its caller cancelled" (spec
// section 10.1, with sigma's D6 amendment): upstream's Storage sees the caller's abort signal in its Context and throws
// the abort reason itself. Sigma's Storage port takes no Context; cancelling the caller interrupts its read instead
// (D6). So the Storage here holds the context read, the caller aborts while it is held, and the checks are upstream's:
// the read rejects with the caller's reason, nothing is reported, and a later commit goes through.
import type { Context } from "@earendil-works/chord/context";
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

describe("a failed Storage call", () => {
	it("does not fail it for a read its caller cancelled", async () => {
		const entered = deferred();
		const release = deferred();
		let holding = false;
		class HeldRead extends MemoryStorage {
			override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
				if (holding) {
					holding = false;
					entered.resolve();
					await release.promise;
				}
				return super.scanEntries(...args);
			}
		}
		const { harness, reports } = await openTasks(new HeldRead(), []);
		const root = await harness.root(context);
		try {
			// An entry to scan: the Session's cache answers the bounds of the context, not its entries.
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
			const controller = new AbortController();
			const cancelled = new Error("caller gave up");
			const cancelling: Context = { ...context, abortSignal: controller.signal };
			holding = true;
			const reading = root.context(cancelling);
			await within(entered.promise, 5_000, "the context's entry scan");
			controller.abort(cancelled);
			await expect(within(reading, 5_000, "the cancelled context read")).rejects.toBe(cancelled);
			release.resolve();
			await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context)).resolves.toBeDefined();
			expect(reports).toEqual([]);
		} finally {
			release.resolve();
			await harness.close(context);
		}
	});
});
