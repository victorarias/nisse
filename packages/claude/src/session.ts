// Where a conversation stands in Claude Code's own session (F7): the session and its newest message that nisse
// committed, written in the commit of each entry a run records. Nisse's transcript is the truth; a run resumes Claude
// Code's session at this position, which drops whatever Claude Code went on to write, and retells what came after it.
import { defineDoc } from "@nisse/kernel"

export type ClaudeSession = {
  /** The conversation that wrote it; a fork sees its parent's until its first run forks the session. */
  conversation: number
  /** The provider instance whose Claude Code holds the session: another one starts its own. */
  provider: string
  /** Claude Code's session id. */
  session: string
  /** The newest message of the session this conversation committed, the point a resume continues from. */
  at: string
  /** The newest entry Claude Code has been shown through `at`. */
  seen: number
  /**
   * Claude Code's running usage totals by model at the session's last result: a process resuming the session
   * continues from its saved totals, so the next result's spend is what it adds to these.
   */
  totals?: Record<string, UsageTotals>
}

/** One model's running totals as Claude Code reports them (`modelUsage`). */
export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

export const CLAUDE_SESSION_KIND = "claude.session"

/** Rewindable, so a fork finds the position as of its fork entry. */
export const ClaudeSessionDoc = defineDoc<{ current?: ClaudeSession }>({
  kind: CLAUDE_SESSION_KIND,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
})
