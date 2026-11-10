// Amends upstream/test/harness-nested-tools.test.ts > "rejects a nested call of an aborted caller and leaves no document
// for it" (spec 7.3, amendments.json): the same tool round and checks, except that the caller is abort-marked through
// the public `harness.abortTask()` instead of a raw `Transaction.setTask()` through a cast. The tool ignores its abort
// signal until the mark is committed (`abortTask()` joins its invocation, so the test waits for the mark, not the
// call), and the nested call reaches admission from a caller that is still running but marked: the state upstream
// builds by hand. It also checks that the nested tool never ran and no task was created for it.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	defineTool,
	MemoryStorage,
	NestedCallDoc,
	type TaskId,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, waitFor } from "../upstream/test/chat-support.ts";
import { addTool } from "../upstream/test/harness-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { deferred } from "../upstream/test/task-support.ts";

const Parameters = obj({ text: opt(str()) });
type Tool = ToolRegistration<typeof Parameters>;

function tool(name: string, execute: Tool["execute"]): Tool {
	return defineTool({ name, description: name, parameters: Parameters, execute });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

describe("nested tool calls", () => {
	it("rejects a nested call of an aborted caller and leaves no document for it", async () => {
		const setup = chatSetup();
		let echoRuns = 0;
		addTool(
			setup.registry,
			tool("echo", async (args) => {
				echoRuns++;
				return { output: [{ type: "text", text: `echo ${args.text ?? ""}` }] };
			}),
		);
		const started = deferred();
		const marked = deferred();
		let rejected: unknown;
		let returned = false;
		let caller: TaskId | undefined;
		addTool(
			setup.registry,
			tool("late", async (_args, api) => {
				caller = api.taskId;
				started.resolve();
				await marked.promise;
				// Its context is aborted too, so pass one that is not: the admission itself must refuse.
				try {
					await api.executeTool("echo", { text: "a" }, context);
					returned = true;
				} catch (error) {
					rejected = error;
				}
				return {};
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage([fauxToolCall("late", {}, { id: "c1" })], { stopReason: "toolUse" }), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		// abortTask() joins the caller's invocation, which waits for `marked`: resolve it once the mark is committed.
		const abort = harness.abortTask(caller!, context);
		await waitFor(async () => (await harness.getTask(caller!, context))?.abortRequested === true);
		marked.resolve();
		expect(await abort).toBe("marked");
		await submission.wait(context);
		expect(returned).toBe(false);
		expect(String(rejected)).toMatch(/abort mark|aborted|has settled/);
		expect(echoRuns).toBe(0);
		expect(await harness.snapshot(NestedCallDoc, caller!, "1", context)).toBeUndefined();
		// No tool task was created for the nested call: the caller is the only one.
		const tools = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
		expect(tools.map((task) => task.id)).toEqual([caller]);
		await harness.close(context);
	});
});
