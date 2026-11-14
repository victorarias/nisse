// Compaction over @sigma/harness's: a Transaction of the suite creates through its kernel Tx.
import * as H from "../../../../../harness/src/index.ts";
import { run } from "../session/session.ts";

type Any = any;

export const CompactionTask = H.CompactionTask;
export const compactionPolicy = H.compactionPolicy;
export const estimateContext = H.estimateContext;
export const selectCut = H.selectCut;
export const serializeConversation = H.serializeConversation;
export const summarizedMessages = H.summarizedMessages;
export const createCompaction = (tx: Any, conversationId: Any, input: Any, owner?: Any): Promise<Any> =>
	run(H.createCompaction(tx.kernel, conversationId, input, owner));
