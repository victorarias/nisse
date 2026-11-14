// Tool-call argument validation as pi-ai's `src/utils/validation.ts` exposes it, over `@sigma/schema`'s
// `checkToolArguments`, the one pipeline tool arguments go through (D7).
import { checkToolArguments } from "@sigma/schema"
import type { Tool, ToolCall } from "./types.ts"

/** The coerced arguments of a call to `tool`. Throws with the message the model reads when they do not validate. */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
  if (toolCall.argumentsError) {
    throw new Error(`Invalid arguments for tool "${toolCall.name}": ${toolCall.argumentsError}`)
  }
  // A copy, so tools that modify their arguments never modify the tool call in the transcript.
  const result = checkToolArguments(toolCall.name, tool.parameters, structuredClone(toolCall.arguments))
  if (result.ok) return result.value
  throw new Error(result.message)
}
