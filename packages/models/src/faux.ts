// The faux provider: a scripted model for tests, behind the seam. A port of pi-ai's `src/providers/faux.ts` in
// earendil-works/pi at commit 7d073328e (MIT, see LICENSE) onto Effect, with the same observable behavior: scripted
// responses taken one per request, deferred handles that stay pending for a set number of fetches, pacing by tokens
// per second, and usage estimated from the prompt with a simulated prompt cache per `sessionId`.
import { Duration, Effect, Stream } from "effect"
import type { Provider, RequestOptions } from "./models.ts"
import { failure, replay, type Pacing } from "./replay.ts"
import { getSystemMessageText } from "./text.ts"
import type {
  AssistantMessage,
  AssistantMessageEvent,
  DeferredHandle,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
  Usage,
} from "./types.ts"

const DEFAULT_API = "faux"
const DEFAULT_PROVIDER = "faux"
const DEFAULT_MODEL_ID = "faux-1"
const DEFAULT_MODEL_NAME = "Faux Model"
const DEFAULT_BASE_URL = "http://localhost:0"
const DEFAULT_MIN_TOKEN_SIZE = 3
const DEFAULT_MAX_TOKEN_SIZE = 5

const DEFAULT_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export interface FauxModelDefinition {
  id: string
  name?: string
  reasoning?: boolean
  input?: ("text" | "image")[]
  inputLimits?: Model<string>["inputLimits"]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow?: number
  maxTokens?: number
}

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall

export function fauxText(text: string): TextContent {
  return { type: "text", text }
}

export function fauxThinking(thinking: string): ThinkingContent {
  return { type: "thinking", thinking }
}

export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
  return { type: "toolCall", id: options.id ?? randomId("tool"), name, arguments: arguments_ }
}

export function fauxAssistantMessage(
  content: string | FauxContentBlock | FauxContentBlock[],
  options: {
    stopReason?: AssistantMessage["stopReason"]
    deferred?: DeferredHandle
    errorMessage?: string
    responseId?: string
    timestamp?: number
  } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: typeof content === "string" ? [fauxText(content)] : Array.isArray(content) ? content : [content],
    api: DEFAULT_API,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL_ID,
    usage: DEFAULT_USAGE,
    stopReason: options.stopReason ?? "stop",
    ...(options.deferred === undefined ? {} : { deferred: options.deferred }),
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    ...(options.responseId === undefined ? {} : { responseId: options.responseId }),
    timestamp: options.timestamp ?? Date.now(),
  }
}

export interface FauxProviderState {
  callCount: number
  deferredFetchCount: number
  cancelledDeferred: DeferredHandle[]
}

/** Computes a response from the request. May return a Promise or an Effect; a failure becomes an error message. */
export type FauxResponseFactory = (
  context: TranscriptContext,
  options: RequestOptions | undefined,
  state: FauxProviderState,
  model: Model<string>,
) => AssistantMessage | PromiseLike<AssistantMessage> | Effect.Effect<AssistantMessage, unknown>

export type FauxResponseStep = AssistantMessage | FauxResponseFactory

export interface FauxOptions {
  api?: string
  provider?: string
  models?: FauxModelDefinition[]
  deferred?: {
    /** Number of fetches that return the original handle before the scripted response becomes ready. */
    pendingFetches?: number
    pollAfterMs?: number
  }
  tokensPerSecond?: number
  tokenSize?: { min?: number; max?: number }
}

export interface Faux {
  provider: Provider
  api: string
  models: [Model<string>, ...Model<string>[]]
  getModel(): Model<string>
  getModel(modelId: string): Model<string> | undefined
  state: FauxProviderState
  setResponses: (responses: FauxResponseStep[]) => void
  appendResponses: (responses: FauxResponseStep[]) => void
  getPendingResponseCount: () => number
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function randomId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function contentToText(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === "string") return content
  return content
    .map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}:${block.data.length}]`))
    .join("\n")
}

function assistantContentToText(content: Array<TextContent | ThinkingContent | ToolCall>): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text
      if (block.type === "thinking") return block.thinking
      return `${block.name}:${JSON.stringify(block.arguments)}`
    })
    .join("\n")
}

function toolResultToText(message: ToolResultMessage): string {
  return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n")
}

function messageToText(message: Message): string {
  if (message.role === "system") {
    return [
      getSystemMessageText(message),
      ...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
      ...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
    ]
      .filter((part) => part.length > 0)
      .join("\n")
  }
  if (message.role === "user") return contentToText(message.content)
  if (message.role === "assistant") return assistantContentToText(message.content)
  return toolResultToText(message)
}

/** Length of the prompt text that joins `messages` with blank lines. */
function joinedLength(messages: readonly string[], count = messages.length): number {
  let length = count > 0 ? (count - 1) * 2 : 0
  for (let index = 0; index < count; index++) length += messages[index]!.length
  return length
}

/**
 * Length of the common prefix of the two joined prompts. Equal messages are compared whole; characters are compared
 * only from the first message that differs.
 */
function commonPromptPrefixLength(previous: readonly string[], current: readonly string[]): number {
  let index = 0
  while (index < previous.length && index < current.length && previous[index] === current[index]) index++
  const rest = (messages: readonly string[]) =>
    index === messages.length ? "" : (index > 0 ? "\n\n" : "") + messages.slice(index).join("\n\n")
  return joinedLength(previous, index) + commonPrefixLength(rest(previous), rest(current))
}

function commonPrefixLength(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  let index = 0
  while (index < length && a[index] === b[index]) index++
  return index
}

function withUsageEstimate(
  message: AssistantMessage,
  context: TranscriptContext,
  options: RequestOptions | undefined,
  promptCache: Map<string, readonly string[]>,
): AssistantMessage {
  // One text per message; the whole prompt joins them with blank lines.
  const prompt = context.messages.map((entry) => `${entry.role}:${messageToText(entry)}`)
  const promptTokens = Math.ceil(joinedLength(prompt) / 4)
  const outputTokens = estimateTokens(assistantContentToText(message.content))
  let input = promptTokens
  let cacheRead = 0
  let cacheWrite = 0
  const sessionId = options?.sessionId
  if (sessionId && options?.cacheRetention !== "none") {
    const previousPrompt = promptCache.get(sessionId)
    if (previousPrompt) {
      cacheRead = Math.ceil(commonPromptPrefixLength(previousPrompt, prompt) / 4)
      cacheWrite = Math.max(0, promptTokens - cacheRead)
    } else {
      cacheWrite = promptTokens
    }
    // Every prompt token is either read from or written to the simulated cache.
    input = 0
    promptCache.set(sessionId, prompt)
  }
  return {
    ...message,
    usage: {
      input,
      output: outputTokens,
      cacheRead,
      cacheWrite,
      totalTokens: input + outputTokens + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

function splitByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
  const chunks: string[] = []
  let index = 0
  while (index < text.length) {
    const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1))
    const charSize = Math.max(1, tokenSize * 4)
    chunks.push(text.slice(index, index + charSize))
    index += charSize
  }
  return chunks.length > 0 ? chunks : [""]
}

function cloneMessage(message: AssistantMessage, api: string, provider: string, modelId: string): AssistantMessage {
  const cloned = structuredClone(message)
  return {
    ...cloned,
    api,
    provider,
    model: modelId,
    timestamp: cloned.timestamp ?? Date.now(),
    usage: cloned.usage ?? DEFAULT_USAGE,
  }
}

function deferredMessage(model: Model<string>, handle: DeferredHandle): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: DEFAULT_USAGE,
    stopReason: "deferred",
    deferred: handle,
    timestamp: Date.now(),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface DeferredEntry {
  handle: DeferredHandle
  step: FauxResponseStep
  context: TranscriptContext
  options: RequestOptions
  model: Model<string>
  pendingFetches: number
  cancelled: boolean
  final?: AssistantMessage
}

export function fauxProvider(options: FauxOptions = {}): Faux {
  const api = options.api ?? randomId(DEFAULT_API)
  const provider = options.provider ?? DEFAULT_PROVIDER
  const minTokenSize = Math.max(
    1,
    Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
  )
  const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE)
  const tokensPerSecond = options.tokensPerSecond
  let pendingResponses: FauxResponseStep[] = []
  const state: FauxProviderState = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] }
  const promptCache = new Map<string, readonly string[]>()
  const deferredResponses = new Map<string, DeferredEntry>()

  const definitions: FauxModelDefinition[] = options.models?.length
    ? options.models
    : [
        {
          id: DEFAULT_MODEL_ID,
          name: DEFAULT_MODEL_NAME,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ]
  const models = definitions.map(
    (definition): Model<string> => ({
      id: definition.id,
      name: definition.name ?? definition.id,
      api,
      provider,
      baseUrl: DEFAULT_BASE_URL,
      reasoning: definition.reasoning ?? false,
      input: definition.input ?? ["text", "image"],
      ...(definition.inputLimits === undefined ? {} : { inputLimits: definition.inputLimits }),
      cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: definition.contextWindow ?? 128000,
      maxTokens: definition.maxTokens ?? 16384,
    }),
  ) as [Model<string>, ...Model<string>[]]

  const pacing: Pacing = {
    split: (text) => splitByTokenSize(text, minTokenSize, maxTokenSize),
    pause: (chunk) =>
      tokensPerSecond !== undefined && tokensPerSecond > 0
        ? Effect.sleep(Duration.millis((estimateTokens(chunk) / tokensPerSecond) * 1000))
        : Effect.yieldNow,
  }

  const fail = (model: Model<string>, error: unknown) =>
    failure(cloneMessage(fauxAssistantMessage([]), api, provider, model.id), errorText(error))

  const errorStream = (message: AssistantMessage): Stream.Stream<AssistantMessageEvent> =>
    Stream.make({ type: "error", reason: "error", error: message })

  const respond = (
    step: FauxResponseStep,
    context: TranscriptContext,
    streamOptions: RequestOptions,
    model: Model<string>,
  ): Effect.Effect<AssistantMessage, unknown> =>
    Effect.map(
      typeof step !== "function"
        ? Effect.succeed(step)
        : Effect.flatMap(
            Effect.try({ try: () => step(context, streamOptions, state, model), catch: (error) => error }),
            (result) =>
              Effect.isEffect(result)
                ? result
                : Effect.tryPromise({ try: async () => result, catch: (error) => error }),
          ),
      (message) =>
        withUsageEstimate(cloneMessage(message, api, provider, model.id), context, streamOptions, promptCache),
    )

  const responded = (model: Model<string>, onResponse: RequestOptions["onResponse"]) =>
    onResponse === undefined
      ? Effect.void
      : Effect.tryPromise({ try: async () => onResponse({ status: 200, headers: {} }, model), catch: (error) => error })

  const streamSimple: NonNullable<Provider["streamSimple"]> = (model, context, streamOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const step = pendingResponses.shift()
        state.callCount++
        yield* responded(model, streamOptions.onResponse)
        if (step === undefined) {
          const message = withUsageEstimate(
            fail(model, "No more faux responses queued"),
            context,
            streamOptions,
            promptCache,
          )
          return errorStream(message)
        }
        if (streamOptions.deferred) {
          const handle: DeferredHandle = {
            provider: model.provider,
            modelId: model.id,
            api: model.api,
            id: randomId("deferred"),
            ...(options.deferred?.pollAfterMs !== undefined ? { pollAfterMs: options.deferred.pollAfterMs } : {}),
          }
          deferredResponses.set(handle.id, {
            handle,
            step,
            context,
            options: streamOptions,
            model,
            pendingFetches: Math.max(0, Math.floor(options.deferred?.pendingFetches ?? 0)),
            cancelled: false,
          })
          return replay(deferredMessage(model, handle), pacing)
        }
        return replay(yield* respond(step, context, streamOptions, model), pacing)
      }).pipe(Effect.catch((error) => Effect.succeed(errorStream(fail(model, error))))),
    )

  const fetchDeferred: NonNullable<Provider["fetchDeferred"]> = (model, handle, fetchOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        state.deferredFetchCount++
        yield* responded(model, fetchOptions.onResponse)
        const entry = deferredResponses.get(handle.id)
        if (
          entry === undefined ||
          entry.handle.provider !== handle.provider ||
          entry.handle.modelId !== handle.modelId ||
          entry.handle.api !== handle.api
        ) {
          return yield* Effect.fail(new Error(`Unknown faux deferred response: ${handle.id}`))
        }
        if (entry.cancelled) return yield* Effect.fail(new Error(`Faux deferred response was cancelled: ${handle.id}`))
        if (entry.pendingFetches > 0) {
          entry.pendingFetches--
          return replay(deferredMessage(model, entry.handle), pacing)
        }
        if (entry.final === undefined) {
          const { deferred: _deferred, onResponse: _onResponse, ...submission } = entry.options
          entry.final = yield* respond(entry.step, entry.context, submission, entry.model).pipe(
            Effect.catch((error) => Effect.succeed(fail(entry.model, error))),
          )
        }
        return replay(entry.final, pacing)
      }).pipe(Effect.catch((error) => Effect.succeed(errorStream(fail(model, error))))),
    )

  const cancelDeferred: NonNullable<Provider["cancelDeferred"]> = (model, handle, cancelOptions) =>
    Effect.suspend(() => {
      state.cancelledDeferred.push(structuredClone(handle))
      const entry = deferredResponses.get(handle.id)
      if (entry !== undefined) entry.cancelled = true
      return responded(model, cancelOptions.onResponse)
    }).pipe(Effect.orDie)

  function getModel(): Model<string>
  function getModel(modelId: string): Model<string> | undefined
  function getModel(modelId?: string): Model<string> | undefined {
    return modelId === undefined ? models[0] : models.find((candidate) => candidate.id === modelId)
  }

  return {
    provider: { id: provider, models, streamSimple, fetchDeferred, cancelDeferred },
    api,
    models,
    getModel,
    state,
    setResponses: (responses) => {
      pendingResponses = [...responses]
    },
    appendResponses: (responses) => {
      pendingResponses.push(...responses)
    },
    getPendingResponseCount: () => pendingResponses.length,
  }
}
