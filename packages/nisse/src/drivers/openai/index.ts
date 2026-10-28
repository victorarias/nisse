import type { CallId, Entry } from "@nisse/protocol"
import { Effect, Semaphore } from "effect"
import { ProviderError, type Call, type Driver, type Turn } from "../../provider.ts"
import { isExpired, loadCredentials, refreshed, saveCredentials, type Credentials } from "./credentials.ts"
import { events } from "./sse.ts"

export const BASE_URL = "https://chatgpt.com/backend-api"
export const AUTH_BASE = "https://auth.openai.com"
export const MODEL = "gpt-5.5"
const ORIGINATOR = "nisse"
const LONGEST_ERROR_BODY = 1000

export interface OpenAiOptions {
  readonly authPath: string
  readonly authBase: string
  readonly baseUrl: string
  readonly instructions: string
}

const failure = (message: string) => new ProviderError({ message })

const inputItem = (entry: Entry): unknown => {
  const body = entry.body
  switch (body._tag) {
    case "user":
      return { type: "message", role: "user", content: [{ type: "input_text", text: body.text }] }
    case "message":
      return { type: "message", role: "assistant", content: [{ type: "output_text", text: body.text }] }
    case "tool_call":
      return {
        type: "function_call",
        call_id: body.call,
        name: body.tool,
        arguments: typeof body.input === "string" ? body.input : JSON.stringify(body.input),
      }
    case "tool_result":
      return { type: "function_call_output", call_id: body.call, output: body.output }
    default:
      return undefined
  }
}

const messageText = (item: any): string =>
  (Array.isArray(item?.content) ? item.content : [])
    .map((part: any) =>
      typeof part?.text === "string" ? part.text : typeof part?.refusal === "string" ? part.refusal : "",
    )
    .join("")

const parsedArguments = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const toolCall = (item: any): Effect.Effect<Call, ProviderError> =>
  typeof item?.call_id === "string"
    ? Effect.succeed({
        call: item.call_id as CallId,
        tool: typeof item.name === "string" ? item.name : "",
        input: parsedArguments(typeof item.arguments === "string" ? item.arguments : "{}"),
      })
    : Effect.fail(failure("a function call without a call_id"))

const isUsageLimit = (error: any) =>
  ["usage_limit_reached", "usage_not_included", "rate_limit_exceeded"].includes(error?.code ?? error?.type)

const usageLimit = (error: any) => {
  const plan = typeof error?.plan_type === "string" ? ` (${error.plan_type.toLowerCase()} plan)` : ""
  const when =
    typeof error?.resets_at === "number"
      ? ` Try again in about ${Math.max(0, Math.floor((error.resets_at * 1000 - Date.now()) / 60_000))} min.`
      : ""
  return `You have hit your ChatGPT usage limit${plan}.${when}`
}

const responseFailure = (error: any) => {
  if (isUsageLimit(error)) return usageLimit(error)
  const code = error?.code ?? error?.type
  const message = typeof error?.message === "string" ? error.message : "no details given"
  return typeof code === "string" ? `the response failed (${code}): ${message}` : `the response failed: ${message}`
}

const httpFailure = (status: number, body: any) => {
  const error = body?.error
  if (isUsageLimit(error) || status === 429) return usageLimit(error)
  if (status === 401) return "ChatGPT turned the sign-in down; sign in again"
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof body?.detail === "string"
        ? body.detail
        : (typeof body === "string" ? body : JSON.stringify(body)).slice(0, LONGEST_ERROR_BODY)
  return `ChatGPT answered ${status}: ${message}`
}

export const openAiDriver = Effect.fnUntraced(function* (options: OpenAiOptions) {
  const signingIn = yield* Semaphore.make(1)

  const refresh = (credentials: Credentials) =>
    Effect.tap(refreshed(credentials, options.authBase), (fresh) => saveCredentials(options.authPath, fresh))

  const signedIn = signingIn.withPermits(1)(
    Effect.flatMap(loadCredentials(options.authPath), (credentials) =>
      isExpired(credentials) ? refresh(credentials) : Effect.succeed(credentials),
    ),
  )

  const refreshedAfterRejection = (rejected: Credentials) =>
    signingIn.withPermits(1)(
      Effect.flatMap(loadCredentials(options.authPath), (saved) =>
        saved.access_token !== rejected.access_token && !isExpired(saved) ? Effect.succeed(saved) : refresh(saved),
      ),
    )

  const post = (turn: Turn, credentials: Credentials, body: unknown, signal: AbortSignal) =>
    Effect.tryPromise({
      try: () =>
        fetch(`${options.baseUrl}/codex/responses`, {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${credentials.access_token}`,
            "chatgpt-account-id": credentials.account_id,
            "OpenAI-Beta": "responses=experimental",
            originator: ORIGINATOR,
            "session-id": turn.conversation.id,
            "x-client-request-id": turn.conversation.id,
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      catch: (error) => failure(`could not reach ChatGPT: ${String(error)}`),
    })

  const read = (turn: Turn, response: Response, signal: AbortSignal) =>
    Effect.gen(function* () {
      const calls: Array<Call> = []
      const stream = events(response.body!, signal)
      while (true) {
        const event: any = yield* Effect.tryPromise({
          try: () => stream.next(),
          catch: (error) => failure(`the response stream broke: ${String(error)}`),
        }).pipe(Effect.map((next) => (next.done ? undefined : next.value)))
        if (event === undefined) return yield* failure("the response stream ended before the response finished")
        const item = event.item
        switch (event.type) {
          case "response.output_text.delta":
          case "response.refusal.delta":
            yield* turn.say(typeof event.delta === "string" ? event.delta : "")
            break
          case "response.output_item.done":
            if (item?.type === "message") {
              const text = messageText(item)
              if (text !== "") yield* turn.message(text)
            } else if (item?.type === "function_call") {
              calls.push(yield* toolCall(item))
            }
            break
          case "response.completed":
          case "response.done":
            return calls
          case "response.incomplete":
            return yield* failure(
              `the response stopped early: ${event.response?.incomplete_details?.reason ?? "no reason given"}`,
            )
          case "response.failed":
            return yield* failure(responseFailure(event.response?.error))
          case "error":
            return yield* failure(responseFailure(typeof event.error === "object" ? event.error : event))
        }
      }
    })

  const respond = (turn: Turn, body: unknown) =>
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      )
      let credentials = yield* signedIn
      let retried = false
      while (true) {
        const response = yield* post(turn, credentials, body, controller.signal)
        if (response.ok) return yield* read(turn, response, controller.signal)
        const text = yield* Effect.promise(() => response.text().catch(() => ""))
        if (response.status === 401 && !retried) {
          credentials = yield* refreshedAfterRejection(credentials)
          retried = true
          continue
        }
        let error: unknown = text
        try {
          error = JSON.parse(text)
        } catch {}
        return yield* failure(httpFailure(response.status, error))
      }
    }).pipe(Effect.scoped)

  const driver: Driver = {
    run: (turn) =>
      Effect.gen(function* () {
        const instructions = `${options.instructions}\nThe working directory is ${turn.conversation.cwd}.\n`
        const tools = turn.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        }))
        while (true) {
          const transcript = yield* turn.transcript
          const calls = yield* respond(turn, {
            model: MODEL,
            instructions,
            input: transcript.map(inputItem).filter((item) => item !== undefined),
            tools,
            tool_choice: "auto",
            parallel_tool_calls: true,
            store: false,
            stream: true,
            prompt_cache_key: turn.conversation.id,
          })
          if (calls.length === 0) return
          for (const call of calls) yield* turn.runTool(call)
          yield* turn.steers
        }
      }),
  }
  return driver
})
