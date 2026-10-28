import { builtinTools, type Tool } from "../../../tools/index.ts"
import { ApplyPatch } from "./apply-patch.ts"

const OUTCOME = "{ is_error: boolean; output: string; }"

const freeform = new Set<Tool>([ApplyPatch])

export const nestedTools: ReadonlyArray<Tool> = [...builtinTools, ApplyPatch]

const identifier = (name: string) =>
  [...name].map((ch, index) => (/[A-Za-z_$]/.test(ch) || (index > 0 && /[0-9]/.test(ch)) ? ch : "_")).join("") || "_"

const typescript = (schema: any): string => {
  if (Array.isArray(schema?.enum)) return schema.enum.map((value: unknown) => JSON.stringify(value)).join(" | ")
  switch (schema?.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return schema.items === undefined ? "unknown[]" : `Array<${typescript(schema.items)}>`
    case "object":
      return object(schema)
    default:
      return "unknown"
  }
}

const object = (schema: any): string => {
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
  const properties = Object.entries<any>(schema.properties ?? {}).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const property = (name: string, value: unknown) => `${name}${required.has(name) ? "" : "?"}: ${typescript(value)};`
  if (!properties.some(([, value]) => typeof value?.description === "string")) {
    return properties.length === 0 ? "{}" : `{ ${properties.map(([name, value]) => property(name, value)).join(" ")} }`
  }
  const lines = ["{"]
  for (const [name, value] of properties) {
    const description: string = typeof value?.description === "string" ? value.description : ""
    for (const line of description.split("\n").map((line) => line.trim())) if (line !== "") lines.push(`  // ${line}`)
    lines.push(`  ${property(name, value)}`)
  }
  lines.push("}")
  return lines.join("\n")
}

const sample = (tool: Tool) => {
  const [input, type] = freeform.has(tool) ? ["input", "string"] : ["args", typescript(tool.spec.parameters)]
  return `${tool.spec.description}\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${identifier(tool.spec.name)}(${input}: ${type}): Promise<${OUTCOME}>; };\n\`\`\``
}

export const definition = (tool: Tool) => ({
  name: tool.spec.name,
  tool_name: { name: tool.spec.name, namespace: null },
  description: sample(tool),
  kind: freeform.has(tool) ? "freeform" : "function",
  input_schema: null,
  output_schema: null,
})

export const section = (tool: Tool) => {
  const global = identifier(tool.spec.name)
  const heading = global === tool.spec.name ? `### \`${global}\`` : `### \`${global}\` (\`${tool.spec.name}\`)`
  return `${heading}\n${sample(tool)}`
}

export const nestedCall = (name: string, input: unknown): { tool: Tool; input: unknown } | { error: string } => {
  const tool = nestedTools.find((candidate) => candidate.spec.name === name)
  if (!tool) return { error: `no tool named ${name}` }
  if (freeform.has(tool)) return typeof input === "string" ? { tool, input } : { error: `${name} takes a string` }
  if (input === null || input === undefined) return { tool, input: {} }
  if (typeof input === "object" && !Array.isArray(input)) return { tool, input }
  return { error: `${name} takes an object` }
}
