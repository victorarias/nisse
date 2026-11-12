// Amends upstream/test/session-group-commit.test.ts > "group commit: a failure between two publications" > "checks the
// failure when a storage's scope runs a publication it deferred, not when it was asked to" (spec 10.1, amendments.json).
// Upstream fails the Session from inside the storage's `publishing()` scope, which D5 removes with the store backend.
// What it defends does not need the scope: the Session checks its failure when it would publish a commit, not when it
// sent the commit to Storage. Here the Session fails while the commit's storage call is held in flight. The call then
// stores the commit, so it is durable, but it is never published and rejects with `SessionFailed` whose cause is that
// failure; a reopened Session reads it.
import { SessionFailed } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { ObservedCommit } from "../upstream/src/session/session.ts";
import { SessionImpl } from "../upstream/src/session/session.ts";
import { ControlledStorage, context } from "../upstream/test/session-support.ts";

describe("group commit: a failure between two publications", () => {
	it("checks the failure when a storage's scope runs a publication it deferred, not when it was asked to", async () => {
		const storage = new ControlledStorage();
		const session = new SessionImpl(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const published: ObservedCommit[] = [];
		session.followCommits((publication) => {
			published.push(publication);
		});
		const failure = new Error("failed while the call was in flight");
		const held = storage.holdCommits();
		const one = session.commit((tx) => tx.appendEntry(conversation.id, { kind: "one" }), context);
		await held.entered;
		session.fail(failure);
		held.release();
		const outcome = await one.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).toBeInstanceOf(SessionFailed);
		expect((outcome as SessionFailed).cause).toBe(failure);
		expect(published).toEqual([]);
		expect(await session.closed).toEqual({ kind: "failed", error: failure });
		// Storage stored it: a reopened Session reads it.
		const reopened = new SessionImpl(storage.reopen());
		const entries = await reopened.commit(
			async (tx) => (await tx.scanEntries({ conversationId: conversation.id }, 10)).items,
			context,
		);
		expect(entries.map((entry) => entry.kind)).toEqual(["one"]);
		await reopened.close(context);
	});
});
