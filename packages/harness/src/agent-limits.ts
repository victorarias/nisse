// Agent limits (D13): how deep subagents nest and how many work at once in one tree of conversations. Sigma's own
// subagent tools and Claude Code's hosted subagents both check them, so they live here.
import { type ConversationId, defineDoc, type Tx } from "@sigma/kernel"
import { Effect } from "effect"

export type AgentLimits = {
  /** Levels of subagents below the conversation people started: 1 lets it start subagents that cannot start more. */
  readonly maxDepth: number
  /** Subagents of one tree with a run in flight at once. */
  readonly maxThreads: number
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxDepth: 1, maxThreads: 6 }

/** The canonical task path of the conversation people started. */
export const ROOT_TASK = "/root"

/** Levels below the root of a canonical task path: `/root` is 0, `/root/a` 1. */
export const depthOf = (task: string): number => task.split("/").length - 2

/** Why an idle subagent may not take a task while `working` subagents of its tree work, or `undefined`. */
export const refusedWork = (limits: AgentLimits, working: number): string | undefined =>
  working >= limits.maxThreads
    ? `at most ${limits.maxThreads} subagents work at once (maxThreads); ${working} are working, so wait for one to finish`
    : undefined

/** Why a subagent may not start under `parent` with `working` subagents of its tree busy, or `undefined`. */
export const refusedSpawn = (limits: AgentLimits, parent: string, working: number): string | undefined =>
  depthOf(parent) >= limits.maxDepth
    ? `agents may nest ${limits.maxDepth} deep (maxDepth); ${parent} can't start another`
    : refusedWork(limits, working)

/**
 * The call a subagent came from: the parent's call, the subagent's title, and, for one sigma's own tools started, its
 * canonical task path. Its parent is its owner's conversation. Written in the commit that creates it.
 */
export type SubagentOrigin = {
  readonly call: string
  readonly title: string
  readonly task?: string
  readonly agentType?: string
}

export const SubagentOriginDoc = defineDoc<SubagentOrigin>({
  kind: "sigma.subagent_origin",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork of a subagent is a conversation of its own, started by no call.
  fork: "initial",
  initial: () => ({ call: "", title: "" }),
  checkpointWhen: () => true,
})

/** Records where the subagent `child` came from, in the commit that creates it. */
export const recordOrigin = (tx: Tx, child: ConversationId, origin: SubagentOrigin) =>
  Effect.map(tx.doc(SubagentOriginDoc, child), (doc) => {
    Object.assign(doc, origin)
  })
