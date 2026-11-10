// pi-ai as the upstream suite imports it, over packages/models. The suite calls pi-ai's Promise API: providers whose
// streams are AssistantMessageEventStreams, and a mutable `Models` collection of them. Each provider here also carries
// the Effect provider it stands for (`SEAM`), so `toSeam` hands a later child the same models behind nisse's seam.
//
// Failures the seam reports as `Unsupported` or `UnknownProvider` come back as pi-ai's `Models` reports them: an error
// message from a stream or a fetch, an error result from `classify` and `generateImages`, a rejection from
// `cancelDeferred`.
import { Cause, Effect, Exit, Fiber, Option, Stream, Tracer } from "effect";
import * as Faux from "../../../models/src/faux.ts";
import * as M from "../../../models/src/index.ts";
import type {
	AnyModel,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEvent,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ClientIdentity,
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
} from "../../../models/src/index.ts";
import { unimplemented } from "../../unimplemented.ts";
import { telemetryOfSpan, underSpan } from "../durable/src/telemetry-bridge.ts";
import { NOOP_TELEMETRY_CONTEXT, type TelemetrySpan } from "../telemetry/src/index.ts";
import { AssistantMessageEventStream, createAssistantMessageEventStream, EventStream } from "./event-stream.ts";

export type * from "../../../models/src/types.ts";
export type { FauxModelDefinition, FauxProviderState, FauxResponseFactory, FauxResponseStep } from "../../../models/src/faux.ts";
export { AssistantMessageEventStream, createAssistantMessageEventStream, EventStream };
export {
	calculateContextTokens,
	declarationsEqual,
	estimateMessageTokens,
	getCurrentTools,
	getSystemMessageText,
	isContextOverflow,
	isModelType,
	isRetryableAssistantError,
	mergeClientIdentity,
	modelType as getModelType,
	normalizeContext,
	PI_ATTRIBUTION,
	retryDelayMs,
	StreamingJsonParser,
	ToolCallArgumentsStream,
	toToolDeclaration,
	uuidv7,
	validateToolArguments,
} from "../../../models/src/index.ts";
export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "../../../models/src/faux.ts";

// Only the excluded e2e tests and the examples, which are not executed, reach real providers.
export const builtinModels = unimplemented("builtinModels", "no child: only excluded e2e tests use it");
export const openaiProvider = unimplemented("openaiProvider", "no child: only excluded e2e tests use it");

const SEAM = Symbol("nisse seam");

export interface ProviderStreams {
	stream(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
	fetchDeferred?(model: Model<string>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream;
	cancelDeferred?(model: Model<string>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}
interface ProviderImages {
	generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
}
interface ProviderClassifier {
	classify(model: ClassifierModel<string>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult>;
}
export interface ProviderAuth {
	apiKey?: { name: string; resolve: (...args: never[]) => Promise<{ auth: Record<string, unknown> } | undefined> };
}

export interface Provider extends ProviderStreams {
	readonly id: string;
	readonly name: string;
	readonly auth: ProviderAuth;
	getModels(): readonly Model<string>[];
	getAllModels(): readonly AnyModel[];
	generateImages?(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
	classify?(model: ClassifierModel<string>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult>;
	readonly [SEAM]: M.Provider;
}

const withoutSignal = <T extends { signal?: AbortSignal }>(options: T | undefined): Omit<T, "signal"> => {
	const { signal: _signal, telemetry: _telemetry, ...rest } = (options ?? {}) as T & { telemetry?: unknown };
	return rest as Omit<T, "signal">;
};

/** The span a pi-ai caller passed as `options.telemetry`; pi-ai starts its request spans under it. */
const telemetryOption = (options: unknown): TelemetrySpan | undefined => {
	const telemetry = (options as { telemetry?: TelemetrySpan } | undefined)?.telemetry;
	return telemetry === undefined || telemetry === NOOP_TELEMETRY_CONTEXT ? undefined : telemetry;
};

const errorMessage = (model: AnyModel, error: unknown, stopReason: "error" | "aborted" = "error"): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason,
	errorMessage: error instanceof Error ? error.message : String(error),
	timestamp: Date.now(),
});

const causeError = (cause: Cause.Cause<unknown>): unknown => Cause.squash(cause);

// Effect stream -> pi-ai stream. An abort interrupts it and ends the stream as pi-ai's providers do: an `aborted`
// error carrying the response so far. A seam failure ends it with an error message.
function toEventStream(
	model: AnyModel,
	stream: Stream.Stream<AssistantMessageEvent, unknown>,
	signal: AbortSignal | undefined,
	telemetry?: TelemetrySpan,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	let partial: AssistantMessage | undefined;
	const run = Stream.runForEach(stream, (event) =>
		Effect.sync(() => {
			if ("partial" in event) partial = event.partial;
			out.push(event);
		}),
	);
	const fiber = Effect.runFork(telemetry === undefined ? run : underSpan(run, telemetry));
	const abort = () => Effect.runFork(Fiber.interrupt(fiber));
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	fiber.addObserver((exit) => {
		signal?.removeEventListener("abort", abort);
		if (Exit.isFailure(exit)) {
			const error = Cause.hasInterruptsOnly(exit.cause)
				? { ...(partial ?? errorMessage(model, "")), stopReason: "aborted" as const, errorMessage: "Request was aborted", timestamp: Date.now() }
				: errorMessage(model, causeError(exit.cause));
			out.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
		}
		out.end();
	});
	return out;
}

// pi-ai stream -> Effect stream. Interrupting it aborts the request.
function fromEventStream(start: (signal: AbortSignal) => AsyncIterable<AssistantMessageEvent>): Stream.Stream<AssistantMessageEvent> {
	return Stream.suspend(() => {
		const controller = new AbortController();
		return Stream.fromAsyncIterable(start(controller.signal), (error) => error).pipe(
			Stream.orDie,
			Stream.onExit((exit) => Effect.sync(() => Exit.isFailure(exit) && controller.abort())),
		);
	});
}

const fromPromise = <A>(start: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> =>
	Effect.tryPromise({ try: start, catch: (error) => error }).pipe(Effect.orDie);

// A provider whose API is pi-ai's Promise streams, as `createProvider` gets it, behind the seam.
function seamOfStreams(input: {
	id: string;
	models: readonly AnyModel[];
	api?: ProviderStreams;
	images?: Record<string, ProviderImages>;
	classifiers?: Record<string, ProviderClassifier>;
}): M.Provider {
	const { api, images, classifiers } = input;
	const lookup = <T>(table: Record<string, T>, model: AnyModel, what: string): T => {
		const implementation = table[model.api];
		if (implementation === undefined) throw new Error(`Provider ${input.id} has no ${what} API "${model.api}"`);
		return implementation;
	};
	return {
		id: input.id,
		models: input.models,
		...(api === undefined
			? {}
			: { streamSimple: (model, context, options) => fromEventStream((signal) => api.streamSimple(model, context, { ...options, signal })) }),
		...(api?.fetchDeferred === undefined
			? {}
			: { fetchDeferred: (model, handle, options) => fromEventStream((signal) => api.fetchDeferred!(model, handle, { ...options, signal })) }),
		...(api?.cancelDeferred === undefined
			? {}
			: { cancelDeferred: (model, handle, options) => fromPromise((signal) => api.cancelDeferred!(model, handle, { ...options, signal })) }),
		...(images === undefined
			? {}
			: {
					generateImages: (model, context, options) =>
						fromPromise((signal) => lookup(images, model, "images").generateImages(model, context, { ...options, signal })),
				}),
		...(classifiers === undefined
			? {}
			: {
					classify: (model, context, options) =>
						fromPromise((signal) => lookup(classifiers, model, "classifier").classify(model, context, { ...options, signal })),
				}),
	} satisfies M.Provider;
}

// A seam provider, such as the faux one, as a pi-ai provider.
function providerOfSeam(seam: M.Provider, extra: { name: string; auth: ProviderAuth }): Provider {
	const stream = (model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) =>
		seam.streamSimple === undefined
			? toEventStream(model, Stream.fail(new M.Unsupported({ method: "streamSimple", provider: seam.id })), undefined)
			: toEventStream(model, seam.streamSimple(model, context, withoutSignal(options)), options?.signal);
	return {
		id: seam.id,
		...extra,
		getModels: () => seam.models.filter((model): model is Model<string> => M.isModelType(model, "chat")),
		getAllModels: () => seam.models,
		stream,
		streamSimple: stream,
		...(seam.fetchDeferred === undefined
			? {}
			: { fetchDeferred: (model, handle, options) => toEventStream(model, seam.fetchDeferred!(model, handle, withoutSignal(options)), options?.signal) }),
		...(seam.cancelDeferred === undefined
			? {}
			: { cancelDeferred: (model, handle, options) => Effect.runPromise(seam.cancelDeferred!(model, handle, withoutSignal(options))) }),
		[SEAM]: seam,
	};
}

export function createProvider(input: {
	id: string;
	name?: string;
	auth: ProviderAuth;
	models: readonly AnyModel[];
	api?: ProviderStreams;
	images?: Record<string, ProviderImages>;
	classifiers?: Record<string, ProviderClassifier>;
}): Provider {
	const seam = seamOfStreams(input);
	const missing = (model: Model<string>) =>
		toEventStream(model, Stream.fail(new Error(`Provider ${input.id} has no API implementation for "${model.api}"`)), undefined);
	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => input.models.filter((model): model is Model<string> => M.isModelType(model, "chat")),
		getAllModels: () => input.models,
		stream: (model, context, options) => input.api?.stream(model, context, options) ?? missing(model),
		streamSimple: (model, context, options) => input.api?.streamSimple(model, context, options) ?? missing(model),
		...(input.api?.fetchDeferred === undefined ? {} : { fetchDeferred: input.api.fetchDeferred.bind(input.api) }),
		...(input.api?.cancelDeferred === undefined ? {} : { cancelDeferred: input.api.cancelDeferred.bind(input.api) }),
		...(seam.generateImages === undefined
			? {}
			: { generateImages: (model, context, options) => Effect.runPromise(seam.generateImages!(model, context, withoutSignal(options))) }),
		...(seam.classify === undefined
			? {}
			: { classify: (model, context, options) => Effect.runPromise(seam.classify!(model, context, withoutSignal(options))) }),
		[SEAM]: seam,
	};
}

export interface FauxProviderHandle extends Omit<Faux.Faux, "provider"> {
	provider: Provider;
}

export function fauxProvider(options: Faux.FauxOptions = {}): FauxProviderHandle {
	const faux = Faux.fauxProvider(options);
	return {
		...faux,
		provider: providerOfSeam(faux.provider, { name: "Faux", auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } } }),
	};
}

export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;
	getModels(provider?: string): readonly Model<string>[];
	getModel(provider: string, id: string): Model<string> | undefined;
	getModelsOfType<T extends ModelType>(type: T, provider?: string): readonly ModelTypeMap[T][];
	getModelOfType<T extends ModelType>(type: T, provider: string, id: string): ModelTypeMap[T] | undefined;
	getAllModels(provider?: string): readonly AnyModel[];
	getAvailableOfType<T extends ModelType>(type: T, provider?: string, options?: unknown): Promise<readonly ModelTypeMap[T][]>;
	stream(model: Model<string>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	complete(model: Model<string>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
	streamSimple(model: Model<string>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<string>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
	streamDeferred(model: Model<string>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream;
	fetchDeferred(model: Model<string>, handle: DeferredHandle, options?: DeferredFetchOptions): Promise<AssistantMessage>;
	cancelDeferred(model: Model<string>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
	generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
	classify(model: ClassifierModel<string>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult>;
	readonly [SEAM]: M.Models;
}

export interface MutableModels extends Models {
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

/** The seam behind a `Models` this module made. It follows later `setProvider` calls. */
export function toSeam(models: Models): M.Models {
	return models[SEAM];
}

/**
 * nisse's seam over any pi-ai `Models`, through its Promise methods: a suite that wraps one, as a Proxy overriding
 * `streamSimple`, is heard. Interruption aborts the request's signal.
 */
export function promiseSeam(models: Models): M.Models {
	const known = seams.get(models);
	if (known !== undefined) return known;
	const seam = makePromiseSeam(models);
	seams.set(models, seam);
	owners.set(seam, models);
	return seam;
}

const seams = new WeakMap<Models, M.Models>();
const owners = new WeakMap<M.Models, Models>();

/** The pi-ai `Models` behind a seam `promiseSeam` made; any other seam, such as one with an identity applied, as pi-ai's facade over it. */
export function promiseModels(seam: M.Models): Models {
	const known = owners.get(seam);
	if (known !== undefined) return known;
	// A wrapper that spreads a promise seam, as an identity does, keeps its `HOST` and so the host's providers.
	const host = (seam as { [HOST]?: Models })[HOST];
	const made = facade(seam, () => host?.getProviders() ?? []);
	owners.set(seam, made);
	return made;
}

/** The pi-ai `Models` a promise seam calls, kept on the seam itself. */
const HOST = Symbol("pi-ai host models");

function makePromiseSeam(models: Models): M.Models {
	const request = <A>(call: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, never> =>
		Effect.orDie(
			Effect.tryPromise({ try: (signal) => Promise.resolve(call(signal)), catch: (error) => error }),
		);
	const seam: M.Models & { [HOST]: Models } = {
		[HOST]: models,
		getModel: (provider, id) => models.getModel(provider, id) as Model<M.Api> | undefined,
		getModelsOfType: (type, provider) => models.getModelsOfType(type, provider),
		getModelOfType: (type, provider, id) => models.getModelOfType(type, provider, id),
		getAvailableOfType: (type, provider) => request(() => models.getAvailableOfType(type, provider)),
		streamSimple: (model, context, options) =>
			Stream.unwrap(
				Effect.map(Effect.serviceOption(Tracer.ParentSpan), (parent) => {
					const controller = new AbortController();
					// pi-ai starts its request span under the caller's span, which it reads as `options.telemetry`.
					const telemetry = telemetryOfSpan(Option.getOrUndefined(parent));
					const events = models.streamSimple(model, context as Context, {
						...options,
						signal: controller.signal,
						...(telemetry === undefined ? {} : { telemetry }),
					} as SimpleStreamOptions);
					// pi-ai's `result()` is the final message; a stream that never yields its terminal event ends with it.
					let ended = false;
					const terminal = Stream.unwrap(
						Effect.map(
							Effect.tryPromise({ try: () => events.result(), catch: (error) => error }),
							(message): Stream.Stream<AssistantMessageEvent> =>
								ended
									? Stream.empty
									: Stream.make(
											message.stopReason === "error" || message.stopReason === "aborted"
												? { type: "error", reason: message.stopReason, error: message }
												: { type: "done", reason: message.stopReason as "stop", message },
										),
						),
					);
					return Stream.fromAsyncIterable(events, (error) => error).pipe(
						Stream.tap((event) =>
							Effect.sync(() => {
								if (event.type === "done" || event.type === "error") ended = true;
							}),
						),
						Stream.concat(terminal),
						Stream.orDie,
						Stream.ensuring(Effect.sync(() => controller.abort())),
					);
				}),
			),
		completeSimple: (model, context, options) =>
			request((signal) => models.completeSimple(model, context as Context, { ...options, signal })),
		fetchDeferred: (model, handle, options) => request((signal) => models.fetchDeferred(model, handle, { ...options, signal })),
		cancelDeferred: (model, handle, options) => request((signal) => models.cancelDeferred(model, handle, { ...options, signal })),
		classify: (model, context, options) => request((signal) => models.classify(model, context, { ...options, signal })),
		generateImages: (model, context, options) =>
			request((signal) => models.generateImages(model, context, { ...options, signal })),
	};
	return seam;
}

// The pi-ai facade over a seam. `providers` lists the pi-ai providers the seam was built from.
function facade(seam: M.Models, providers: () => readonly Provider[]): Models {
	const all = (id?: string) => (id === undefined ? providers() : providers().filter((p) => p.id === id)).flatMap((p) => p.getAllModels());
	const ofType = <T extends ModelType>(models: readonly AnyModel[], type: T) => models.filter((m): m is ModelTypeMap[T] => M.isModelType(m, type));
	// Runs a request under the caller's signal: an abort interrupts it, and ends it as pi-ai's `Models` does.
	const settled = async <A>(
		effect: Effect.Effect<A, unknown>,
		signal: AbortSignal | undefined,
		onFailure: (error: unknown, stopReason: "error" | "aborted") => A,
	): Promise<A> => {
		if (signal?.aborted) return onFailure(new Error("Request was aborted"), "aborted");
		const exit = await Effect.runPromiseExit(effect, signal === undefined ? {} : { signal });
		if (Exit.isSuccess(exit)) return exit.value;
		return Cause.hasInterruptsOnly(exit.cause) ? onFailure(new Error("Request was aborted"), "aborted") : onFailure(causeError(exit.cause), "error");
	};
	const streamSimple = (model: Model<string>, context: Context, options?: SimpleStreamOptions) =>
		toEventStream(
			model,
			seam.streamSimple(model, context, withoutSignal(options)),
			options?.signal,
			telemetryOption(options),
		);
	const fetchDeferred = (model: Model<string>, handle: DeferredHandle, options?: DeferredFetchOptions) =>
		settled(seam.fetchDeferred(model, handle, withoutSignal(options)), options?.signal, (error, stopReason) => errorMessage(model, error, stopReason));
	return {
		getProviders: providers,
		getProvider: (id) => providers().find((p) => p.id === id),
		getModels: (provider) => ofType(all(provider), "chat"),
		getModel: (provider, id) => ofType(all(provider), "chat").find((m) => m.id === id),
		getModelsOfType: (type, provider) => ofType(all(provider), type),
		getModelOfType: (type, provider, id) => ofType(all(provider), type).find((m) => m.id === id),
		getAllModels: (provider) => all(provider),
		getAvailableOfType: (type, provider) => Effect.runPromise(seam.getAvailableOfType(type, provider)),
		stream: streamSimple,
		complete: (model, context, options) => streamSimple(model, context, options).result(),
		streamSimple,
		completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
		streamDeferred: (model, handle, options) => {
			const out = createAssistantMessageEventStream();
			void fetchDeferred(model, handle, options).then((message) => {
				out.push(message.stopReason === "error" || message.stopReason === "aborted"
					? { type: "error", reason: message.stopReason, error: message }
					: { type: "done", reason: message.stopReason as "stop", message });
				out.end();
			});
			return out;
		},
		fetchDeferred,
		cancelDeferred: (model, handle, options) =>
			Effect.runPromise(seam.cancelDeferred(model, handle, withoutSignal(options)), options?.signal === undefined ? {} : { signal: options.signal }),
		generateImages: (model, context, options) =>
			settled(seam.generateImages(model, context, withoutSignal(options)), options?.signal, (error, stopReason) => ({
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason,
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			})),
		classify: (model, context, options) =>
			settled(seam.classify(model, context, withoutSignal(options)), options?.signal, (error, stopReason) => ({
				api: model.api,
				provider: model.provider,
				model: model.id,
				answers: {},
				stopReason,
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			})),
		[SEAM]: seam,
	};
}

// A seam whose every call reads the providers as they are now, so `setProvider` after `toSeam` still counts.
function liveSeam(current: () => M.Models): M.Models {
	return {
		getModel: (provider, id) => current().getModel(provider, id),
		getModelsOfType: (type, provider) => current().getModelsOfType(type, provider),
		getModelOfType: (type, provider, id) => current().getModelOfType(type, provider, id),
		getAvailableOfType: (type, provider) => Effect.suspend(() => current().getAvailableOfType(type, provider)),
		streamSimple: (model, context, options) => Stream.suspend(() => current().streamSimple(model, context, options)),
		completeSimple: (model, context, options) => Effect.suspend(() => current().completeSimple(model, context, options)),
		fetchDeferred: (model, handle, options) => Effect.suspend(() => current().fetchDeferred(model, handle, options)),
		cancelDeferred: (model, handle, options) => Effect.suspend(() => current().cancelDeferred(model, handle, options)),
		classify: (model, context, options) => Effect.suspend(() => current().classify(model, context, options)),
		generateImages: (model, context, options) => Effect.suspend(() => current().generateImages(model, context, options)),
	};
}

export function createModels(options: { identity?: ClientIdentity } = {}): MutableModels {
	const providers = new Map<string, Provider>();
	const list = () => [...providers.values()];
	const seam = liveSeam(() => M.fromProviders(list().map((p) => p[SEAM]), options.identity === undefined ? {} : { identity: options.identity }));
	return {
		...facade(seam, list),
		setProvider: (provider) => void providers.set(provider.id, provider),
		deleteProvider: (id) => void providers.delete(id),
		clearProviders: () => providers.clear(),
	};
}

export function withClientIdentity(models: MutableModels, identity: ClientIdentity): MutableModels;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models {
	const wrapped = facade(M.withClientIdentity(models[SEAM], identity), () => models.getProviders());
	if (!("setProvider" in models)) return wrapped;
	const mutable = models as MutableModels;
	return { ...wrapped, setProvider: mutable.setProvider, deleteProvider: mutable.deleteProvider, clearProviders: mutable.clearProviders } as MutableModels;
}
