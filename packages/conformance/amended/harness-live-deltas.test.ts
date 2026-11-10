// Amends upstream/test/harness-live-deltas.test.ts > "keeps a complete base exactly while nothing runs" (spec 8.2):
// nisse also takes a base during a long generation or tool round, so a one-hour tool stream does not retain every
// delta since the round began. The base whenever nothing runs is unchanged; while something runs, a short chain stays
// deltas and a long one gets a base.
import { LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

describe("pi.live deltas", () => {
	it("keeps a complete base exactly while nothing runs", () => {
		const base = (value: LiveState, deltasSinceBase: number) =>
			LiveDoc.definition.checkpointWhen!(value, [], { deltasSinceBase } as never);
		const slot = (status: "pending" | "running" | "done") => ({ callId: "c", name: "n", status });
		const run = { taskId: 1 as never, inputs: [], turns: 0 };
		for (const chain of [0, 10]) {
			expect(base({}, chain)).toBe(true);
			expect(base({ run, generation: { attempt: 1 } }, chain)).toBe(false);
			expect(base({ run, tools: [slot("pending"), slot("done")] }, chain)).toBe(true);
			expect(base({ run, tools: [slot("done"), slot("running")] }, chain)).toBe(false);
			expect(base({ run }, chain)).toBe(true);
		}
	});

	it("bounds the delta chain of a long generation or tool round with a base", () => {
		const base = (value: LiveState, deltasSinceBase: number) =>
			LiveDoc.definition.checkpointWhen!(value, [], { deltasSinceBase } as never);
		const run = { taskId: 1 as never, inputs: [], turns: 0 };
		const running = { run, tools: [{ callId: "c", name: "n", status: "running" as const }] };
		expect(base({ run, generation: { attempt: 1 } }, 10_000)).toBe(true);
		expect(base(running, 10_000)).toBe(true);
	});
});
