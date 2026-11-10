// A content-free `pi.ai.request` span per model request, on Effect's tracer: the request's provider, API, model and
// reasoning level at its start, and its stop reason, usage, cost and response ID at its end. Text, arguments and error
// details beyond a bounded provider message are never recorded.
import { Effect, Exit, Stream } from "effect"
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "./types.ts"

/** The longest provider error message an error status carries. */
const ERROR_MESSAGE_LIMIT = 500

const finalMessage = (event: AssistantMessageEvent): AssistantMessage | undefined =>
  event.type === "done" ? event.message : event.type === "error" ? event.error : undefined

/**
 * `stream` in a `pi.ai.request` span, a child of the span the request runs in. A final message with stop reason
 * `error` ends it with a `provider_error` status; a stream that ends without one ends it as it ended.
 */
export const traceRequest = <E>(
  model: Model<Api>,
  reasoning: unknown,
  stream: Stream.Stream<AssistantMessageEvent, E>,
): Stream.Stream<AssistantMessageEvent, E> =>
  Stream.unwrap(
    Effect.map(
      Effect.makeSpan("pi.ai.request", {
        attributes: {
          provider: model.provider,
          api: model.api,
          model: model.id,
          ...(typeof reasoning === "string" ? { reasoning } : {}),
        },
      }),
      (span) => {
        let ended = false
        const end = (exit: Exit.Exit<unknown, unknown>) => {
          if (ended) return
          ended = true
          span.end(BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), exit)
        }
        return stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              const message = finalMessage(event)
              if (message === undefined) return
              span.attribute("stop", message.stopReason)
              span.attribute("usage.input", message.usage.input)
              span.attribute("usage.output", message.usage.output)
              span.attribute("usage.cache_read", message.usage.cacheRead)
              span.attribute("usage.cache_write", message.usage.cacheWrite)
              span.attribute("cost.total", message.usage.cost.total)
              if (message.responseId !== undefined) span.attribute("response.id", message.responseId)
              if (message.stopReason !== "error") return end(Exit.void)
              const error = new Error((message.errorMessage ?? "").slice(0, ERROR_MESSAGE_LIMIT))
              error.name = "provider_error"
              end(Exit.fail(error))
            }),
          ),
          Stream.onExit((exit) => Effect.sync(() => end(Exit.isSuccess(exit) ? Exit.void : exit))),
        )
      },
    ),
  )
