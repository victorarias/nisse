// Amends upstream/test/harness-view-run.test.ts > "commits a growing text and tool call at a cost that follows the new
// text, not the string lengths" (spec 8.2, amendments.json). Upstream measures the cost as bytes allocated, through
// node:v8's GCProfiler. Under JavaScriptCore that sum does not track allocation: repeated runs gave ratios from 2 to
// over 1,000, and the reference copy fails it on every run. This measures what each commit writes instead: the size of
// its `pi.live` operations. Streaming ten times the text in ten times the commits must keep that size per commit flat;
// a commit that wrote the whole partial again would grow it with the text's length.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat } from "../upstream/test/chat-support.ts";
import { context, documentChanges, followCommits } from "../upstream/test/session-support.ts";

describe("streamed partials", () => {
	it("commits a growing text and tool call at a cost that follows the new text, not the string lengths", async () => {
		/** The commits and the bytes of their `pi.live` operations while streaming `size` characters of text and call. */
		const stream = async (size: number) => {
			const setup = chatSetup({ tokensPerSecond: 64_000, tokenSize: { min: 64, max: 64 } });
			setup.settings.progress = { partialIntervalMs: 1, outputIntervalMs: 100 };
			const text = 'streamed text with "quotes" and \\ escapes\n'.repeat(size / 40);
			setup.faux.setResponses([
				fauxAssistantMessage(
					[fauxText(text), fauxToolCall("missing", { path: "a.ts", content: text }, { id: "c1" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			let commits = 0;
			let bytes = 0;
			followCommits(harness, (publication) => {
				const live = documentChanges(publication).filter(
					(change) => change.kind === "change" && change.record.kind === "pi.live",
				);
				if (live.length === 0) return;
				commits++;
				for (const change of live) if (change.kind === "change") bytes += JSON.stringify(change.ops).length;
			});
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			await harness.close(context);
			return { bytes, commits };
		};
		const small = await stream(40_000);
		const large = await stream(400_000);
		expect(large.commits).toBeGreaterThan(small.commits * 5);
		expect(large.bytes / large.commits / (small.bytes / small.commits)).toBeLessThan(2);
	}, 60_000);
});
