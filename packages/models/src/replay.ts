// Streams a finished assistant message as a provider would: `start`, then each block's start, deltas and end, then
// `done` or `error`. The scripted providers, `script` and `faux`, both answer this way. The event order and the
// partial follow pi-ai's faux provider (`src/providers/faux.ts` at 7d073328e): `partial` is the response so far,
// shared between events, and tool-call arguments grow through the same parser real providers use.
import { Effect, Queue, Stream } from "effect"
import { ToolCallArgumentsStream } from "./streaming-json.ts"
import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "./types.ts"

export interface Pacing {
  /** The deltas a text is sent in. */
  readonly split: (text: string) => readonly string[]
  /** Waits before a delta is sent. */
  readonly pause: (chunk: string) => Effect.Effect<void>
}

/** A message for a request that failed before it answered. */
export const failure = (template: AssistantMessage, errorMessage: string): AssistantMessage => ({
  ...template,
  content: [],
  stopReason: "error",
  errorMessage,
  timestamp: Date.now(),
})

export const replay = (message: AssistantMessage, pacing: Pacing): Stream.Stream<AssistantMessageEvent> =>
  Stream.callback<AssistantMessageEvent>((queue) =>
    Effect.gen(function* () {
      const emit = (event: AssistantMessageEvent) => Queue.offer(queue, event)
      const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" }
      const deltas = function* (text: string, onChunk: (chunk: string) => AssistantMessageEvent) {
        for (const chunk of pacing.split(text)) {
          yield* pacing.pause(chunk)
          yield* emit(onChunk(chunk))
        }
      }
      yield* emit({ type: "start", partial: { ...partial } })
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type === "thinking") {
          const live: ThinkingContent = { type: "thinking", thinking: "" }
          partial.content = [...partial.content, live]
          yield* emit({ type: "thinking_start", contentIndex, partial: { ...partial } })
          yield* deltas(block.thinking, (delta) => {
            live.thinking += delta
            return { type: "thinking_delta", contentIndex, delta, partial: { ...partial } }
          })
          yield* emit({ type: "thinking_end", contentIndex, content: block.thinking, partial: { ...partial } })
        } else if (block.type === "text") {
          const live: TextContent = { type: "text", text: "" }
          partial.content = [...partial.content, live]
          yield* emit({ type: "text_start", contentIndex, partial: { ...partial } })
          yield* deltas(block.text, (delta) => {
            live.text += delta
            return { type: "text_delta", contentIndex, delta, partial: { ...partial } }
          })
          yield* emit({ type: "text_end", contentIndex, content: block.text, partial: { ...partial } })
        } else {
          const live: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {} }
          partial.content = [...partial.content, live]
          yield* emit({ type: "toolcall_start", contentIndex, partial: { ...partial } })
          const parsed = new ToolCallArgumentsStream()
          yield* deltas(JSON.stringify(block.arguments), (delta) => {
            live.arguments = parsed.append(delta)
            return { type: "toolcall_delta", contentIndex, delta, partial: { ...partial } }
          })
          live.arguments = block.arguments
          yield* emit({ type: "toolcall_end", contentIndex, toolCall: block, partial: { ...partial } })
        }
      }
      const reason = message.stopReason
      if (reason === "pending") {
        yield* emit({ type: "error", reason: "error", error: failure(message, "response ended without a stop reason") })
      } else if (reason === "error" || reason === "aborted") {
        yield* emit({ type: "error", reason, error: message })
      } else {
        yield* emit({ type: "done", reason, message })
      }
      yield* Queue.end(queue)
    }),
  )
