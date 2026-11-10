// Amends upstream/test/harness-view.test.ts > "publishes one frame per touching commit, whose operations rebuild every
// revision" (spec section 9.3, amendments.json). Upstream counts one more frame than touching stored commits: the
// attempt's deferred commit. Deferred commits are gone (D5): the attempt is an ordinary commit, so every frame is one
// touching stored commit. The rest of the test is upstream's.
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationView,
	type ConversationWindow,
	type Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	ProviderDoc,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, waitFor } from "../upstream/test/chat-support.ts";
import { context, onValue } from "../upstream/test/session-support.ts";
import { aborted, deferred } from "../upstream/test/task-support.ts";

type Frame = { value: ConversationView; ops: readonly Op[] };

const MOUNTED = ["pi.agent", "pi.inbox", "pi.live", "pi.provider", "pi.usage"];

async function record(conversation: Conversation, window?: ConversationWindow) {
	const watch = await conversation.watch(context, window);
	const initial = watch.value;
	const frames: Frame[] = [];
	watch.start(
		onValue(async ({ value, ops }) => {
			frames.push({ value, ops });
		}),
	);
	return { initial, frames, stop: () => watch.stop() };
}

async function committed(
	harness: Harness,
	conversation: Conversation,
	record: ConversationView["conversation"],
	size: number,
) {
	const docs: Record<string, unknown> = {};
	for (const token of [AgentDoc, LiveDoc, InboxDoc, ProviderDoc, UsageDoc] as const) {
		const value = await harness.snapshot(token as typeof LiveDoc, conversation.id, context);
		if (value !== undefined) docs[token.definition.kind] = value;
	}
	const newest = [...(await conversation.entries({}, size + 1, undefined, context)).items];
	const before = newest.length > size ? newest.pop()!.id : undefined;
	return { conversation: record, entries: newest.reverse(), ...(before === undefined ? {} : { before }), docs };
}

function replay(initial: ConversationView, frames: readonly Frame[]): ConversationView {
	let value = initial;
	for (const frame of frames) {
		value = applyImmutable(value, frame.ops);
		expect(value).toEqual(frame.value);
	}
	return value;
}

function answer(text: string): AssistantMessage {
	return fauxAssistantMessage([fauxText(text)]);
}

async function drained(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function touches(harness: Harness, conversation: Conversation): { count: number } {
	const counter = { count: 0 };
	harness.observeCommits({
		advance: (publication) => {
			const touched = publication.changes.some(
				(change) =>
					(change.type === "entry" && change.value.conversationId === conversation.id) ||
					(change.type === "document" &&
						change.kind === "change" &&
						change.conversationId === conversation.id &&
						MOUNTED.includes(change.record.kind) &&
						change.ops.length > 0),
			);
			if (touched) counter.count++;
		},
		end: () => {},
	});
	return counter;
}

describe("conversation view", () => {
	it("publishes one frame per touching commit, whose operations rebuild every revision", async () => {
		const setup = chatSetup();
		const release = deferred();
		const step: FauxResponseStep = async (_request, options) => {
			await Promise.race([release.promise, aborted(options!.signal!)]);
			return answer("a longer answer");
		};
		setup.faux.setResponses([step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { initial, frames, stop } = await record(root);
		const touching = touches(harness, root);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() => frames.some((frame) => (frame.value.docs["pi.live"] as { generation?: unknown }).generation));
		release.resolve();
		await submission.wait(context);
		await harness.waitForIdle(context);
		await drained();
		// One frame per touching stored commit; the attempt is one of them (D5).
		expect(frames).toHaveLength(touching.count);
		const last = replay(initial, frames);
		expect(last).toEqual(await committed(harness, root, initial.conversation, last.entries.length));
		expect(frames[0]!.ops).toContainEqual(["p", ["entries"], 0, 0, [expect.objectContaining({ kind: "pi.user" })]]);
		// Document operations keep their exact shape under the mount path.
		expect(frames.flatMap((frame) => frame.ops)).toContainEqual([
			"s",
			["docs", "pi.live", "generation"],
			{ attempt: 1 },
		]);
		await stop();
		await harness.close(context);
	});
});
