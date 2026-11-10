// chord's watch types, for the suite's type-only imports. The adapter's watches are the kernel's document watches,
// wrapped in `durable/src/session/session.ts`; nothing here runs.
import type { Op } from "../../../../delta/src/delta/index.ts";
import type { CommitObserverEnd } from "../../../../kernel/src/index.ts";

/** One call to a watch listener: the newest value and the ops from the previous call's value. */
export type WatchCall<T> = {
	readonly kind: "value";
	readonly value: T;
	readonly ops: readonly Op[];
	readonly retired: boolean;
};

export type WatchEnd = CommitObserverEnd;
