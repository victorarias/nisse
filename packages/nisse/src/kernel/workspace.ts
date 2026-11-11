// What a ChatGPT conversation on the kernel is told of where it works: its directory, the `AGENTS.md` files and the
// skills there, as a prompt section the harness renders before each request and commits when it changes. Claude Code
// reads its own `CLAUDE.md` files and skills, and a script reads nothing, so their conversations get none.
import { defineExtension } from "@nisse/harness"
import type { ProviderInstance } from "@nisse/models"
import { Effect } from "effect"
import type { Home } from "../home.ts"
import { agentsMdInstructions, skillsInstructions } from "../workspace.ts"

export const workspaceInstructions = (home: Home, instances: ReadonlyMap<string, ProviderInstance>) =>
  defineExtension({
    name: "nisse-workspace",
    sections: [
      {
        key: "workspace",
        tag: false,
        render: ({ agent }) =>
          Effect.sync(() => {
            const provider = agent.model?.provider
            if (provider === undefined || instances.get(provider)?.kind !== "openai") return undefined
            const cwd = agent.cwd ?? home.dir
            const text = `The working directory is ${cwd}.\n${agentsMdInstructions(cwd, home.dir)}${skillsInstructions(cwd, home.dir, "read")}`
            return text.trimEnd()
          }),
      },
    ],
  })
