// What a `claude.run` invocation and the `claude.subagent` tasks under it share in memory: how each hosted subagent
// ended, and how to stop it. Neither survives a restart, which abandons the subagent tasks with the process.
import type { HookApi } from "@sigma/harness"
import type { TaskId } from "@sigma/kernel"
import { Deferred } from "effect"

/** How Claude Code said a subagent ended. */
export type SubagentEnd = { readonly status: "completed" | "failed" | "stopped"; readonly summary?: string }

export type SubagentLink = {
  readonly ended: Deferred.Deferred<SubagentEnd>
  /** The hook API of the subagent's conversation, which its calls' hooks are given; set once its task runs. */
  readonly hookApi: Deferred.Deferred<HookApi>
  /** Asks Claude Code to stop the subagent; set once its process is known. */
  stop?: () => Promise<void>
}

export class SubagentLinks {
  readonly #links = new Map<TaskId, SubagentLink>()

  /** The link of the subagent task `id`, made by whichever side asks first. */
  link(id: TaskId): SubagentLink {
    let link = this.#links.get(id)
    if (link === undefined)
      this.#links.set(
        id,
        (link = { ended: Deferred.makeUnsafe<SubagentEnd>(), hookApi: Deferred.makeUnsafe<HookApi>() }),
      )
    return link
  }

  forget(id: TaskId): void {
    this.#links.delete(id)
  }
}
