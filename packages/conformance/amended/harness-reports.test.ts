// Amends upstream/test/harness-reports.test.ts > "tell extension, listener, wake, and timer failures from a failed
// Session" (spec 10.1, amendments.json). The decision that removed alarms (D5) takes away `HarnessOptions.onWake` and
// the host's `setTimer`, so their `host_error` reports, and the sleeping task that made them, are gone. The other
// checks are upstream's: a wrapper that renames a tool is an `extension_error` naming the extension and conversation, a
// throwing commit observer is a `listener_error`, and a failed storage commit fails the Session with `storage_failed`.
// Upstream polls the reports; this waits on the reports themselves, with a deadline.
import { createModels } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type ReportInfo,
	wrapTool,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { ControlledStorage, context } from "../upstream/test/session-support.ts";
import { deferred } from "../upstream/test/task-support.ts";

type Report = { readonly message: string; readonly info: ReportInfo };

/** Settles with `promise`, or fails naming `what` once `ms` pass without it. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Each wait below takes well under 100 ms on an idle machine; the deadline only names a wait that never ends, before
// vitest's 5 s test timeout does.
const DEADLINE_MS = 4_000;

describe("reports", () => {
	it("tell extension, listener, wake, and timer failures from a failed Session", async () => {
		const storage = new ControlledStorage();
		const registry = createRegistry();
		const reports: Report[] = [];
		const listenerReported = deferred();
		const harness = await Harness.open(
			storage,
			{
				models: createModels(),
				registry,
				onReport: ({ error, ...info }) => {
					const message = (error as Error).message;
					reports.push({ message, info });
					if (message === "listener") listenerReported.resolve();
				},
			},
			context,
		);
		const echo = defineTool({
			name: "echo",
			description: "echo",
			parameters: obj({}),
			execute: async () => ({}),
		});
		registry.install(defineExtension({ name: "tools", tools: [echo] }));
		registry.install(
			defineExtension({ name: "wraps", wraps: [wrapTool(echo, (tool) => ({ ...tool, name: "renamed" }))] }),
		);
		harness.observeCommits({
			advance: () => {
				throw new Error("listener");
			},
			end: () => {},
		});
		const root = await harness.root(context);
		await root.agent(context);
		await within(listenerReported.promise, DEADLINE_MS, "the listener's report");
		const infoOf = (message: string) => reports.find((report) => report.message === message)?.info;
		expect(infoOf("Wrapper renamed echo to renamed")).toEqual({
			kind: "extension_error",
			conversationId: root.id,
			extension: "wraps",
		});
		expect(infoOf("listener")).toEqual({ kind: "listener_error" });

		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await root.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context).catch(() => {});
		await within(harness.closed, DEADLINE_MS, "the failed Session's close");
		expect(infoOf("disk gone")).toEqual({ kind: "storage_failed" });
	});
});
