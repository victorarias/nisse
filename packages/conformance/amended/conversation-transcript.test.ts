// Amends two tests of upstream/test/conversation-transcript.test.ts (spec section 9.3, amendments.json): concurrent
// `loadEarlier()` calls, and `fillGap()` calls for one gap, share one load. Upstream checks that the calls return the
// same Promise object; nisse's transcript returns Effects, so each Promise is the adapter's own. These rewrites keep
// upstream's setup and check the shared load itself: one loader call, and one result every caller gets.
import {
	ConversationTranscript,
	type ConversationView,
	type Cursor,
	type EntryLoader,
	type EntryRecord,
	type TranscriptItem,
	type TranscriptView,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context } from "../upstream/test/session-support.ts";
import { deferred } from "../upstream/test/task-support.ts";

const CONVERSATION = { id: 1 } as unknown as ConversationView["conversation"];

/** Entries with IDs that have holes: every third ID is missing. */
function transcript(count: number): EntryRecord[] {
	const entries: EntryRecord[] = [];
	for (let id = 1; entries.length < count; id++) {
		if (id % 3 !== 0) entries.push({ id, conversationId: CONVERSATION.id, kind: "note" } as unknown as EntryRecord);
	}
	return entries;
}

/** A loader over `entries` with `Conversation.entries()` semantics, counting its calls. */
function loader(entries: readonly EntryRecord[]): EntryLoader & { calls: number } {
	const load = async (query: Parameters<EntryLoader>[0], limit: number) => {
		load.calls++;
		const matching = entries.filter(
			(entry) =>
				(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
				(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
		);
		const ordered = query.order === "ascending" ? matching : [...matching].reverse();
		const items = ordered.slice(0, limit);
		return { items, ...(ordered.length > limit ? { next: "more" as unknown as Cursor } : {}) };
	};
	load.calls = 0;
	return load;
}

/** The view of a window: `entries` with the entry before them in `all`. */
function windowOf(all: readonly EntryRecord[], first: number, last: number): ConversationView {
	const before = all[first - 1]?.id;
	return {
		conversation: CONVERSATION,
		entries: all.slice(first, last + 1),
		...(before === undefined ? {} : { before }),
		docs: {},
	};
}

function shape(view: TranscriptView): (number | string)[] {
	return view.items.map((item) =>
		item.kind === "entry" ? item.entry.id : item.kind === "gap" ? `gap ${item.after}..${item.upTo}` : "earlier",
	);
}

const idsOf = (entries: readonly EntryRecord[]) => entries.map((entry) => entry.id);
const gapOf = (view: TranscriptView) =>
	view.items.find((item): item is Extract<TranscriptItem, { kind: "gap" }> => item.kind === "gap")!;

describe("ConversationTranscript", () => {
	it("shares one load between concurrent calls of loadEarlier, and of fillGap for one gap", async () => {
		const all = transcript(100);
		const inner = loader(all);
		const gate = deferred();
		const load: EntryLoader = async (query, limit, callContext) => {
			await gate.promise;
			return inner(query, limit, callContext);
		};
		const helper = new ConversationTranscript(load);
		helper.merge(windowOf(all, 40, 49));
		const stalled = helper.merge(windowOf(all, 90, 99));
		const earlier = [helper.loadEarlier(context), helper.loadEarlier(context)];
		const fills = [helper.fillGap(gapOf(stalled), context), helper.fillGap(gapOf(stalled), context)];
		gate.resolve();
		const [earlierA, earlierB, fillA, fillB] = await Promise.all([...earlier, ...fills]);
		expect(earlierA).toBe(earlierB);
		expect(fillA).toBe(fillB);
		expect(inner.calls).toBe(2);
		expect(shape(await helper.loadEarlier(context))).toEqual(idsOf(all));
	});
});

describe("ConversationTranscript loads", () => {
	it("shares one load between a stale gap descriptor and the gap it shrank into", async () => {
		const all = transcript(100);
		const inner = loader(all);
		const gate = deferred();
		const load: EntryLoader = async (query, limit, callContext) => {
			await gate.promise;
			return inner(query, limit, callContext);
		};
		const helper = new ConversationTranscript(load, { pageSize: 10 });
		helper.merge(windowOf(all, 10, 19));
		const stale = gapOf(helper.merge(windowOf(all, 90, 99)));
		gate.resolve();
		const current = gapOf(await helper.fillGap(stale, context));
		expect(current).not.toEqual(stale);
		const loads = inner.calls;
		const [a, b] = await Promise.all([helper.fillGap(stale, context), helper.fillGap(current, context)]);
		expect(a).toBe(b);
		expect(inner.calls).toBe(loads + 1);
	});
});
