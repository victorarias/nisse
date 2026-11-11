// Agent limits (D13): how deep subagents nest and how many work at once in one tree of conversations. Nisse's own
// subagent tools and Claude Code's hosted subagents both check them, so they live here.

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

/** Why a subagent may not start under `parent` with `working` subagents of its tree busy, or `undefined`. */
export const refusedSpawn = (limits: AgentLimits, parent: string, working: number): string | undefined =>
  depthOf(parent) >= limits.maxDepth
    ? `agents may nest ${limits.maxDepth} deep (maxDepth); ${parent} can't start another`
    : working >= limits.maxThreads
      ? `at most ${limits.maxThreads} subagents work at once (maxThreads); ${working} are working, so wait for one to finish`
      : undefined
