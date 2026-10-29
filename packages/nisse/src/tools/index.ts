import { Bash } from "./bash.ts"
import { Edit, Read, Write } from "./files.ts"
import { Glob, Grep } from "./search.ts"
import type { Tool } from "./tool.ts"

export const builtinTools: ReadonlyArray<Tool> = [Read, Write, Edit, Bash, Grep, Glob]

export const toolNamed = (name: string) => builtinTools.find((tool) => tool.spec.name === name)

export type { Tool, ToolContext, ToolOutcome, ToolSpec } from "./tool.ts"
export { toolEnv } from "./tool.ts"
