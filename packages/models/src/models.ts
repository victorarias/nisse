// The Models seam: everything the harness asks of a model, with pi-ai's call surface on Effect. A provider implements
// what it can; the seam answers the rest with `Unsupported`, naming the method and the provider.
//
// Cancellation is interruption: a stream that is interrupted emits nothing more, and the consumer keeps the partial it
// saw. A provider's own failures (an HTTP error, a refused request, an overflow) are not Effect failures: they are the
// stream's final `error` event, an `AssistantMessage` with `stopReason: "error"`, because the harness stores that message
// and classifies it with `isRetryableAssistantError` and `isContextOverflow`. Effect failures are only the seam's own:
// a method the provider lacks, or a model whose provider is not in this `Models`.
import { Clock, Effect, Schema, Stream } from "effect"
import { mergeClientIdentity, type ClientIdentity } from "./identity.ts"
import { normalizeContext } from "./transcript.ts"
import type {
  AnyModel,
  Api,
  AssistantImages,
  AssistantMessage,
  AssistantMessageEvent,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
  Context,
  DeferredCancelOptions,
  DeferredFetchOptions,
  DeferredHandle,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  Model,
  ModelType,
  ModelTypeMap,
  SimpleStreamOptions,
  TranscriptContext,
} from "./types.ts"

/** The methods a provider may lack. The lookups and `getAvailableOfType` read the models every provider lists. */
export type Method = "streamSimple" | "fetchDeferred" | "cancelDeferred" | "classify" | "generateImages"

export class Unsupported extends Schema.TaggedError<Unsupported>()("Unsupported", {
  method: Schema.Literals(["streamSimple", "fetchDeferred", "cancelDeferred", "classify", "generateImages"]),
  provider: Schema.String,
}) {
  override get message() {
    return `provider ${this.provider} does not support ${this.method}`
  }
}

export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  provider: Schema.String,
}) {
  override get message() {
    return `no provider ${this.provider} in these models`
  }
}

export type ModelsError = Unsupported | UnknownProvider

// Cancellation is interruption, so requests carry no AbortSignal.
export type RequestOptions = Omit<SimpleStreamOptions, "signal">
export type FetchOptions = Omit<DeferredFetchOptions, "signal">
export type CancelOptions = Omit<DeferredCancelOptions, "signal">
export type ClassifyOptions = Omit<ClassifierOptions, "signal">
export type ImageOptions = Omit<ImagesOptions, "signal">

export interface Models {
  getModel(provider: string, id: string): Model<Api> | undefined
  getModelsOfType<T extends ModelType>(type: T, provider?: string): readonly ModelTypeMap[T][]
  getModelOfType<T extends ModelType>(type: T, provider: string, id: string): ModelTypeMap[T] | undefined
  /** The models of a type a provider can serve now, such as the ones its sign-in reaches. */
  getAvailableOfType<T extends ModelType>(type: T, provider?: string): Effect.Effect<readonly ModelTypeMap[T][]>
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: RequestOptions,
  ): Stream.Stream<AssistantMessageEvent, ModelsError>
  /** The final message of `streamSimple`: its `done` message, or its `error` message. */
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: RequestOptions,
  ): Effect.Effect<AssistantMessage, ModelsError>
  /** Asks once for a deferred response. A response not ready yet is a message with `stopReason: "deferred"`. */
  fetchDeferred(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: FetchOptions,
  ): Effect.Effect<AssistantMessage, ModelsError>
  cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: CancelOptions): Effect.Effect<void, ModelsError>
  classify(
    model: ClassifierModel<string>,
    context: ClassifierContext,
    options?: ClassifyOptions,
  ): Effect.Effect<ClassifierResult, ModelsError>
  generateImages(
    model: ImageModel<string>,
    context: ImagesContext,
    options?: ImageOptions,
  ): Effect.Effect<AssistantImages, ModelsError>
}

/**
 * One provider behind the seam. Streams end with a `done` or an `error` event and do not fail; a method left out is
 * `Unsupported`. `available` defaults to every model.
 */
export interface Provider {
  readonly id: string
  readonly models: readonly AnyModel[]
  readonly available?: Effect.Effect<readonly AnyModel[]>
  readonly streamSimple?: (
    model: Model<Api>,
    context: TranscriptContext,
    options: RequestOptions,
  ) => Stream.Stream<AssistantMessageEvent>
  readonly fetchDeferred?: (
    model: Model<Api>,
    handle: DeferredHandle,
    options: FetchOptions,
  ) => Stream.Stream<AssistantMessageEvent>
  readonly cancelDeferred?: (model: Model<Api>, handle: DeferredHandle, options: CancelOptions) => Effect.Effect<void>
  readonly classify?: (
    model: ClassifierModel<string>,
    context: ClassifierContext,
    options: ClassifyOptions,
  ) => Effect.Effect<ClassifierResult>
  readonly generateImages?: (
    model: ImageModel<string>,
    context: ImagesContext,
    options: ImageOptions,
  ) => Effect.Effect<AssistantImages>
}

export const modelType = (model: AnyModel): ModelType => model.type ?? "chat"

export const isModelType = <T extends ModelType>(model: AnyModel, type: T): model is ModelTypeMap[T] =>
  modelType(model) === type

const finalMessage = (event: AssistantMessageEvent): AssistantMessage | undefined =>
  event.type === "done" ? event.message : event.type === "error" ? event.error : undefined

/** The final message of a provider stream. A stream that ends without one breaks the provider contract. */
export const lastMessage = <E>(
  stream: Stream.Stream<AssistantMessageEvent, E>,
  provider: string,
): Effect.Effect<AssistantMessage, E> =>
  stream.pipe(
    Stream.runFold(
      () => undefined as AssistantMessage | undefined,
      (last, event) => finalMessage(event) ?? last,
    ),
    Effect.flatMap((message) =>
      message === undefined
        ? Effect.die(new Error(`provider ${provider} ended a stream without a done or error event`))
        : Effect.succeed(message),
    ),
  )

// Sets `durationMs` on the final message of a response that started now, as pi-ai's event stream does: from the
// request until its final event, on the monotonic clock. A message that already has one, or that predates the
// request (a scripted message replayed with an old timestamp), keeps what it has.
const timed = (stream: Stream.Stream<AssistantMessageEvent>): Stream.Stream<AssistantMessageEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const started = yield* Clock.currentTimeNanos
      const time = (message: AssistantMessage) =>
        Effect.map(Clock.currentTimeNanos, (now): AssistantMessage => {
          if (message.durationMs !== undefined || message.timestamp < startedAt) return message
          return { ...message, durationMs: Math.max(0, Math.round(Number(now - started) / 1e6)) }
        })
      return Stream.mapEffect(stream, (event): Effect.Effect<AssistantMessageEvent> => {
        if (event.type === "done") return Effect.map(time(event.message), (message) => ({ ...event, message }))
        if (event.type === "error") return Effect.map(time(event.error), (error) => ({ ...event, error }))
        return Effect.succeed(event)
      })
    }),
  )

/**
 * The seam over a set of providers, each serving the models it lists. A request goes to its model's provider.
 * `identity` is the default identity of every request; a request's own merges over it.
 */
export function fromProviders(providers: Iterable<Provider>, options: { identity?: ClientIdentity } = {}): Models {
  const byId = new Map<string, Provider>()
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`two providers named ${provider.id}`)
    byId.set(provider.id, provider)
  }
  const all = (provider?: string): readonly AnyModel[] =>
    provider === undefined ? [...byId.values()].flatMap((entry) => entry.models) : (byId.get(provider)?.models ?? [])
  const ofType = <T extends ModelType>(models: readonly AnyModel[], type: T) =>
    models.filter((model): model is ModelTypeMap[T] => isModelType(model, type))
  const route = <K extends Method>(
    model: AnyModel,
    method: K,
  ): Effect.Effect<NonNullable<Provider[K]>, ModelsError> => {
    const provider = byId.get(model.provider)
    if (provider === undefined) return Effect.fail(new UnknownProvider({ provider: model.provider }))
    const implementation = provider[method]
    if (implementation === undefined) return Effect.fail(new Unsupported({ method, provider: provider.id }))
    return Effect.succeed(implementation as NonNullable<Provider[K]>)
  }
  const withIdentity = <T extends { identity?: ClientIdentity }>(request: T | undefined): T => {
    const identity = mergeClientIdentity(options.identity, request?.identity)
    return { ...request, ...(identity === undefined ? {} : { identity }) } as T
  }
  const streamSimple: Models["streamSimple"] = (model, context, request) =>
    Stream.unwrap(
      Effect.map(route(model, "streamSimple"), (stream) =>
        timed(stream(model, normalizeContext(context), withIdentity(request))),
      ),
    )
  return {
    getModel: (provider, id) => ofType(all(provider), "chat").find((model) => model.id === id),
    getModelsOfType: (type, provider) => ofType(all(provider), type),
    getModelOfType: (type, provider, id) => ofType(all(provider), type).find((model) => model.id === id),
    getAvailableOfType: (type, provider) =>
      Effect.map(
        Effect.forEach(
          provider === undefined ? [...byId.values()] : [...(byId.has(provider) ? [byId.get(provider)!] : [])],
          (entry) => entry.available ?? Effect.succeed(entry.models),
        ),
        (lists) => ofType(lists.flat(), type),
      ),
    streamSimple,
    completeSimple: (model, context, request) => lastMessage(streamSimple(model, context, request), model.provider),
    fetchDeferred: (model, handle, request) =>
      Effect.flatMap(route(model, "fetchDeferred"), (fetch) =>
        lastMessage(fetch(model, handle, withIdentity(request)), model.provider),
      ),
    cancelDeferred: (model, handle, request) =>
      Effect.flatMap(route(model, "cancelDeferred"), (cancel) => cancel(model, handle, withIdentity(request))),
    classify: (model, context, request) =>
      Effect.flatMap(route(model, "classify"), (classify) => classify(model, context, withIdentity(request))),
    generateImages: (model, context, request) =>
      Effect.flatMap(route(model, "generateImages"), (generate) => generate(model, context, withIdentity(request))),
  }
}
