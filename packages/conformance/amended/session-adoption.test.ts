// Amends three tests of upstream/test/session-adoption.test.ts > "Session adoption after Storage stored a commit"
// (spec 4 and 10.1, amendments.json). Upstream spies on the private `Transaction.prototype.adopt` and `discard`, which
// sigma's kernel does not have; these keep the same Storage faults and every public assertion, and drop the spies.
//
// - "takes the durability receipt inside the commit, and adopts once Storage resolved" (spec 4): Storage runs the
//   receipt inside its call and resolves after it, and the adopted value is what a snapshot reads.
// - "fails the Session without discarding when Storage rejects after adoption" (spec 10.1): the commit rejects with
//   Storage's error and the Session fails with it.
// - "discards the staged changes when Storage rejects before adoption" (spec 10.1): the same, for a call that rejects
//   before any receipt. Once the Session failed no read can see whether memory kept the staged change; what a caller
//   observes is the rejection, the failed Session, and that no observer was shown the change.
import type { Context } from "@earendil-works/chord/context";
import { type CommitResult, defineDoc, MemoryStorage, type Seq, type StorageWrite } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionImpl } from "../upstream/src/session/session.ts";
import { ControlledStorage, context, followCommits } from "../upstream/test/session-support.ts";

const CounterDoc = defineDoc<{ count: number }>({
	checkpointWhen: () => false,
	kind: "adoption.counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
});

/** Controlled storage that records its receipts and its own resolution in `order`; its next commit may reject after them. */
class FaultyStorage extends ControlledStorage {
	fault: "reject_after_adopt" | undefined;
	readonly order: string[] = [];

	override async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		callContext: Context,
	): Promise<CommitResult> {
		const fault = this.fault;
		this.fault = undefined;
		const result = await super.commit(
			batches,
			(index, committed) => {
				this.order.push("adopt");
				receive(index, committed);
				this.order.push("adopted");
			},
			callContext,
		);
		this.order.push("resolve");
		if (fault === "reject_after_adopt") throw new Error("reclaim failed");
		return result;
	}
}

function open() {
	const storage = new FaultyStorage();
	const session = new SessionImpl(storage);
	return { storage, session };
}

const bump = (session: SessionImpl) =>
	session.commit(async (tx) => {
		(await tx.doc(CounterDoc)).count++;
	}, context);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Session adoption after Storage stored a commit", () => {
	it("takes the durability receipt inside the commit, and adopts once Storage resolved", async () => {
		const { storage, session } = open();
		await bump(session);
		expect(storage.order).toEqual(["adopt", "adopted", "resolve"]);
		expect(await session.snapshot(CounterDoc, context)).toEqual({ count: 1 });
		await session.close(context);
	});

	it("fails the Session without discarding when Storage rejects after adoption", async () => {
		const { storage, session } = open();
		await bump(session);
		storage.fault = "reject_after_adopt";
		await expect(bump(session)).rejects.toThrow("reclaim failed");
		expect(await session.closed).toMatchObject({ kind: "failed", error: new Error("reclaim failed") });
	});

	it("discards the staged changes when Storage rejects before adoption", async () => {
		const storage = new MemoryStorage();
		const session = new SessionImpl(storage);
		await bump(session);
		let shown = 0;
		followCommits(session, () => shown++);
		vi.spyOn(storage, "commit").mockRejectedValueOnce(new Error("disk full"));
		await expect(bump(session)).rejects.toThrow("disk full");
		expect(await session.closed).toMatchObject({ kind: "failed" });
		expect(shown).toBe(0);
	});
});
