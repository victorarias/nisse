// `tool_search`: the model searches the deferred tools it is not offered yet, and the matches are loaded with
// `control.addTools`, so the next request offers them. Loading writes the conversation's `modelTools` (its `add`), so
// loaded tools stay offered on that branch, also after a compaction. Derived from pi-durable's
// `src/tool-search/tool-search.ts` (earendil-works/pi, packages/durable, commit 7d073328e), under the MIT license in this
// package's LICENSE (Copyright 2025 Mario Zechner).
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@nisse/harness"
import { num, obj, opt, type Static, str } from "@nisse/schema"
import { Effect } from "effect"
import { rankDocuments } from "./search.ts"

export const TOOL_SEARCH_TOOL_NAME = "tool_search"
export const DEFAULT_TOOL_SEARCH_LIMIT = 8

/** Fixed, so it does not change while deferred tools are registered, for example as MCP servers connect. */
const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`

const toolSearchSchema = obj(
  {
    query: str({ description: "Search query for deferred tools." }),
    limit: opt(num({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` })),
  },
  { open: true },
)

export type ToolSearchInput = Static<typeof toolSearchSchema>

/** `tool_search` result details: the tools it loaded. */
export type ToolSearchToolDetails = { loaded: string[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The subschema a local JSON pointer (`#/$defs/Name`) names in `root`; `undefined` when it names none. */
export function resolveSchemaRef(ref: string, root: unknown): Record<string, unknown> | boolean | undefined {
  if (ref !== "#" && !ref.startsWith("#/")) return undefined
  let current: unknown = root
  for (const segment of ref.slice(2).split("/").filter(Boolean)) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // Schemas come from tools and MCP servers: a malformed escape names nothing instead of failing the caller.
      return undefined
    }
    const key = decoded.replaceAll("~1", "/").replaceAll("~0", "~")
    if (!isObject(current) || !(key in current)) return undefined
    current = current[key]
  }
  if (typeof current === "boolean") return current
  return isObject(current) ? current : undefined
}

/**
 * Schema descriptions and property names, recursively, following local `$ref`s into `root`. `seen` holds the
 * subschemas already reached through a reference, so recursive and shared definitions are read once, and definitions no
 * property references are not read.
 */
function schemaText(schema: unknown, root: unknown, parts: string[], seen: Set<unknown>): void {
  if (!isObject(schema)) return
  if (typeof schema.$ref === "string") {
    const target = resolveSchemaRef(schema.$ref, root)
    if (isObject(target) && !seen.has(target)) {
      seen.add(target)
      schemaText(target, root, parts, seen)
    }
  }
  if (typeof schema.description === "string") parts.push(schema.description)
  if (isObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name)
      schemaText(property, root, parts, seen)
    }
  }
  schemaText(schema.items, root, parts, seen)
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key]
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, root, parts, seen)
  }
}

/** Search text of a tool: its description and its parameters' names and descriptions; the ranker reads the name. */
function searchText(tool: ToolRegistration): string {
  const parts = [tool.description]
  schemaText(tool.parameters, tool.parameters, parts, new Set([tool.parameters]))
  return parts.filter((part) => part.trim() !== "").join(" ")
}

export function createToolSearchTool() {
  return defineTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description: TOOL_SEARCH_DESCRIPTION,
    parameters: toolSearchSchema,
    // Searching changes what the model is offered; scripts have their own `searchTools()`.
    callers: ["model"],
    replay: "safe",
    execute: ({ query, limit }: ToolSearchInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        if (query.trim() === "") return yield* Effect.fail(new Error("query must not be empty"))
        const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT
        if (!Number.isInteger(max) || max <= 0) return yield* Effect.fail(new Error("limit must be a positive integer"))
        const candidates = (yield* api.agent).deferred
        const documents = candidates.map((tool) => ({ name: tool.name, text: searchText(tool) }))
        const loaded = rankDocuments(query, documents, max)
        const text =
          loaded.length === 0
            ? "No matching tools found."
            : `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${loaded
                .map((name) => {
                  const description = candidates.find((tool) => tool.name === name)?.description ?? ""
                  return `- ${name}: ${description.trim().split(/\r?\n/)[0]}`
                })
                .join("\n")}`
        const details: ToolSearchToolDetails = { loaded }
        return {
          output: [{ type: "text" as const, text }],
          details,
          ...(loaded.length === 0 ? {} : { control: { addTools: loaded } }),
        }
      }),
  })
}

/** The `tool_search` extension: install it and select it where the model should find deferred tools. */
export function createToolSearchExtension() {
  return defineExtension({ name: "tool-search", tools: [createToolSearchTool()] })
}
