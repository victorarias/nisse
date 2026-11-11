// The body of a request to ChatGPT's `/codex/responses`, from a transcript. Every system message is folded into
// `instructions`, after the provider's own; the tools are the transcript's current ones; nothing is stored on
// ChatGPT's side (`store: false`), so each request carries the whole input.
//
// Assistant messages that failed or were stopped are left out, and a call left without a result gets one saying so,
// as pi-ai's `transformMessages` does (`src/api/transform-messages.ts` at 7d073328e): the API refuses a call without
// its output, and a cut-off response is not something the model said.
import { getCurrentSystemPrompt, getCurrentTools } from "../transcript.ts"
import type {
  AssistantMessage,
  ImageContent,
  Message,
  ModelThinkingLevel,
  TextContent,
  Tool,
  ToolCall,
  TranscriptContext,
} from "../types.ts"
import { grammarInput, grammarOf } from "./grammar.ts"

export interface RequestBody {
  readonly model: string
  readonly reasoning?: { readonly effort: string }
  readonly instructions: string
  readonly input: ReadonlyArray<unknown>
  readonly tools: ReadonlyArray<unknown>
  readonly tool_choice: "auto"
  readonly parallel_tool_calls: true
  readonly store: false
  readonly stream: true
  readonly prompt_cache_key?: string
}

export interface Request {
  readonly model: string
  /** The provider's own instructions, before the transcript's. */
  readonly instructions: string
  readonly reasoning?: ModelThinkingLevel
  /** The conversation's id at the provider: ChatGPT keys its prompt cache by it. */
  readonly sessionId?: string
}

/** The text of a call that has no result, sent in its place. */
export const NO_RESULT = "No result provided"

const toolDeclaration = (tool: Tool) => {
  const grammar = grammarOf(tool)
  return grammar === undefined
    ? { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }
    : {
        type: "custom",
        name: tool.name,
        description: tool.description,
        format: { type: "grammar", syntax: grammar.syntax, definition: grammar.definition },
      }
}

const inputContent = (content: string | ReadonlyArray<TextContent | ImageContent>) =>
  typeof content === "string"
    ? [{ type: "input_text", text: content }]
    : content.map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` },
      )

// A result of text alone is a string, as ChatGPT's own clients send it; one with images is a list of parts.
const resultOutput = (content: ReadonlyArray<TextContent | ImageContent>) =>
  content.every((part) => part.type === "text") ? content.map((part) => part.text).join("\n") : inputContent(content)

/** The messages as sent: failed responses left out, and every call answered before anything follows it. */
const answered = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  const result: Array<Message> = []
  let open: Array<ToolCall> = []
  const answeredIds = new Set<string>()
  const close = () => {
    for (const call of open) {
      if (answeredIds.has(call.id)) continue
      result.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: NO_RESULT }],
        isError: true,
        timestamp: 0,
      })
    }
    open = []
    answeredIds.clear()
  }
  for (const message of messages) {
    if (message.role === "system") continue
    if (message.role === "toolResult") {
      answeredIds.add(message.toolCallId)
      result.push(message)
      continue
    }
    close()
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue
      open = message.content.filter((block): block is ToolCall => block.type === "toolCall")
    }
    result.push(message)
  }
  close()
  return result
}

// By call id: the parameter a call's raw input fills, for a call to a grammar tool.
const assistantItems = (message: AssistantMessage, calls: ReadonlyMap<string, string>) =>
  message.content.flatMap((block): Array<unknown> => {
    if (block.type === "text") {
      return block.text === ""
        ? []
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] }]
    }
    if (block.type !== "toolCall") return []
    const property = calls.get(block.id)
    return property === undefined
      ? [{ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) }]
      : [
          {
            type: "custom_tool_call",
            call_id: block.id,
            name: block.name,
            input: grammarInput(block.name, block.arguments, property),
          },
        ]
  })

/** The parameter each grammar tool's raw input fills, by tool name. */
export const grammarInputs = (tools: ReadonlyArray<Tool>): ReadonlyMap<string, string> =>
  new Map(
    tools.flatMap((tool) => {
      const grammar = grammarOf(tool)
      return grammar === undefined ? [] : [[tool.name, grammar.inputProperty] as const]
    }),
  )

/**
 * By call id, the parameter each grammar tool call's raw input fills, as the tool was declared when the model made the
 * call: a tool redefined later, or no longer offered, leaves its earlier calls as they were made.
 */
const grammarCalls = (messages: ReadonlyArray<Message>): ReadonlyMap<string, string> => {
  const calls = new Map<string, string>()
  const declared = new Map<string, Tool>()
  for (const message of messages) {
    if (message.role === "system") {
      for (const tool of message.toolsRemoved ?? []) declared.delete(tool.name)
      for (const tool of message.toolsAdded ?? []) declared.set(tool.name, tool)
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue
        const tool = declared.get(block.name)
        // A malformed grammar was never offered, so no call was made against it.
        const property = tool === undefined ? undefined : tryGrammar(tool)?.inputProperty
        if (property !== undefined) calls.set(block.id, property)
      }
    }
  }
  return calls
}

const tryGrammar = (tool: Tool) => {
  try {
    return grammarOf(tool)
  } catch {
    return undefined
  }
}

/** Throws for a tool whose grammar is malformed: a mistake in the tool, which the request reports. */
export function requestBody(request: Request, context: TranscriptContext): RequestBody {
  const tools = getCurrentTools(context.messages)
  const calls = grammarCalls(context.messages)
  const input = answered(context.messages).flatMap((message): Array<unknown> => {
    if (message.role === "user") {
      const content = inputContent(message.content)
      return content.length === 0 ? [] : [{ type: "message", role: "user", content }]
    }
    if (message.role === "assistant") return assistantItems(message, calls)
    if (message.role === "toolResult") {
      return [
        {
          type: calls.has(message.toolCallId) ? "custom_tool_call_output" : "function_call_output",
          call_id: message.toolCallId,
          output: resultOutput(message.content),
        },
      ]
    }
    return []
  })
  const instructions = [request.instructions, getCurrentSystemPrompt(context.messages)]
    .filter((text) => text.length > 0)
    .join("\n\n")
  return {
    model: request.model,
    ...(request.reasoning === undefined || request.reasoning === "off"
      ? {}
      : { reasoning: { effort: request.reasoning } }),
    instructions,
    input,
    tools: tools.map(toolDeclaration),
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    ...(request.sessionId === undefined ? {} : { prompt_cache_key: request.sessionId }),
  }
}
