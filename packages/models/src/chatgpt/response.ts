// What ChatGPT's stream of Responses events says, as the seam's events: text and calls as they grow, then `done`, or
// `error` with the reason. Deltas name no item in some streams, so a delta goes to the item of its kind opened last.
import { parseToolCallArguments } from "../json-parse.ts"
import { ToolCallArgumentsStream } from "../streaming-json.ts"
import type { AssistantMessage, AssistantMessageEvent, TextContent, ToolCall, Usage } from "../types.ts"

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** The reason of a stream that ended before its response did. */
export const STREAM_CUT = "the response stream ended before the response finished"

const USAGE_LIMIT_CODES = ["usage_limit_reached", "usage_not_included", "rate_limit_exceeded"]

const isUsageLimit = (error: any) => USAGE_LIMIT_CODES.includes(error?.code ?? error?.type)

const usageLimit = (error: any) => {
  const plan = typeof error?.plan_type === "string" ? ` (${error.plan_type.toLowerCase()} plan)` : ""
  const when =
    typeof error?.resets_at === "number"
      ? ` Try again in about ${Math.max(0, Math.floor((error.resets_at * 1000 - Date.now()) / 60_000))} min.`
      : ""
  return `You have hit your ChatGPT usage limit${plan}.${when}`
}

/**
 * Why a response failed, from its error. The code and the message are both kept: `isContextOverflow` and
 * `isRetryableAssistantError` read them. A real overflow (gpt-6-luna, 2026-11-11) is an `error` event with
 * `code: "context_length_exceeded"` and "Your input exceeds the context window of this model".
 */
export const responseFailure = (error: any) => {
  if (isUsageLimit(error)) return usageLimit(error)
  const code = error?.code ?? error?.type
  const message = typeof error?.message === "string" ? error.message : "no details given"
  return typeof code === "string" ? `the response failed (${code}): ${message}` : `the response failed: ${message}`
}

const LONGEST_ERROR_BODY = 1000

export const SIGN_IN_REFUSED = "ChatGPT turned the sign-in down; sign in again"

/** Why an HTTP answer other than 200 failed the request, from its status and body. */
export const httpFailure = (status: number, body: any) => {
  const error = body?.error
  if (isUsageLimit(error) || status === 429) return usageLimit(error)
  if (status === 401) return SIGN_IN_REFUSED
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof body?.detail === "string"
        ? body.detail
        : (typeof body === "string" ? body : JSON.stringify(body)).slice(0, LONGEST_ERROR_BODY)
  return `ChatGPT answered ${status}: ${message}`
}

const messageText = (item: any): string =>
  (Array.isArray(item?.content) ? item.content : [])
    .map((part: any) =>
      typeof part?.text === "string" ? part.text : typeof part?.refusal === "string" ? part.refusal : "",
    )
    .join("")

const usageOf = (usage: any): Usage => {
  const input = Number(usage?.input_tokens) || 0
  const cached = Number(usage?.input_tokens_details?.cached_tokens) || 0
  const output = Number(usage?.output_tokens) || 0
  return {
    ...ZERO_USAGE,
    input: Math.max(0, input - cached),
    output,
    cacheRead: cached,
    totalTokens: Number(usage?.total_tokens) || input + output,
  }
}

type Open =
  | { readonly kind: "text"; readonly index: number; readonly block: TextContent }
  | {
      readonly kind: "call"
      readonly index: number
      readonly block: ToolCall
      readonly custom: boolean
      readonly args: ToolCallArgumentsStream
    }

/**
 * Reads one response's events in order. `grammarInputs` names the parameter each grammar tool's raw input fills; a
 * custom call to any other tool fills `input`.
 */
export class ResponseReader {
  readonly #partial: AssistantMessage
  readonly #grammarInputs: ReadonlyMap<string, string>
  readonly #open = new Map<string, Open>()
  #lastText: Open | undefined
  #lastCall: Open | undefined
  #ended = false

  constructor(template: AssistantMessage, grammarInputs: ReadonlyMap<string, string>) {
    this.#partial = { ...template, content: [], stopReason: "pending" }
    this.#grammarInputs = grammarInputs
  }

  get ended() {
    return this.#ended
  }

  start(): AssistantMessageEvent {
    return { type: "start", partial: this.#snapshot() }
  }

  /** The seam's events for one of ChatGPT's. */
  push(event: any): Array<AssistantMessageEvent> {
    if (this.#ended) return []
    const item = event?.item
    switch (event?.type) {
      case "response.created":
        if (typeof event.response?.id === "string") this.#partial.responseId = event.response.id
        return []
      case "response.output_item.added":
        if (item?.type === "message") return this.#openText(item.id).events
        if (item?.type === "function_call" || item?.type === "custom_tool_call") return this.#openCall(item).events
        return []
      case "response.output_text.delta":
      case "response.refusal.delta":
        return this.#textDelta(event.item_id, typeof event.delta === "string" ? event.delta : "")
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta":
        return this.#callDelta(event.item_id, typeof event.delta === "string" ? event.delta : "")
      case "response.output_item.done":
        if (item?.type === "message") return this.#closeText(item)
        if (item?.type === "function_call" || item?.type === "custom_tool_call") return this.#closeCall(item)
        return []
      case "response.completed":
      case "response.done":
        return this.#finish(event.response, "stop")
      case "response.incomplete":
        return this.#finish(event.response, "length")
      case "response.failed":
        return [this.fail(responseFailure(event.response?.error))]
      case "error":
        return [this.fail(responseFailure(typeof event.error === "object" ? event.error : event))]
      default:
        return []
    }
  }

  /** Ends the response as failed, keeping what it said so far. */
  fail(errorMessage: string): AssistantMessageEvent {
    this.#ended = true
    const error: AssistantMessage = { ...this.#snapshot(), stopReason: "error", errorMessage }
    return { type: "error", reason: "error", error }
  }

  #snapshot(): AssistantMessage {
    return { ...this.#partial, content: [...this.#partial.content] }
  }

  #append(block: TextContent | ToolCall): number {
    this.#partial.content.push(block)
    return this.#partial.content.length - 1
  }

  #openText(id: unknown) {
    const block: TextContent = { type: "text", text: "" }
    const open: Open = { kind: "text", index: this.#append(block), block }
    if (typeof id === "string") this.#open.set(id, open)
    this.#lastText = open
    const events: Array<AssistantMessageEvent> = [
      { type: "text_start", contentIndex: open.index, partial: this.#snapshot() },
    ]
    return { open, events }
  }

  #openCall(item: any) {
    const custom = item.type === "custom_tool_call"
    const block: ToolCall = {
      type: "toolCall",
      id: typeof item.call_id === "string" ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      arguments: {},
    }
    const open: Open = { kind: "call", index: this.#append(block), block, custom, args: new ToolCallArgumentsStream() }
    if (typeof item.id === "string") this.#open.set(item.id, open)
    this.#lastCall = open
    const events: Array<AssistantMessageEvent> = [
      { type: "toolcall_start", contentIndex: open.index, partial: this.#snapshot() },
    ]
    return { open, events }
  }

  #textDelta(id: unknown, delta: string): Array<AssistantMessageEvent> {
    const found = (typeof id === "string" ? this.#open.get(id) : undefined) ?? this.#lastText
    const opened = found?.kind === "text" ? { open: found, events: [] } : this.#openText(id)
    if (opened.open.kind !== "text" || delta === "") return opened.events
    opened.open.block.text += delta
    return [...opened.events, { type: "text_delta", contentIndex: opened.open.index, delta, partial: this.#snapshot() }]
  }

  #callDelta(id: unknown, delta: string): Array<AssistantMessageEvent> {
    const open = (typeof id === "string" ? this.#open.get(id) : undefined) ?? this.#lastCall
    if (open?.kind !== "call" || delta === "") return []
    if (open.custom) {
      const property = this.#grammarInputs.get(open.block.name) ?? "input"
      const raw = `${(open.block.arguments[property] as string | undefined) ?? ""}${delta}`
      open.block.arguments = { [property]: raw }
    } else {
      open.block.arguments = open.args.append(delta)
    }
    return [{ type: "toolcall_delta", contentIndex: open.index, delta, partial: this.#snapshot() }]
  }

  #closeText(item: any): Array<AssistantMessageEvent> {
    const text = messageText(item)
    const found = typeof item.id === "string" ? this.#open.get(item.id) : undefined
    if (found === undefined && text === "") return []
    const opened = found?.kind === "text" ? { open: found, events: [] } : this.#openText(item.id)
    if (opened.open.kind !== "text") return opened.events
    opened.open.block.text = text
    if (this.#lastText === opened.open) this.#lastText = undefined
    return [
      ...opened.events,
      { type: "text_end", contentIndex: opened.open.index, content: text, partial: this.#snapshot() },
    ]
  }

  #closeCall(item: any): Array<AssistantMessageEvent> {
    const found = typeof item.id === "string" ? this.#open.get(item.id) : undefined
    const opened = found?.kind === "call" ? { open: found, events: [] } : this.#openCall(item)
    const open = opened.open
    if (open.kind !== "call") return opened.events
    if (typeof item.call_id === "string") open.block.id = item.call_id
    if (typeof item.name === "string") open.block.name = item.name
    if (open.custom) {
      const property = this.#grammarInputs.get(open.block.name) ?? "input"
      open.block.arguments = { [property]: typeof item.input === "string" ? item.input : "" }
    } else {
      const parsed = parseToolCallArguments(typeof item.arguments === "string" ? item.arguments : "{}")
      open.block.arguments = parsed.arguments
      if (parsed.argumentsError !== undefined) open.block.argumentsError = parsed.argumentsError
    }
    if (this.#lastCall === open) this.#lastCall = undefined
    return [
      ...opened.events,
      { type: "toolcall_end", contentIndex: open.index, toolCall: { ...open.block }, partial: this.#snapshot() },
    ]
  }

  #finish(response: any, reason: "stop" | "length"): Array<AssistantMessageEvent> {
    this.#ended = true
    const calls = this.#partial.content.some((block) => block.type === "toolCall")
    const stopReason = reason === "stop" && calls ? "toolUse" : reason
    const message: AssistantMessage = {
      ...this.#snapshot(),
      ...(response?.usage === undefined ? {} : { usage: usageOf(response.usage) }),
      ...(typeof response?.model === "string" ? { responseModel: response.model } : {}),
      stopReason,
    }
    return [{ type: "done", reason: stopReason, message }]
  }
}
