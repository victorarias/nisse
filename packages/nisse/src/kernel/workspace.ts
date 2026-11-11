// What a ChatGPT conversation on the kernel is told of where it works: its directory, the `AGENTS.md` files, the
// skills and the agent types there, as a prompt section the harness renders before each request and commits when it
// changes. Claude Code reads its own `CLAUDE.md` files and skills, and a script reads nothing, so their conversations
// get none.
import { defineExtension } from "@nisse/harness"
import type { ImageContent, ProviderInstance, TextContent } from "@nisse/models"
import { Effect } from "effect"
import type { Home } from "../home.ts"
import type { Skill } from "@nisse/wire"
import { type AgentType, agentsMdInstructions, attachedSkills, skillsFor, skillsInstructions } from "../workspace.ts"
import type { AgentTypes } from "./agents.ts"

/** What ChatGPT is told of the agent types `spawn_agent` takes, or `""` when there are none. */
const agentTypesInstructions = (types: ReadonlyArray<AgentType>) =>
  types.length === 0
    ? ""
    : `\n# Agent types\n\nThe agent types \`spawn_agent\` takes as \`agent_type\`:\n${types.map((type) => `- ${type.name}: ${type.description}\n`).join("")}`

export const workspaceInstructions = (
  home: Home,
  instances: ReadonlyMap<string, ProviderInstance>,
  agentTypes: AgentTypes,
) =>
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
            const text = `The working directory is ${cwd}.\n${agentsMdInstructions(cwd, home.dir)}${skillsInstructions(cwd, home.dir, "read")}${agentTypesInstructions(agentTypes(agent))}`
            return text.trimEnd()
          }),
      },
    ],
  })

/** The skills input to a conversation on `agent` can name: a ChatGPT conversation's, and none for the rest. */
export const skillsOf = (
  home: Home,
  instances: ReadonlyMap<string, ProviderInstance>,
  agent: { readonly model?: { readonly provider: string }; readonly cwd?: string },
): ReadonlyArray<Skill> => {
  const provider = agent.model?.provider
  if (provider === undefined || instances.get(provider)?.kind !== "openai") return []
  return skillsFor(agent.cwd ?? home.dir, home.dir)
}

/**
 * What a person's `text` and `images` give the model: the text, the `SKILL.md` of each skill it names, read now so a
 * later edit of the file changes later messages only, then the images; and the skills it carried, for the transcript.
 */
export const userInput = (text: string, skills: ReadonlyArray<Skill>, images: ReadonlyArray<ImageContent>) => {
  const attached = attachedSkills(text, skills)
  if (attached.length === 0 && images.length === 0) return { content: text, attached }
  const content: Array<TextContent | ImageContent> = [
    { type: "text", text },
    ...attached.map((skill) => ({
      type: "text" as const,
      text: `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${skill.text.trimEnd()}\n</skill>`,
    })),
    ...images,
  ]
  return { content, attached }
}
