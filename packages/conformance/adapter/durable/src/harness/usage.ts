// The usage ledger over @sigma/harness's: a Transaction of the suite records through its kernel Tx.
import * as H from "../../../../../harness/src/index.ts";
import { run } from "../session/session.ts";

type Any = any;

export const UsageDoc = H.UsageDoc;
export const addUsage = H.addUsage;
export const addUsageState = H.addUsageState;
export const recordUsage = (tx: Any, conversationId: Any, bucket: Any, key: string, usage: Any): Promise<void> =>
	run(H.recordUsage(tx.kernel, conversationId, bucket, key, usage));
