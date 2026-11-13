// Where a conversation works: its directory, the `AGENTS.md` files, the skills and the agent types there, and how a
// ChatGPT conversation is told of them, as a prompt section the harness renders before each request and commits when
// it changes. Claude Code reads its own `CLAUDE.md` files and skills, and a script reads nothing, so their
// conversations get none.
import { defineExtension } from "@sigma/harness"
import type { ImageContent, ProviderInstance, TextContent } from "@sigma/models"
import { Effect } from "effect"
import type { Home } from "./home.ts"
import type { AgentTypes } from "./agents.ts"
import type { AttachedSkill, Skill } from "@sigma/protocol"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export const AGENTS_MD_LIMIT = 32 * 1024

export interface AgentsMd {
  readonly path: string
  readonly text: string
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const projectDirs = (cwd: string): Array<string> => {
  const dirs: Array<string> = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir)
    if (existsSync(join(dir, ".git"))) return dirs.reverse()
    if (dirname(dir) === dir) return [cwd]
  }
}

export const agentsMd = (cwd: string, home: string): Array<AgentsMd> => {
  const project = projectDirs(cwd).map((dir) =>
    isFile(join(dir, "AGENTS.override.md")) ? join(dir, "AGENTS.override.md") : join(dir, "AGENTS.md"),
  )
  let room = AGENTS_MD_LIMIT
  const files: Array<AgentsMd> = []
  for (const path of [join(home, "AGENTS.md"), ...project]) {
    if (room === 0) break
    const text = read(path)
    if (text === undefined || text.trim() === "") continue
    const kept = Buffer.from(text).subarray(0, room).toString("utf8").replace(/�$/, "")
    room -= Buffer.byteLength(kept)
    files.push({ path, text: kept })
  }
  return files
}

const BLOCK_SCALARS = new Set(["|", ">", "|-", ">-", "|+", ">+"])

const frontmatter = (text: string): Map<string, string> => {
  const fields = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trimEnd() !== "---") return fields
  let last: string | undefined
  for (const line of lines.slice(1)) {
    if (line.trimEnd() === "---") break
    if (/^[ \t]/.test(line)) {
      if (last === undefined) continue
      const value = fields.get(last)!
      const more = line.trim()
      fields.set(last, value !== "" && more !== "" ? `${value} ${more}` : value + more)
      continue
    }
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const raw = line.slice(colon + 1).trim()
    const quoted = raw.length >= 2 && /^(".*"|'.*')$/.test(raw)
    last = line.slice(0, colon).trim()
    fields.set(last, BLOCK_SCALARS.has(raw) ? "" : quoted ? raw.slice(1, -1) : raw)
  }
  return fields
}

const afterFrontmatter = (text: string) => {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trimEnd() !== "---") return text
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---")
  return end < 0 ? "" : lines.slice(end + 1).join("\n")
}

const readSkill = (folder: string): Skill | undefined => {
  const path = join(folder, "SKILL.md")
  const text = read(path)
  if (text === undefined) return undefined
  const fields = frontmatter(text)
  return { name: fields.get("name") || basename(folder), description: fields.get("description") ?? "", path }
}

const folders = (root: string) => {
  try {
    return readdirSync(root).map((name) => join(root, name))
  } catch {
    return []
  }
}

export const skillsFor = (cwd: string, home: string): Array<Skill> => {
  const roots = [
    ...projectDirs(cwd)
      .reverse()
      .flatMap((dir) => [join(dir, ".agents", "skills"), join(dir, ".claude", "skills")]),
    join(home, "skills"),
  ]
  const skills = new Map<string, Skill>()
  for (const folder of roots.flatMap(folders)) {
    const skill = readSkill(folder)
    if (skill && !skills.has(skill.name)) skills.set(skill.name, skill)
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const skillsHeading = (read: string) => `# Skills

A skill is a folder of instructions for one kind of task, in a \`SKILL.md\` file. When a task matches a skill's description, \`${read}\` its \`SKILL.md\` before you start, and follow it. When a message names a skill with \`/name\` or \`$name\`, the skill's \`SKILL.md\` comes with the message; follow it. Relative paths in a skill are relative to its folder.

`

/** What ChatGPT is told of the `AGENTS.md` files of a conversation in `cwd`: one block each, or `""`. */
export const agentsMdInstructions = (cwd: string, home: string) =>
  agentsMd(cwd, home)
    .map((file) => `\n# AGENTS.md instructions from ${file.path}\n\n${file.text.trimEnd()}\n`)
    .join("")

/**
 * What ChatGPT is told of the skills a conversation in `cwd` can use, or `""` when it has none. `read` names the tool
 * that reads a file, as the server offers it.
 */
export const skillsInstructions = (cwd: string, home: string, read: string) => {
  const skills = skillsFor(cwd, home)
  return skills.length === 0
    ? ""
    : `\n${skillsHeading(read)}${skills.map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.path})\n`).join("")}`
}

const skillName = (text: string) => (text.match(/^[\p{L}\p{N}\-_.:]*/u)?.[0] ?? "").replace(/[.:]+$/, "")

export const attachedSkills = (text: string, skills: ReadonlyArray<Skill>): Array<AttachedSkill> => {
  const trimmed = text.trimStart()
  const names = [
    ...(trimmed.startsWith("/") ? [skillName(trimmed.slice(1))] : []),
    ...[...trimmed.matchAll(/\$/g)].map((match) => skillName(trimmed.slice(match.index + 1))),
  ]
  const attached: Array<AttachedSkill> = []
  for (const name of names) {
    const skill = skills.find((known) => known.name === name)
    if (!skill || attached.some((done) => done.name === name)) continue
    const skillText = read(skill.path)
    if (skillText !== undefined) attached.push({ name: skill.name, path: skill.path, text: skillText })
  }
  return attached
}

export interface AgentType {
  readonly name: string
  readonly description: string
  readonly model?: string
  readonly instructions: string
}

const readAgentType = (path: string): AgentType | undefined => {
  const text = read(path)
  if (text === undefined) return undefined
  const fields = frontmatter(text)
  const model = fields.get("model")
  return {
    name: fields.get("name") || basename(path, ".md"),
    description: fields.get("description") ?? "",
    ...(model ? { model } : {}),
    instructions: afterFrontmatter(text).trim(),
  }
}

export const agentTypes = (cwd: string, claudeConfig: string): Array<AgentType> => {
  const roots = [
    ...projectDirs(cwd)
      .reverse()
      .map((dir) => join(dir, ".claude", "agents")),
    join(claudeConfig, "agents"),
  ]
  const types = new Map<string, AgentType>()
  for (const root of roots) {
    for (const path of folders(root)
      .filter((path) => path.endsWith(".md"))
      .sort()) {
      const type = readAgentType(path)
      if (type && !types.has(type.name)) types.set(type.name, type)
    }
  }
  return [...types.values()].sort((a, b) => a.name.localeCompare(b.name))
}

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
    name: "sigma-workspace",
    sections: [
      {
        key: "workspace",
        tag: false,
        render: ({ agent }) =>
          Effect.sync(() => {
            const provider = agent.model?.provider
            if (provider === undefined || instances.get(provider)?.kind !== "openai") return undefined
            const cwd = agent.cwd ?? home.dir
            // Past the depth limit a subagent has no spawn_agent, so it has no use for the types. A code-mode model is
            // offered only codemode, whose scripts call spawn_agent, so the callable tools decide, not the offered ones.
            const offersSpawn = agent.callable.some((tool) => tool.name === "spawn_agent")
            const text = `The working directory is ${cwd}.\n${agentsMdInstructions(cwd, home.dir)}${skillsInstructions(cwd, home.dir, "read")}${agentTypesInstructions(offersSpawn ? agentTypes(agent) : [])}`
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
