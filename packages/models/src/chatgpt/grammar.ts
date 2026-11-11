// Grammar tools: a tool whose `constrainedSampling` is a grammar is offered to ChatGPT as a custom tool, and the raw
// text the model writes for it arrives as the one string property its parameters declare. From pi-ai's
// `src/api/constrained-sampling.ts` in earendil-works/pi at commit 7d073328e (MIT, see LICENSE): the grammar half,
// without the JSON-schema strict mode nisse does not send.
import type { Tool } from "../types.ts"

export interface Grammar {
  readonly syntax: "lark" | "regex"
  readonly definition: string
  /** The parameter the raw input fills. */
  readonly inputProperty: string
}

interface JsonSchemaObject {
  readonly type?: unknown
  readonly required?: unknown
  readonly properties?: Record<string, { readonly type?: unknown } | undefined>
}

function inputPropertyOf(tool: Tool): string {
  const schema = tool.parameters as JsonSchemaObject
  if (schema.type !== "object") throw new Error("grammar constrained sampling requires an object parameter schema")
  const required = schema.required
  if (!Array.isArray(required) || required.length !== 1 || typeof required[0] !== "string") {
    throw new Error("grammar constrained sampling requires exactly one required string property")
  }
  const property = required[0]
  if (schema.properties?.[property]?.type !== "string") {
    throw new Error(`grammar constrained sampling property ${property} must have type string`)
  }
  return property
}

/** The grammar a tool is offered with, or undefined for a tool whose arguments are JSON. */
export function grammarOf(tool: Tool): Grammar | undefined {
  const config = tool.constrainedSampling
  if (!config || config.type !== "grammar") return undefined
  const lark = config.variants.openai_lark
  const regex = config.variants.openai_regex
  const hasLark = typeof lark === "string" && lark.trim().length > 0
  const hasRegex = typeof regex === "string" && regex.trim().length > 0
  if (!hasLark && !hasRegex) {
    throw new Error(
      `Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
    )
  }
  try {
    return {
      syntax: hasLark ? "lark" : "regex",
      definition: hasLark ? lark : regex!,
      inputProperty: inputPropertyOf(tool),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`)
  }
}

/** The raw input of a grammar tool's call, from its arguments. */
export function grammarInput(toolName: string, args: Record<string, unknown>, inputProperty: string): string {
  const input = args[inputProperty]
  if (typeof input !== "string") {
    throw new Error(`Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`)
  }
  return input
}
