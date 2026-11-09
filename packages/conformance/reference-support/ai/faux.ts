// Stand-in for pi-ai/providers/faux: scripted provider, same observable surface as durable's tests use.
import { AssistantMessageEventStream, createProvider, type Provider, type ProviderStreams } from "./models.ts";
import type {
	AssistantMessage,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
	Usage,
} from "./types.ts";
import { getSystemMessageText, ToolCallArgumentsStream } from "./utils.ts";

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;
const randomId = (prefix: string) => `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}
export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}
export function fauxToolCall(name: string, args: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return { type: "toolCall", id: options.id ?? randomId("tool"), name, arguments: args };
}
export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: { stopReason?: AssistantMessage["stopReason"]; deferred?: DeferredHandle; errorMessage?: string; responseId?: string; timestamp?: number } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: typeof content === "string" ? [fauxText(content)] : Array.isArray(content) ? content : [content],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: ZERO_USAGE,
		stopReason: options.stopReason ?? "stop",
		...(options.deferred === undefined ? {} : { deferred: options.deferred }),
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		...(options.responseId === undefined ? {} : { responseId: options.responseId }),
		timestamp: options.timestamp ?? Date.now(),
	};
}

export interface FauxModelDefinition {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	inputLimits?: Model<string>["inputLimits"];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}
export interface FauxProviderState {
	callCount: number;
	deferredFetchCount: number;
	cancelledDeferred: DeferredHandle[];
}
export type FauxResponseFactory = (context: TranscriptContext, options: SimpleStreamOptions | undefined, state: FauxProviderState, model: Model<string>) => AssistantMessage | Promise<AssistantMessage>;
export type FauxResponseStep = AssistantMessage | FauxResponseFactory;
export interface RegisterFauxProviderOptions {
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	deferred?: { pendingFetches?: number; pollAfterMs?: number };
	tokensPerSecond?: number;
	tokenSize?: { min?: number; max?: number };
}
export interface FauxProviderHandle {
	provider: Provider;
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
}

const estimate = (text: string) => Math.ceil(text.length / 4);
function blocksToText(blocks: readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[]): string {
	return blocks
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			if (block.type === "image") return `[image:${block.mimeType}:${block.data.length}]`;
			return `${block.name}:${JSON.stringify(block.arguments)}`;
		})
		.join("\n");
}
function messageText(message: Message): string {
	if (message.role === "system") {
		return [getSystemMessageText(message), ...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []), ...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? [])]
			.filter((part) => part.length > 0)
			.join("\n");
	}
	if (message.role === "user") return typeof message.content === "string" ? message.content : blocksToText(message.content);
	if (message.role === "assistant") return blocksToText(message.content);
	return [message.toolName, ...message.content.map((block) => blocksToText([block]))].join("\n");
}

function withUsage(message: AssistantMessage, context: TranscriptContext, options: StreamOptions | undefined, cache: Map<string, string>): AssistantMessage {
	const prompt = context.messages.map((m) => `${m.role}:${messageText(m)}`).join("\n\n");
	const promptTokens = Math.ceil(prompt.length / 4);
	const output = estimate(blocksToText(message.content));
	let input = promptTokens;
	let cacheRead = 0;
	let cacheWrite = 0;
	const sessionId = options?.sessionId;
	if (sessionId && options?.cacheRetention !== "none") {
		const previous = cache.get(sessionId);
		if (previous !== undefined) {
			let index = 0;
			while (index < previous.length && index < prompt.length && previous[index] === prompt[index]) index++;
			cacheRead = Math.ceil(index / 4);
			cacheWrite = Math.max(0, promptTokens - cacheRead);
		} else cacheWrite = promptTokens;
		input = 0;
		cache.set(sessionId, prompt);
	}
	return { ...message, usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function chunks(text: string, min: number, max: number): string[] {
	const out: string[] = [];
	for (let index = 0; index < text.length; ) {
		const size = Math.max(1, (min + Math.floor(Math.random() * (max - min + 1))) * 4);
		out.push(text.slice(index, index + size));
		index += size;
	}
	return out.length > 0 ? out : [""];
}

const failure = (error: unknown, api: string, provider: string, model: string, reason: "error" | "aborted" = "error"): AssistantMessage => ({
	role: "assistant",
	content: [],
	api,
	provider,
	model,
	usage: ZERO_USAGE,
	stopReason: reason,
	errorMessage: reason === "aborted" ? "Request was aborted" : error instanceof Error ? error.message : String(error),
	timestamp: Date.now(),
});

async function play(stream: AssistantMessageEventStream, message: AssistantMessage, min: number, max: number, tokensPerSecond: number | undefined, signal: AbortSignal | undefined): Promise<void> {
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	const abort = () => {
		const aborted: AssistantMessage = { ...partial, stopReason: "aborted", errorMessage: "Request was aborted", timestamp: Date.now() };
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
	};
	if (signal?.aborted) return abort();
	const pause = (chunk: string): Promise<void> =>
		tokensPerSecond && tokensPerSecond > 0 ? new Promise((resolve) => setTimeout(resolve, (estimate(chunk) / tokensPerSecond) * 1000)) : new Promise((resolve) => queueMicrotask(resolve));
	stream.push({ type: "start", partial: { ...partial } });
	for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
		if (signal?.aborted) return abort();
		const block = message.content[contentIndex]!;
		if (block.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex, partial: { ...partial } });
			for (const chunk of chunks(block.thinking, min, max)) {
				await pause(chunk);
				if (signal?.aborted) return abort();
				(partial.content[contentIndex] as ThinkingContent).thinking += chunk;
				stream.push({ type: "thinking_delta", contentIndex, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: { ...partial } });
		} else if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex, partial: { ...partial } });
			for (const chunk of chunks(block.text, min, max)) {
				await pause(chunk);
				if (signal?.aborted) return abort();
				(partial.content[contentIndex] as TextContent).text += chunk;
				stream.push({ type: "text_delta", contentIndex, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "text_end", contentIndex, content: block.text, partial: { ...partial } });
		} else {
			partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
			stream.push({ type: "toolcall_start", contentIndex, partial: { ...partial } });
			const args = new ToolCallArgumentsStream();
			for (const chunk of chunks(JSON.stringify(block.arguments), min, max)) {
				await pause(chunk);
				if (signal?.aborted) return abort();
				(partial.content[contentIndex] as ToolCall).arguments = args.append(chunk);
				stream.push({ type: "toolcall_delta", contentIndex, delta: chunk, partial: { ...partial } });
			}
			(partial.content[contentIndex] as ToolCall).arguments = block.arguments;
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: { ...partial } });
		}
	}
	if (message.stopReason === "pending") throw new Error("Faux response ended without a stop reason");
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
		stream.end(message);
		return;
	}
	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
}

export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
	const api = options.api ?? randomId("faux");
	const provider = options.provider ?? "faux";
	const min = Math.max(1, Math.min(options.tokenSize?.min ?? 3, options.tokenSize?.max ?? 5));
	const max = Math.max(min, options.tokenSize?.max ?? 5);
	let pending: FauxResponseStep[] = [];
	const state: FauxProviderState = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] };
	const cache = new Map<string, string>();
	const deferred = new Map<string, { handle: DeferredHandle; step: FauxResponseStep; context: TranscriptContext; options: SimpleStreamOptions | undefined; model: Model<string>; pendingFetches: number; cancelled: boolean; final?: AssistantMessage }>();
	const defs: FauxModelDefinition[] = options.models?.length ? options.models : [{ id: "faux-1", name: "Faux Model", input: ["text", "image"] }];
	const models = defs.map((def) => ({
		id: def.id,
		name: def.name ?? def.id,
		api,
		provider,
		baseUrl: "http://localhost:0",
		reasoning: def.reasoning ?? false,
		input: def.input ?? ["text", "image"],
		...(def.inputLimits === undefined ? {} : { inputLimits: def.inputLimits }),
		cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: def.contextWindow ?? 128000,
		maxTokens: def.maxTokens ?? 16384,
	})) as [Model<string>, ...Model<string>[]];

	const deferredMessage = (model: Model<string>, handle: DeferredHandle): AssistantMessage => ({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "deferred", deferred: handle, timestamp: Date.now() });
	const resolve = async (step: FauxResponseStep, context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined, model: Model<string>): Promise<AssistantMessage> => {
		const message = typeof step === "function" ? await step(context, streamOptions, state, model) : step;
		const cloned = structuredClone(message);
		return withUsage({ ...cloned, api, provider, model: model.id, timestamp: cloned.timestamp ?? Date.now(), usage: cloned.usage ?? ZERO_USAGE }, context, streamOptions, cache);
	};
	const stream: ProviderStreams["streamSimple"] = (model, context, streamOptions) => {
		const outer = new AssistantMessageEventStream();
		const step = pending.shift();
		state.callCount++;
		queueMicrotask(async () => {
			try {
				await streamOptions?.onResponse?.({ status: 200, headers: {} }, model);
				if (!step) {
					const message = withUsage(failure(new Error("No more faux responses queued"), api, provider, model.id), context, streamOptions, cache);
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
					return;
				}
				if (streamOptions?.deferred) {
					const handle: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: randomId("deferred"), ...(options.deferred?.pollAfterMs !== undefined ? { pollAfterMs: options.deferred.pollAfterMs } : {}) };
					deferred.set(handle.id, { handle, step, context, options: streamOptions, model, pendingFetches: Math.max(0, Math.floor(options.deferred?.pendingFetches ?? 0)), cancelled: false });
					await play(outer, deferredMessage(model, handle), min, max, options.tokensPerSecond, streamOptions.signal);
					return;
				}
				await play(outer, await resolve(step, context, streamOptions, model), min, max, options.tokensPerSecond, streamOptions?.signal);
			} catch (error) {
				const message = failure(error, api, provider, model.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});
		return outer;
	};
	const fetchDeferred = (model: Model<string>, handle: DeferredHandle, fetchOptions?: DeferredFetchOptions): AssistantMessageEventStream => {
		const outer = new AssistantMessageEventStream();
		state.deferredFetchCount++;
		queueMicrotask(async () => {
			try {
				await fetchOptions?.onResponse?.({ status: 200, headers: {} }, model);
				const entry = deferred.get(handle.id);
				if (!entry || entry.handle.provider !== handle.provider || entry.handle.modelId !== handle.modelId || entry.handle.api !== handle.api) throw new Error(`Unknown faux deferred response: ${handle.id}`);
				if (entry.cancelled) throw new Error(`Faux deferred response was cancelled: ${handle.id}`);
				if (entry.pendingFetches > 0) {
					entry.pendingFetches--;
					await play(outer, deferredMessage(model, entry.handle), min, max, options.tokensPerSecond, fetchOptions?.signal);
					return;
				}
				if (!entry.final) {
					const { deferred: _d, signal: _s, onResponse: _o, ...rest } = entry.options ?? {};
					try {
						entry.final = await resolve(entry.step, entry.context, rest, entry.model);
					} catch (error) {
						entry.final = failure(error, api, provider, entry.model.id);
					}
				}
				await play(outer, entry.final, min, max, options.tokensPerSecond, fetchOptions?.signal);
			} catch (error) {
				const message = failure(error, api, provider, model.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});
		return outer;
	};
	const cancelDeferred = async (model: Model<string>, handle: DeferredHandle, cancelOptions?: DeferredCancelOptions): Promise<void> => {
		state.cancelledDeferred.push(structuredClone(handle));
		const entry = deferred.get(handle.id);
		if (entry) entry.cancelled = true;
		await cancelOptions?.onResponse?.({ status: 200, headers: {} }, model);
	};
	function getModel(): Model<string>;
	function getModel(id: string): Model<string> | undefined;
	function getModel(id?: string): Model<string> | undefined {
		return id ? models.find((m) => m.id === id) : models[0];
	}
	return {
		provider: createProvider({ id: provider, auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } }, models, api: { stream, streamSimple: stream, fetchDeferred, cancelDeferred } }),
		api,
		models,
		getModel,
		state,
		setResponses: (responses) => void (pending = [...responses]),
		appendResponses: (responses) => void pending.push(...responses),
		getPendingResponseCount: () => pending.length,
	};
}

export function builtinModels(): never {
	throw new Error("builtinModels: real providers are not part of the stand-in");
}
export function openaiProvider(): never {
	throw new Error("openaiProvider: real providers are not part of the stand-in");
}
