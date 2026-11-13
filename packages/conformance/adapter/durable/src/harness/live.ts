// `pi.live` helpers over @sigma/harness's. Upstream reads the restart limit from a runtime's settings; the harness takes
// the limit. Partial output is committed state (D5), so a progress commit is an ordinary one.
import * as H from "../../../../../harness/src/index.ts";
import { run } from "../session/session.ts";

type Any = any;

export const LiveDoc = H.LiveDoc;
export const LIMITS_RESTARTS = H.LIMITS_RESTARTS;
/** Commit options of a progress commit: none, as every commit is stored before it is published (D5). */
export const PROGRESS_COMMIT = {};
export const addCompactionStatus = H.addCompactionStatus;
export const clearProgress = H.clearProgress;
export const compactionStatus = H.compactionStatus;
export const cutOffCount = H.cutOffCount;
export const cutOffTooOften = (task: Any, runtime: Any): boolean => H.cutOffTooOften(task, runtime.settings.restartLimit);
export const salvageable = (task: Any, runtime: Any): boolean => H.salvageable(task, runtime.settings.restartLimit);
export const endRun = (tx: Any, live: Any, taskId: Any, end: Any): Promise<void> => run(H.endRun(tx.kernel, live, taskId, end, undefined));
export const failCompactionStatus = H.failCompactionStatus;
export const finishSlot = H.finishSlot;
export const removeCompactionStatus = H.removeCompactionStatus;
export const removeNestedSlots = H.removeNestedSlots;
export const settleSchedulerOutcome = (tx: Any, record: Any, outcome: Any): Promise<void> =>
	run(H.settleSchedulerOutcome(tx.kernel, record, outcome));
export const toolSlot = H.toolSlot;
