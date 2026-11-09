// Stand-in for the pi-ai types that the ported durable kernel consumes. Hand-written; not a copy of pi-ai.
// `JsonValue` here is pi-ai's: arrays are read-only. Durable has its own stricter JsonValue in chord/json.

export type Api = string;
export type ProviderId = string;
export type ImageApi = string;
export type ClassifierApi = string;
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingLevel = Exclude<ModelThinkingLevel, "off">;
export type CacheRetention = "none" | "short" | "long";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface ClientAttribution {
	name: string;
	url: string;
	categories?: string[];
}
export type UserAgentMode = "short" | "detailed" | { custom: string };
export interface ClientIdentity {
	userAgent?: UserAgentMode;
	attribution?: ClientAttribution | null;
	version?: string;
}

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}
export type ProviderHeaders = Record<string, string | null>;

export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	telemetry?: unknown;
	apiKey?: string;
	fetch?: typeof globalThis.fetch;
	env?: Record<string, string>;
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	headers?: ProviderHeaders;
	identity?: ClientIdentity;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
	transport?: Transport;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	disableContinuation?: boolean;
	metadata?: Record<string, unknown>;
}

export interface SimpleStreamOptions extends StreamOptions {
	toolChoice?: "auto" | "none";
	reasoning?: ThinkingLevel;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	thinkingBudgets?: ThinkingBudgets;
}

export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	wait?: number;
}
export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	namespace?: string;
	argumentsError?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		totalFromProvider?: boolean;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	data?: JsonValue;
}

export interface Tool<TParameters extends object = object> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | { type: "json_schema"; strict: "prefer" | "require" } | { type: "grammar"; variants: Record<string, string> };
}
export interface ToolReference {
	name: string;
}

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: ToolReference[];
	timestamp: number;
}
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	providerThinkingLevel?: string;
	thinkingLevel?: ModelThinkingLevel;
	diagnostics?: JsonValue[];
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
	durationMs?: number;
}

export interface NestedToolCallRecord {
	id: string;
	name: string;
	arguments?: JsonObject;
	argumentsBytes?: number;
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	error?: string;
}
export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	complete: boolean;
}

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
type IsJsonProperty<T> =
	IsAny<T> extends true ? false : unknown extends T ? false : [Exclude<T, undefined>] extends [never] ? true : IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];
type IsJsonCompatible<T> =
	IsAny<T> extends true
		? false
		: unknown extends T
			? false
			: IsExactlyJsonValue<T> extends true
				? true
				: T extends null | boolean | number | string
					? true
					: T extends undefined
						? false
						: T extends readonly (infer TItem)[]
							? IsJsonCompatible<TItem>
							: T extends (...args: never[]) => unknown
								? false
								: T extends object
									? [InvalidJsonKeys<T>] extends [never]
										? true
										: false
									: false;
export type JsonRepresentation<T> =
	IsAny<T> extends true
		? JsonValue
		: unknown extends T
			? JsonValue
			: [T] extends [JsonValue]
				? T
				: T extends readonly unknown[]
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: T extends object
						? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
						: never;

export type ToolResultMessage<TDetails = JsonValue> =
	IsJsonCompatible<TDetails> extends true
		? {
				role: "toolResult";
				toolCallId: string;
				toolName: string;
				content: (TextContent | ImageContent)[];
				details?: JsonRepresentation<TDetails>;
				usage?: Usage;
				nestedCalls?: NestedToolCalls;
				isError: boolean;
				timestamp: number;
				durationMs?: number;
			}
		: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}
declare const transcriptContextBrand: unique symbol;
export type TranscriptContext = { messages: Message[]; readonly [transcriptContextBrand]: true };

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface BaseModel<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	input: ("text" | "image")[];
	inputLimits?: { images?: { resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; quality?: number; format?: string }; [key: string]: unknown }; [key: string]: unknown };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; [key: string]: unknown };
	headers?: Record<string, string>;
}
export interface Model<TApi extends Api> extends BaseModel<TApi> {
	type?: "chat";
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
	promptCache?: unknown;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
}
export interface ImageModel<TApi extends ImageApi> extends BaseModel<TApi> {
	type: "image";
	output: ("text" | "image")[];
}
export interface ClassifierModel<TApi extends ClassifierApi> extends BaseModel<TApi> {
	type: "classifier";
	contextWindow: number;
}
export interface ModelTypeMap {
	chat: Model<Api>;
	image: ImageModel<ImageApi>;
	classifier: ClassifierModel<ClassifierApi>;
}
export type ModelType = keyof ModelTypeMap;
export type AnyModel = ModelTypeMap[ModelType];

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;
export interface ImagesContext {
	input: ImagesInputContent[];
}
export interface AssistantImages {
	api: ImageApi;
	provider: ProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}
export type ClassifierQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };
export interface ClassifierContext {
	state: JsonObject;
	images?: ImageContent[];
	questions: Record<string, ClassifierQuestion>;
}
export type ClassifierAnswer =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "bool"; probability: number };
export interface ClassifierResult {
	api: ClassifierApi;
	provider: ProviderId;
	model: string;
	answers: Record<string, ClassifierAnswer>;
	usage?: Usage;
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}
export interface ImagesOptions extends ProviderRequestOptions<ImageModel<ImageApi>> {
	metadata?: Record<string, unknown>;
}
export interface ClassifierOptions extends ProviderRequestOptions<ClassifierModel<ClassifierApi>> {
	temperature?: number;
}
