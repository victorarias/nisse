import type { AttachedSkill, Skill } from "@nisse/protocol"
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
