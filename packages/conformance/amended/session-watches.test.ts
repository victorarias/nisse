// Amends fourteen tests of upstream/test/session-watches.test.ts > "Session document watches" (spec 9.1), listed
// in amendments.json: the same watches, commits and checks, except that each delivery is awaited. Upstream samples a
// listener's calls after one `setTimeout(0)`, which holds only while a delivery takes no macrotask; the Effect kernel
// runs a watch's deliveries on a fiber resumed with `setImmediate`, which on a loaded machine can take a second turn.
// Each listener is wrapped by `listenerCalls()`, and the test awaits the call it asserts. A `flush()` before a
// "nothing was delivered" assertion stays.
import type { WatchCall, WatchEnd } from "@earendil-works/chord/watch";
import { defineDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, documentValues, flush, onValue, openTestSession } from "../upstream/test/session-support.ts";

type State = { value: number; items: string[]; retained: { label: string } };

const StateDoc = defineDoc<State>({
	checkpointWhen: () => false,
	kind: "watch.state",
	version: 1,
	scope: "session",
	initial: () => ({ value: 0, items: ["a", "b"], retained: { label: "stable" } }),
});

type Keys = { keys: Record<string, number> };

const KeysDoc = defineDoc<Keys>({
	checkpointWhen: () => false,
	kind: "watch.keys",
	version: 1,
	scope: "session",
	initial: () => ({ keys: {} }),
});

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Counts the calls of the listeners it wraps; `reached(n)` resolves once n calls have returned or thrown. */
function listenerCalls(): {
	count<A extends unknown[]>(listener: (...args: A) => Promise<void>): (...args: A) => Promise<void>;
	reached(n: number): Promise<void>;
} {
	let calls = 0;
	const waiting = new Set<{ readonly n: number; readonly resolve: () => void }>();
	return {
		count(listener) {
			return async (...args) => {
				try {
					await listener(...args);
				} finally {
					calls++;
					for (const waiter of waiting) {
						if (waiter.n > calls) continue;
						waiting.delete(waiter);
						waiter.resolve();
					}
				}
			};
		},
		reached(n) {
			return calls >= n ? Promise.resolve() : new Promise((resolve) => waiting.add({ n, resolve }));
		},
	};
}

/** The end of `closed`, or undefined while the watch is open. */
function endOf(watch: { readonly closed: Promise<WatchEnd> }): { readonly end: WatchEnd | undefined } {
	const settled: { end: WatchEnd | undefined } = { end: undefined };
	void watch.closed.then((end) => {
		settled.end = end;
	});
	return settled;
}

async function createState(): Promise<ReturnType<typeof openTestSession>> {
	const harness = openTestSession();
	await harness.session.commit((tx) => tx.doc(StateDoc).then(() => undefined), context);
	return harness;
}

describe("Session document watches", () => {
	it("keeps the acquisition revision until start, then delivers the commits since in one call", async () => {
		const { session, publications } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const initial = watch.value;
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await flush();
		const firstPublished = documentValues(publications.at(-1)!)[0]!;
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 2;
		}, context);
		await flush();
		const secondPublished = documentValues(publications.at(-1)!)[0]!;
		expect(watch.value).toBe(initial);

		let inline = true;
		const deliveries: Array<{ value: Readonly<State>; ops: unknown }> = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value, ops }) => {
					expect(inline).toBe(false);
					expect(watch.value).toBe(value);
					deliveries.push({ value, ops });
				}),
			),
		);
		inline = false;
		expect(deliveries).toHaveLength(0);
		await calls.reached(1);
		// Both commits set `value`: folded, the second set replaces the first.
		expect(firstPublished.ops).toEqual([["s", ["value"], 1]]);
		expect(deliveries).toEqual([{ value: secondPublished.value, ops: secondPublished.ops }]);
		expect(deliveries[0]!.value).toBe(secondPublished.value);
		expect(initial?.value).toBe(0);

		// A listener that keeps up gets each commit's ops as published.
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 3;
		}, context);
		await calls.reached(2);
		const thirdPublished = documentValues(publications.at(-1)!)[0]!;
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]!.value).toBe(thirdPublished.value);
		expect(deliveries[1]!.ops).toBe(thirdPublished.ops);
		await watch.stop();
	});

	it("serializes callbacks and folds the commits made while one is in flight into the next", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const entered = deferred();
		const release = deferred();
		const values: number[] = [];
		const batches: unknown[] = [];
		let active = 0;
		let maxActive = 0;
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value, ops }) => {
					active++;
					maxActive = Math.max(maxActive, active);
					values.push(value.value);
					batches.push(ops);
					if (values.length === 1) {
						entered.resolve();
						await release.promise;
					}
					active--;
				}),
			),
		);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await entered.promise;
		for (let value = 2; value <= 20; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		expect(values).toEqual([1]);
		release.resolve();
		await calls.reached(2);
		expect(maxActive).toBe(1);
		expect(values).toEqual([1, 20]);
		expect(batches[1]).toEqual([["s", ["value"], 20]]);
		await watch.stop();
	});

	it("folds 101 pending commits of one field into one set", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		for (let value = 1; value <= 101; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		const deliveries: Array<{ value: number; ops: unknown }> = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value, ops }) => {
					deliveries.push({ value: value.value, ops });
				}),
			),
		);
		await calls.reached(1);
		expect(deliveries).toEqual([{ value: 101, ops: [["s", ["value"], 101]] }]);
		await watch.stop();
	});

	it("replaces the root once more than 10,000 ops are pending after folding", async () => {
		const { session } = openTestSession();
		await session.commit((tx) => tx.doc(KeysDoc).then(() => undefined), context);
		const watch = (await session.watchDoc(KeysDoc, context))!;
		// Sets of distinct keys, in commits small enough to stay ops: 4,000 + 4,000 + 2,001 pending ops.
		for (const [from, to] of [
			[0, 4_000],
			[4_000, 8_000],
			[8_000, 10_001],
		] as const) {
			await session.commit(async (tx) => {
				const state = await tx.doc(KeysDoc);
				for (let index = from; index < to; index++) state.keys[`k${index}`] = index;
			}, context);
		}
		const deliveries: Array<{ value: Readonly<Keys>; ops: unknown }> = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value, ops }) => {
					deliveries.push({ value, ops });
				}),
			),
		);
		await calls.reached(1);
		expect(deliveries).toEqual([{ value: watch.value, ops: [["r", watch.value]] }]);
		expect(Object.keys(watch.value.keys)).toHaveLength(10_001);
		await watch.stop();
	});

	it("never folds the in-flight frame into the next call", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const entered = deferred();
		const release = deferred();
		const deliveries: Array<{ value: number; ops: unknown }> = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value, ops }) => {
					deliveries.push({ value: value.value, ops });
					if (deliveries.length === 1) {
						entered.resolve();
						await release.promise;
					}
				}),
			),
		);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await entered.promise;
		for (let value = 2; value <= 102; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		release.resolve();
		await calls.reached(2);
		expect(deliveries[0]!.value).toBe(1);
		expect(deliveries[1]).toEqual({ value: 102, ops: [["s", ["value"], 102]] });
		expect(deliveries).toHaveLength(2);
		await watch.stop();
	});

	it("folds a retirement into the pending commits' call, which reports it with the last value, and goes on", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		for (let value = 1; value <= 100; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		const last = (await session.snapshot(StateDoc, context))!;
		await session.commit((tx) => tx.retireDoc(StateDoc), context);
		const changes: WatchCall<Readonly<State>>[] = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(async (change: WatchCall<Readonly<State>>) => {
				changes.push(change);
			}),
		);
		await calls.reached(1);
		expect(changes).toEqual([{ kind: "value", value: last, ops: [["s", ["value"], 100]], retired: true }]);
		expect((changes[0] as { value: unknown }).value).toBe(last);
		expect(watch.value).toBe(last);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 7;
		}, context);
		await calls.reached(2);
		expect(changes[1]).toEqual({
			kind: "value",
			value: { ...last, value: 7 },
			ops: [["r", { ...last, value: 7 }]],
			retired: false,
		});
		await watch.stop();
	});

	it("delivers replayable structural no-op commits instead of suppressing them", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const initial = watch.value;
		await session.commit(async (tx) => {
			const state = await tx.doc(StateDoc);
			const first = state.items.shift()!;
			state.items.unshift(first);
		}, context);
		const newest = (await session.snapshot(StateDoc, context))!;
		expect(newest).not.toBe(initial);
		expect(newest).toEqual(initial);
		const batches: unknown[] = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value, ops }) => {
					expect(value).toBe(newest);
					batches.push(ops);
				}),
			),
		);
		await calls.reached(1);
		expect(batches).toHaveLength(1);
		expect((batches[0] as readonly unknown[]).length).toBeGreaterThan(0);
		await watch.stop();
	});

	it("keeps earlier immutable revisions stable", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const initial = watch.value;
		let delivered: Readonly<State> | undefined;
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value }) => {
					delivered = value;
				}),
			),
		);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await calls.reached(1);
		expect(delivered).toBe(watch.value);
		expect(delivered).not.toBe(initial);
		expect(delivered?.retained).toBe(initial.retained);
		expect(initial.value).toBe(0);
		await watch.stop();
	});

	it("reports a change and a retirement in one commit as the retirement, with the value it was given before", async () => {
		const { session, storage } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const before = watch.value;
		const changes: WatchCall<Readonly<State>>[] = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(async (change: WatchCall<Readonly<State>>) => {
				changes.push(change);
			}),
		);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 5;
			await tx.retireDoc(StateDoc);
		}, context);
		await calls.reached(1);
		// Storage got the change, then the retirement; the commit publishes the retirement only.
		expect(storage.commits.at(-1)!.map((write) => write.type)).toEqual(["document.change", "document.retire"]);
		expect(changes).toEqual([{ kind: "value", value: before, ops: [], retired: true }]);
		expect((changes[0] as { value: unknown }).value).toBe(before);
		await watch.stop();
	});

	it("follows its address across a retirement and a recreation in one commit, in one call", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const settled = endOf(watch);
		const changes: WatchCall<Readonly<State>>[] = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(async (change: WatchCall<Readonly<State>>) => {
				changes.push(change);
			}),
		);
		await session.commit(async (tx) => {
			await tx.retireDoc(StateDoc);
			(await tx.doc(StateDoc)).value = 10;
		}, context);
		await calls.reached(1);
		const recreated = (await session.snapshot(StateDoc, context))!;
		expect(changes).toHaveLength(1);
		expect(changes[0]).toEqual({ kind: "value", value: recreated, ops: [["r", recreated]], retired: true });
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 11;
		}, context);
		await calls.reached(2);
		expect(changes[1]).toEqual({ kind: "value", value: watch.value, ops: [["s", ["value"], 11]], retired: false });
		expect(watch.value.value).toBe(11);
		expect(settled.end).toBeUndefined();
		await watch.stop();
	});

	it("settles listener failure on only the affected watch", async () => {
		const { session } = await createState();
		const failed = (await session.watchDoc(StateDoc, context))!;
		const healthy = (await session.watchDoc(StateDoc, context))!;
		failed.start(async () => {
			throw new Error("listener failed");
		});
		let healthyCalls = 0;
		const calls = listenerCalls();
		healthy.start(
			calls.count(async () => {
				healthyCalls++;
			}),
		);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		const end = await failed.closed;
		expect(end.kind).toBe("listener_error");
		if (end.kind === "listener_error") expect(end.error.message).toBe("listener failed");
		await calls.reached(1);
		expect(healthyCalls).toBe(1);
		await healthy.stop();
	});

	it("hydrates migration without writing and observes the later exact edit", async () => {
		const Old = defineDoc<{ value: number }>({
			checkpointWhen: () => false,
			kind: "watch.migration",
			version: 1,
			scope: "session",
			initial: () => ({ value: 3 }),
		});
		const Current = defineDoc<{ value: number; migrated: boolean }>({
			checkpointWhen: () => false,
			kind: "watch.migration",
			version: 2,
			scope: "session",
			initial: () => ({ value: 0, migrated: false }),
			migrate: (value) => ({ value: value.value as number, migrated: true }),
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		const commits = storage.commits.length;
		const watch = (await session.watchDoc(Current, context))!;
		expect(watch.value).toEqual({ value: 3, migrated: true });
		expect(storage.commits).toHaveLength(commits);
		const values: number[] = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(
				onValue(async ({ value }) => {
					values.push(value.value);
				}),
			),
		);
		await session.commit((tx) => tx.doc(Current).then(() => undefined), context);
		await flush();
		expect(values).toEqual([]);
		await session.commit(async (tx) => {
			(await tx.doc(Current)).value = 4;
		}, context);
		await calls.reached(1);
		expect(values).toEqual([4]);
		await watch.stop();
	});

	it("continues after the tracker cache unloads", async () => {
		const { session, storage } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const baseline = watch.value;
		const reads = storage.documentReadCount;
		await session.unloadDocuments();
		const reloaded = await session.snapshot(StateDoc, context);
		expect(reloaded).toEqual(baseline);
		expect(reloaded).not.toBe(baseline);
		expect(storage.documentReadCount).toBeGreaterThan(reads);
		const calls = listenerCalls();
		watch.start(calls.count(async () => undefined));
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 7;
		}, context);
		await calls.reached(1);
		expect(watch.value.value).toBe(7);
		await watch.stop();
	});

	it("takes the version of a recreation written by a newer definition, then its ops", async () => {
		const Old = defineDoc<{ value: number }>({
			checkpointWhen: () => false,
			kind: "watch.recreated-version",
			version: 1,
			scope: "session",
			initial: () => ({ value: 1 }),
		});
		const Current = defineDoc<{ value: number; migrated: boolean }>({
			checkpointWhen: () => false,
			kind: "watch.recreated-version",
			version: 2,
			scope: "session",
			initial: () => ({ value: 0, migrated: false }),
			migrate: (value) => ({ value: value.value as number, migrated: true }),
		});
		const { session } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		const watch = (await session.watchDoc(Old, context))!;
		const changes: WatchCall<unknown>[] = [];
		const calls = listenerCalls();
		watch.start(
			calls.count(async (change: WatchCall<unknown>) => {
				changes.push(change);
			}),
		);
		await session.commit(async (tx) => {
			await tx.retireDoc(Current);
			(await tx.doc(Current)).value = 5;
		}, context);
		await calls.reached(1);
		await session.commit(async (tx) => {
			(await tx.doc(Current)).value = 6;
		}, context);
		await calls.reached(2);
		expect(changes).toEqual([
			{
				kind: "value",
				value: { value: 5, migrated: false },
				ops: [["r", { value: 5, migrated: false }]],
				retired: true,
			},
			{ kind: "value", value: { value: 6, migrated: false }, ops: [["s", ["value"], 6]], retired: false },
		]);
		await watch.stop();
	});
});
