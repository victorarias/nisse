// Upstream's agent functions over @nisse/harness's: Promise transactions, and upstream snapshots and agents.
import * as H from "../../../../../harness/src/index.ts";
import { run } from "../session/session.ts";
import { harnessSnapshot, upstreamAgent } from "./convert.ts";

type Any = any;

export {
	AgentDoc,
	DEFAULT_COMPACTION_POLICY,
	DEFAULT_PROGRESS_POLICY,
	DEFAULT_RESTART_LIMIT,
	DEFAULT_RETRY_POLICY,
	INSTRUCTIONS_KEY,
	resolveSettings,
} from "../../../../../harness/src/index.ts";

export const addTools = (tx: Any, conversationId: Any, added: readonly string[]): Promise<void> =>
	run(H.addTools(tx.kernel, conversationId, added));

export const configure = (tx: Any, conversationId: Any, change: Any): Promise<void> =>
	run(H.configure(tx.kernel, conversationId, change));

export const createAgent = (tx: Any, record: Any): Promise<void> => run(H.createAgent(tx.kernel, record));

export const resolveAgent = (state: Any, snapshot: Any, settings: Any, report: (error: unknown, extension: string) => void) =>
	upstreamAgent(H.resolveAgent(state, harnessSnapshot(snapshot), settings, report));

// The selection functions read only names and registrations, so upstream's agents serve as they are.
export const agentHooks = (agent: Any, taskName: string) => H.agentHooks(agent, taskName);
export const sectionExtension = (agent: Any, key: string) => H.sectionExtension(agent, key);
export const toolExtension = (agent: Any, name: string) => H.toolExtension(agent, name);
