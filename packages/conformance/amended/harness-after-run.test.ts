// Amends upstream/test/harness-after-run.test.ts > endRun (spec 8.2, amendments.json). Upstream calls the private
// `endRun()` of src/harness/live.ts on a hand-built `pi.live` draft with a fake Tx; these drive real runs on the faux
// model and read `pi.live` through `LiveDoc` snapshots instead.
//
// - "copies a failed run's first entry into runFailure": a run whose response fails ends `model_error`, and its
//   `runFailure.first` is the `run.first` the live document showed while the run worked (the run's user entry).
// - "leaves a run it does not own alone, and ends an answered run without a failure": a run that answered and waits
//   for its after-run task keeps `run` and `run.afterRun` while another task of the conversation is aborted and ends;
//   then Stop ends the run, aborted, with no `run` and no `runFailure`, its input still `done`. What upstream reaches
//   directly and this cannot: `endRun()` called by a run task that does not own the run. Every caller passes its own
//   task id and the fault path checks ownership before calling, so no public sequence makes a non-owner run task end
//   the run; the unrelated task's ending is the closest public observation.
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTask,
	type EntryRecord,
	GenerationTask,
	type Harness,
	hook,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	runEndTask,
	type Conversation,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat, waitFor } from "../upstream/test/chat-support.ts";
import { context } from "../upstream/test/session-support.ts";
import { aborted, deferred } from "../upstream/test/task-support.ts";

async function live(harness: Harness, conversation: Conversation): Promise<Readonly<LiveState>> {
	return (await harness.snapshot(LiveDoc, conversation.id, context)) ?? {};
}

function kindOf(entries: readonly EntryRecord[], kind: string): EntryRecord[] {
	return entries.filter((entry) => entry.kind === kind);
}

/** Labels of the `Hold` tasks that started running. */
const started: string[] = [];

/** A task that runs until aborted; its abort handler ends it aborted. */
const Hold = defineTask<{ label: string }, { phase: "run" }, string>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime) => {
			started.push(task.input.label);
			await aborted(runtime.signal);
		},
	},
	abort: async (_task, runtime, ctx) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, ctx);
	},
});

describe("endRun", () => {
	it("leaves a run it does not own alone, and ends an answered run without a failure", async () => {
		started.length = 0;
		const setup = chatSetup();
		setup.registry.install(
			defineExtension({
				name: "after-run",
				tasks: [Hold],
				hooks: [hook(GenerationTask, { afterRun: async () => ({ tasks: [runEndTask(Hold, { label: "after-run" })] }) })],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		await waitFor(() => started.includes("after-run"));
		const held = await live(harness, root);
		expect(held.run?.afterRun?.tasks).toHaveLength(1);
		const runTask = held.run!.taskId;
		const afterRunTask = held.run!.afterRun!.tasks![0]!;

		// A task of the same conversation that does not own the run ends: the run and its after-run state stay.
		const other = await root.commit(
			(tx) => tx.createTask(Hold, { label: "other" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await waitFor(() => started.includes("other"));
		await harness.abortTask(other, context);
		expect((await harness.waitForTask(other, context)).state.outcome.status).toBe("aborted");
		const kept = await live(harness, root);
		expect(kept.run?.taskId).toBe(runTask);
		expect(kept.run?.afterRun?.tasks).toEqual([afterRunTask]);
		expect(kept.runFailure).toBeUndefined();

		// Stop while the after-run task runs: the answered run ends aborted, without a failure.
		await root.abort(context);
		const ended = await live(harness, root);
		expect(ended.run).toBeUndefined();
		expect(ended.runFailure).toBeUndefined();
		expect((await submission.status(context)).status).toBe("done");
		expect((await harness.getTask(afterRunTask, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		await harness.close(context);
	});

	it("copies a failed run's first entry into runFailure", async () => {
		const setup = chatSetup();
		const gate = deferred();
		const reached = deferred();
		const failing: FauxResponseStep = async () => {
			reached.resolve();
			await gate.promise;
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" });
		};
		setup.faux.setResponses([failing]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await reached.promise;
		const working = (await live(harness, root)).run!;
		const userEntry = kindOf(await allEntries(root), "pi.user")[0]!;
		expect(working.first).toBe(userEntry.id);
		gate.resolve();
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		const ended = await live(harness, root);
		expect(ended.run).toBeUndefined();
		expect(ended.runFailure).toEqual({
			taskId: working.taskId,
			inputs: [submission.id],
			reason: "model_error",
			detail: "Invalid request",
			first: working.first,
		});
		await harness.close(context);
	});
});
