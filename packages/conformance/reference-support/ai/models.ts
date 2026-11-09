// Stand-in for pi-ai's Models surface as durable consumes it. Hand-written; no auth, no real providers.
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
	StreamOptions,
	TranscriptContext,
} from "./types.ts";
import { normalizeContext } from "./utils.ts";

export class EventStream<T, R = T> implements AsyncIterable<T> {
	#queue: T[] = [];
	#waiting: ((value: IteratorResult<T>) => void)[] = [];
	protected done = false;
	#final: PromiseWithResolvers<R> = Promise.withResolvers<R>();
	#isComplete: (event: T) => boolean;
	#extract: (event: T) => R;
	constructor(isComplete: (event: T) => boolean, extract: (event: T) => R) {
		this.#isComplete = isComplete;
		this.#extract = extract;
	}
	push(event: T): void {
		if (this.done) return;
		if (this.#isComplete(event)) {
			this.done = true;
			this.#final.resolve(this.#extract(event));
		}
		const waiter = this.#waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.#queue.push(event);
	}
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) this.#final.resolve(result);
		for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined as never, done: true });
	}
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.#queue.length > 0) yield this.#queue.shift()!;
			else if (this.done) return;
			else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}
	result(): Promise<R> {
		return this.#final.promise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	readonly #startedAt = Date.now();
	readonly #monotonic = performance.now();
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("not terminal");
			},
		);
	}
	override push(event: AssistantMessageEvent): void {
		if (event.type === "done") this.#time(event.message);
		else if (event.type === "error") this.#time(event.error);
		super.push(event);
	}
	override end(result?: AssistantMessage): void {
		if (result !== undefined) this.#time(result);
		super.end(result);
	}
	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#startedAt) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.#monotonic));
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}

export interface ProviderStreams {
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
	fetchDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
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

export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;
	readonly auth: ProviderAuth;
	getModels(): readonly Model<TApi>[];
	getAllModels(): readonly AnyModel[];
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
	fetchDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
	generateImages?(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
	classify?(model: ClassifierModel<string>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult>;
}

export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}
export function isModelType<T extends ModelType>(model: AnyModel, type: T): model is ModelTypeMap[T] {
	return getModelType(model) === type;
}

function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		outer.push({ type: "error", reason: "error", error });
		outer.end(error);
	});
	return outer;
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
	const chat = () => input.models.filter((model): model is Model<Api> => isModelType(model, "chat"));
	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: chat,
		getAllModels: () => input.models,
		stream: (model, context, options) => input.api?.stream(model, context, options) ?? errorStream(model, `no api for ${model.api}`),
		streamSimple: (model, context, options) => input.api?.streamSimple(model, context, options) ?? errorStream(model, `no api for ${model.api}`),
		...(input.api?.fetchDeferred === undefined
			? {}
			: { fetchDeferred: (model, handle, options) => input.api!.fetchDeferred!(model, handle, options) }),
		...(input.api?.cancelDeferred === undefined
			? {}
			: { cancelDeferred: (model, handle, options) => input.api!.cancelDeferred!(model, handle, options) }),
		...(input.images === undefined
			? {}
			: {
					generateImages: async (model, context, options) => {
						const implementation = input.images![model.api];
						if (implementation === undefined) throw new Error(`no images api ${model.api}`);
						return implementation.generateImages(model, context, options);
					},
				}),
		...(input.classifiers === undefined
			? {}
			: {
					classify: async (model, context, options) => {
						const implementation = input.classifiers![model.api];
						if (implementation === undefined) throw new Error(`no classifier api ${model.api}`);
						return implementation.classify(model, context, options);
					},
				}),
	};
}

export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;
	getModels(provider?: string): readonly Model<Api>[];
	getModel(provider: string, id: string): Model<Api> | undefined;
	getModelsOfType<T extends ModelType>(type: T, provider?: string): readonly ModelTypeMap[T][];
	getModelOfType<T extends ModelType>(type: T, provider: string, id: string): ModelTypeMap[T] | undefined;
	getAllModels(provider?: string): readonly AnyModel[];
	getAvailableOfType<T extends ModelType>(type: T, providerId?: string, options?: unknown): Promise<readonly ModelTypeMap[T][]>;
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	complete(model: Model<Api>, context: Context, options?: StreamOptions): Promise<AssistantMessage>;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
	streamDeferred(model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream;
	fetchDeferred(model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions): Promise<AssistantMessage>;
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
	generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
	classify(model: ClassifierModel<string>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult>;
}

export interface MutableModels extends Models {
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

export function createModels(_options: { identity?: ClientIdentity } = {}): MutableModels {
	const providers = new Map<string, Provider>();
	const owner = (model: { provider: string }): Provider => {
		const provider = providers.get(model.provider);
		if (provider === undefined) throw new Error(`Unknown provider: ${model.provider}`);
		return provider;
	};
	const all = (id?: string): AnyModel[] =>
		id !== undefined ? [...(providers.get(id)?.getAllModels() ?? [])] : [...providers.values()].flatMap((p) => p.getAllModels());
	const models: MutableModels = {
		getProviders: () => [...providers.values()],
		getProvider: (id) => providers.get(id),
		getModels: (id) => all(id).filter((m): m is Model<Api> => isModelType(m, "chat")),
		getModel: (provider, id) => models.getModels(provider).find((m) => m.id === id),
		getModelsOfType: (type, provider) => all(provider).filter((m): m is ModelTypeMap[typeof type] => isModelType(m, type)),
		getModelOfType: (type, provider, id) => models.getModelsOfType(type, provider).find((m) => m.id === id),
		getAllModels: (provider) => all(provider),
		getAvailableOfType: async (type, provider) => models.getModelsOfType(type, provider),
		stream: (model, context, options) => owner(model).stream(model, normalizeContext(context), options),
		complete: (model, context, options) => models.stream(model, context, options).result(),
		streamSimple: (model, context, options) => owner(model).streamSimple(model, normalizeContext(context), options),
		completeSimple: (model, context, options) => models.streamSimple(model, context, options).result(),
		streamDeferred: (model, handle, options) => {
			const provider = owner(model);
			if (provider.fetchDeferred === undefined) return errorStream(model, `Provider ${provider.id} has no deferred`);
			return provider.fetchDeferred(model, handle, options);
		},
		fetchDeferred: (model, handle, options) => models.streamDeferred(model, handle, options).result(),
		cancelDeferred: async (model, handle, options) => {
			await owner(model).cancelDeferred?.(model, handle, options);
		},
		generateImages: (model, context, options) => {
			const provider = owner(model);
			if (provider.generateImages === undefined) throw new Error(`Provider ${provider.id} has no images`);
			return provider.generateImages(model, context, options);
		},
		classify: (model, context, options) => {
			const provider = owner(model);
			if (provider.classify === undefined) throw new Error(`Provider ${provider.id} has no classifiers`);
			return provider.classify(model, context, options);
		},
		setProvider: (provider) => void providers.set(provider.id, provider),
		deleteProvider: (id) => void providers.delete(id),
		clearProviders: () => providers.clear(),
	};
	return models;
}

export function mergeClientIdentity(...sources: (ClientIdentity | undefined)[]): ClientIdentity | undefined {
	let merged: ClientIdentity | undefined;
	for (const source of sources) {
		if (!source) continue;
		merged = { ...merged };
		if (source.userAgent !== undefined) merged.userAgent = source.userAgent;
		if (source.attribution !== undefined) merged.attribution = source.attribution;
		if (source.version !== undefined) merged.version = source.version;
	}
	return merged;
}

export function withClientIdentity(models: MutableModels, identity: ClientIdentity): MutableModels;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models {
	const merge = <T extends { identity?: ClientIdentity }>(options: T | undefined): T =>
		({ ...options, identity: mergeClientIdentity(identity, options?.identity) }) as T;
	const wrapped: Models = {
		getProviders: () => models.getProviders(),
		getProvider: (id) => models.getProvider(id),
		getModels: (provider) => models.getModels(provider),
		getModel: (provider, id) => models.getModel(provider, id),
		getModelsOfType: (type, provider) => models.getModelsOfType(type, provider),
		getModelOfType: (type, provider, id) => models.getModelOfType(type, provider, id),
		getAllModels: (provider) => models.getAllModels(provider),
		getAvailableOfType: (type, provider, options) => models.getAvailableOfType(type, provider, options),
		stream: (m, c, o) => models.stream(m, c, merge(o)),
		complete: (m, c, o) => models.complete(m, c, merge(o)),
		streamSimple: (m, c, o) => models.streamSimple(m, c, merge(o)),
		completeSimple: (m, c, o) => models.completeSimple(m, c, merge(o)),
		streamDeferred: (m, h, o) => models.streamDeferred(m, h, merge(o)),
		fetchDeferred: (m, h, o) => models.fetchDeferred(m, h, merge(o)),
		cancelDeferred: (m, h, o) => models.cancelDeferred(m, h, merge(o)),
		generateImages: (m, c, o) => models.generateImages(m, c, merge(o)),
		classify: (m, c, o) => models.classify(m, c, merge(o)),
	};
	if (!("setProvider" in models)) return wrapped;
	const mutable = models as MutableModels;
	return { ...wrapped, setProvider: mutable.setProvider, deleteProvider: mutable.deleteProvider, clearProviders: mutable.clearProviders } as MutableModels;
}
