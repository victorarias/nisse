// Generation helpers over @nisse/harness's: a Transaction of the suite works through its kernel Tx.
import * as H from "../../../../../harness/src/index.ts";
import { run } from "../session/session.ts";

type Any = any;

export const GenerationTask = H.GenerationTask;
export const handOver = H.handOver;
export const convertPartial = (tx: Any, live: Any, conversationId: Any): Promise<void> =>
	run(H.convertPartial(tx.kernel, live, conversationId));
export const startRun = (tx: Any, conversationId: Any, live: Any, runInput: Any, options?: Any): Promise<void> =>
	run(H.startRun(tx.kernel, conversationId, live, runInput, H.GENERATION_RUNS, options));
