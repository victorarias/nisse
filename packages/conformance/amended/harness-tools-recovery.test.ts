// Amends upstream/test/harness-tools-recovery.test.ts > "reruns a safe tool whose running slot a crash after its intent
// lost, or a sibling stored, and shows it running" (D5, `persistWithinMs`): sigma has no deferred commits, so the
// running slot is committed before the tool runs and a crash never loses it. After the crash the slot shows `running`
// with or without a sibling's commit, and the rerun still shows it running and answers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
	defineTool,
	type Harness,
	LiveDoc,
	type ToolRegistration,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../upstream/src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, waitFor } from "../upstream/test/chat-support.ts";
import { addTool } from "../upstream/test/harness-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { aborted, deferred } from "../upstream/test/task-support.ts";

const directories = new Set<string>();
afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "sigma-tools-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

function tool(name: string, execute: ToolRegistration["execute"], extra: Partial<ToolRegistration> = {}) {
	return defineTool({ name, description: name, parameters: obj({}), execute, ...extra });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

describe("tool recovery", () => {
	it("reruns a safe tool whose running slot a crash after its intent lost, or a sibling stored, and shows it running", async () => {
		for (const sibling of [false, true]) {
			const path = await sqlitePath();
			const setup = chatSetup();
			const started = deferred();
			let runs = 0;
			let reopened: Harness | undefined;
			const seen: (string | undefined)[] = [];
			addTool(
				setup.registry,
				tool(
					"work",
					async (_args, api, callContext) => {
						runs++;
						if (runs === 1) {
							started.resolve();
							await aborted(callContext.abortSignal!);
						}
						const slots = (await reopened!.snapshot(LiveDoc, 1 as never, callContext))?.tools ?? [];
						seen.push(slots.find((slot) => slot.taskId === api.taskId)?.status);
						return {};
					},
					{ replay: "safe" },
				),
			);
			addTool(
				setup.registry,
				tool("quick", async () => {
					await started.promise;
					return {};
				}),
			);
			const calls = [fauxToolCall("work", {}, { id: "w" })];
			if (sibling) calls.push(fauxToolCall("quick", {}, { id: "q" }));
			setup.faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), DONE]);
			const crashed = await openChat(await openNodeSqliteStorage(path), setup);
			crashed.harness.resume();
			const id = (await crashed.root.submit({ type: "input", content: "go" }, context)).id;
			await started.promise;
			const slot = async (harness: Harness, name: string) =>
				(await harness.snapshot(LiveDoc, crashed.root.id, context))?.tools?.find((each) => each.name === name);
			const live = (harness: Harness) => slot(harness, "work");
			const workId = (await live(crashed.harness))!.taskId!;
			if (sibling) await waitFor(async () => (await slot(crashed.harness, "quick"))?.status === "done");
			// The process dies here: another one opens the same database.
			const next = await openChat(await openNodeSqliteStorage(path), setup);
			reopened = next.harness;
			expect((await next.harness.getTask(workId, context))?.state).toMatchObject({
				checkpoint: { phase: "execute" },
			});
			// Committed before the tool ran, so the crash kept it.
			expect((await live(next.harness))?.status).toBe("running");
			next.harness.resume();
			expect((await (await next.harness.submission(id, context))!.wait(context)).status).toBe("done");
			expect(seen).toEqual(["running"]);
			const [result] = (await allEntries(next.root))
				.filter((entry) => ToolResultEntry.is(entry))
				.map((entry) => entry.model![0] as ToolResultMessage)
				.filter((message) => message.toolCallId === "w");
			expect(result!.isError).toBe(false);
			await next.harness.close(context);
			await crashed.harness.close(context);
		}
	});
});
