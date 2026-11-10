// Tool task helpers over @nisse/harness's: a Transaction of the suite works through its kernel Tx.
import * as H from "../../../../../harness/src/index.ts";
import { run } from "../session/session.ts";

type Any = any;

export const ToolTask = H.ToolTask;
export const NestedCallDoc = H.NestedCallDoc;
export const harnessError = H.harnessError;
export const appendToolResult = (tx: Any, conversationId: Any, call: Any, result: Any, options: Any): Promise<Any> =>
	run(H.appendToolResult(tx.kernel, conversationId, call, result, options));
