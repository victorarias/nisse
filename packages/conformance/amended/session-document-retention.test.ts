// Amends upstream/test/session-document-retention.test.ts > "gives the same views with documents evicted right after use
// as with documents kept" (spec section 4, amendments.json): the same runs, tool, model script and comparison, except
// that the tool writes its next step once a view shows the last one, where upstream waits 5 ms. Tool progress writes
// what was reported while a commit is in flight with the next commit, so a commit slower than 5 ms, which a loaded
// machine sometimes has in one of the two runs, folds two steps into one view and the runs differ by a view.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationView, defineTool, type LiveState, MemoryStorage } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat } from "../upstream/test/chat-support.ts";
import { addTool } from "../upstream/test/harness-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { type Deferred, deferred } from "../upstream/test/task-support.ts";

describe("document cache retention", () => {
	it("gives the same views with documents evicted right after use as with documents kept", async () => {
		const run = async (documentRetentionMs: number): Promise<string[]> => {
			/** One per output the tool's slot shows, resolved by the view that first shows it. */
			const shown = new Map<string, Deferred<void>>();
			const shownAs = (output: string): Deferred<void> => {
				if (!shown.has(output)) shown.set(output, deferred<void>());
				return shown.get(output)!;
			};
			const setup = chatSetup();
			setup.settings.documentRetentionMs = documentRetentionMs;
			setup.settings.progress = { outputIntervalMs: 0 };
			addTool(
				setup.registry,
				defineTool({
					name: "steps",
					description: "Streams three steps",
					parameters: obj({}),
					execute: async (_args, api) => {
						let output = "";
						for (const step of ["a\n", "b\n", "c\n"]) {
							api.output(step);
							output += step;
							await shownAs(output).promise;
						}
						return {};
					},
				}),
			);
			setup.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("steps", {}, { id: "s1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("done")]),
			]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			const views: ConversationView[] = [];
			const record = (view: ConversationView): void => {
				views.push(view);
				const live = (view.docs["pi.live"] ?? {}) as LiveState;
				const output = live.tools?.find((slot) => slot.callId === "s1")?.output;
				if (output !== undefined) shownAs(output).resolve();
			};
			const observation = await harness.observeConversation(
				root.id,
				{ advance: (call) => call.kind === "value" && record(call.value), end: () => {} },
				context,
			);
			record(observation.value);
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			await harness.waitForIdle(context);
			observation.detach();
			await harness.close(context);
			// Ids and times differ between runs; the sequence of entries, run states, and tool outputs must not.
			return views.map((view) => {
				const live = (view.docs["pi.live"] ?? {}) as LiveState;
				const tools = (live.tools ?? []).map((slot) => `${slot.callId}:${slot.status}:${slot.output ?? ""}`);
				const kinds = view.entries.map((entry) => entry.kind).join(",");
				return `${kinds} run:${live.run !== undefined} generation:${live.generation !== undefined} ${tools.join(" ")}`;
			});
		};
		expect(await run(0)).toEqual(await run(600_000));
	});
});
