// Stand-ins for pi-ai/utils/*: retry and overflow classification, token estimates, transcript helpers, uuid, tolerant
// streaming JSON. Hand-written and smaller than the originals: patterns list only common providers, and
// StreamingJsonParser re-parses its buffer on each append instead of being incremental.
import { compile } from "../schema/src/index.ts";
import { formats } from "../schema/src/formats/index.ts";
import type { AssistantMessage, ClientAttribution, ClientIdentity, Context, JsonObject, JsonValue, Message, SystemMessage, Tool, ToolCall, ToolReference, TranscriptContext, Usage } from "./types.ts";
export type { ClientIdentity } from "./types.ts";

export const PI_ATTRIBUTION: ClientAttribution = { name: "sigma", url: "https://example.invalid", categories: ["cli-agent"] };

export function uuidv7(): string {
	const now = Date.now();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[0] = (now / 2 ** 40) & 0xff;
	bytes[1] = (now / 2 ** 32) & 0xff;
	bytes[2] = (now / 2 ** 24) & 0xff;
	bytes[3] = (now / 2 ** 16) & 0xff;
	bytes[4] = (now / 2 ** 8) & 0xff;
	bytes[5] = now & 0xff;
	bytes[6] = (bytes[6]! & 0x0f) | 0x70;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeContext(context: Context): TranscriptContext {
	const hasPrompt = context.systemPrompt !== undefined && context.systemPrompt.length > 0;
	const hasTools = context.tools !== undefined && context.tools.length > 0;
	const initial: SystemMessage | undefined =
		hasPrompt || hasTools ? { role: "system", content: context.systemPrompt ?? "", ...(hasTools ? { toolsAdded: context.tools! } : {}), timestamp: 0 } : undefined;
	return { messages: initial ? [initial, ...context.messages] : context.messages } as TranscriptContext;
}

type TranscriptMessages = readonly { role: string }[];
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const system = message as SystemMessage;
		for (const removed of system.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of system.toolsAdded ?? []) tools.set(added.name, added);
	}
	return [...tools.values()];
}

export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
export function declarationsEqual(a: Tool, b: Tool): boolean {
	return canonicalJson(toToolDeclaration(a)) === canonicalJson(toToolDeclaration(b));
}

const RETRYABLE = /overloaded|rate.?limit|too many requests|(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|network.?error|connection.?(?:error|refused|lost)|fetch failed|timed? out|timeout|terminated|ended without/i;
const NON_RETRYABLE = /insufficient_quota|out of budget|quota exceeded|billing/i;
export function retryDelayMs(policy: { baseDelayMs: number; maxAgentDelayMs?: number }, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER, policy.maxAgentDelayMs ?? 60_000);
}
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return !NON_RETRYABLE.test(message.errorMessage) && RETRYABLE.test(message.errorMessage);
}

const OVERFLOW = /prompt (?:is )?too long|exceeds the context window|context window exceeded|maximum context length|input token count.*exceeds the maximum|context[_ ]length[_ ]exceeded|too many tokens|token limit exceeded|request_too_large/i;
const NOT_OVERFLOW = /rate limit|too many requests/i;
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	if (message.stopReason === "error" && message.errorMessage && !NOT_OVERFLOW.test(message.errorMessage) && OVERFLOW.test(message.errorMessage)) return true;
	if (contextWindow && message.stopReason === "stop") {
		const input = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (input > contextWindow) return true;
	}
	return false;
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function chars(value: unknown): number {
	return typeof value === "string" ? value.length : JSON.stringify(value ?? "").length;
}
export function estimateMessageTokens(message: Message): number {
	let count = 0;
	if (message.role === "user") {
		if (typeof message.content === "string") count = message.content.length;
		else for (const block of message.content) count += block.type === "text" ? block.text.length : 4800;
	} else if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "text") count += block.text.length;
			else if (block.type === "thinking") count += block.thinking.length;
			else count += block.name.length + chars(block.arguments);
		}
	} else if (message.role === "toolResult") {
		for (const block of message.content) count += block.type === "text" ? block.text.length : 4800;
	} else if (message.role === "system") {
		count += chars(message.content);
		for (const section of Object.values(message.sections ?? {})) count += section?.length ?? 0;
		for (const tool of message.toolsAdded ?? []) count += chars(tool);
	}
	return Math.ceil(count / 4);
}

export function getSystemMessageText(message: SystemMessage): string {
	const base = typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
	const sections = Object.values(message.sections ?? {}).filter((section): section is string => section !== null);
	return [base, ...sections].filter((part) => part.length > 0).join("\n\n");
}

let cachedValidators = new WeakMap<object, ReturnType<typeof compile>>();
export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
	if (toolCall.argumentsError) throw new Error(`Invalid arguments for tool "${toolCall.name}": ${toolCall.argumentsError}`);
	let validator = cachedValidators.get(tool.parameters);
	if (validator === undefined) {
		validator = compile(tool.parameters as never, { formats, coerce: true, unresolvedRefs: "reject" } as never) as ReturnType<typeof compile>;
		cachedValidators.set(tool.parameters, validator);
	}
	const result = (validator as unknown as { parse(value: unknown): { ok: true; value: unknown } | { ok: false; errors: { path: string; message: string }[] } }).parse(structuredClone(toolCall.arguments));
	if (result.ok) return result.value;
	const errors = result.errors
		.map((error) => `  - ${error.path === "" ? "root" : error.path.slice(1).split("/").join(".")}: ${error.message}`)
		.join("\n");
	throw new Error(`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`);
}

export type JsonPath = readonly (string | number)[];
export type JsonChange =
	| { readonly kind: "set"; readonly path: JsonPath; readonly value: JsonValue }
	| { readonly kind: "append"; readonly path: JsonPath; readonly text: string };

/** Tolerant parse of a JSON prefix; returns undefined when nothing has started. */
function parsePrefix(text: string): JsonValue | undefined {
	let i = 0;
	const skip = () => {
		while (i < text.length && /\s/.test(text[i]!)) i++;
	};
	const readString = (): string => {
		i++;
		let out = "";
		while (i < text.length) {
			const c = text[i]!;
			if (c === '"') {
				i++;
				return out;
			}
			if (c === "\\") {
				if (i + 1 >= text.length) {
					i = text.length;
					return out;
				}
				const n = text[i + 1]!;
				if (n === "u") {
					if (i + 6 > text.length) {
						i = text.length;
						return out;
					}
					out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
					i += 6;
					continue;
				}
				const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };
				out += map[n] ?? `\\${n}`;
				i += 2;
				continue;
			}
			out += c;
			i++;
		}
		return out;
	};
	const readValue = (): JsonValue | undefined => {
		skip();
		const c = text[i];
		if (c === undefined) return undefined;
		if (c === "{") {
			i++;
			const object: JsonObject = {};
			for (;;) {
				skip();
				if (i >= text.length) return object;
				if (text[i] === "}") {
					i++;
					return object;
				}
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] !== '"') {
					i++;
					continue;
				}
				const key = readString();
				skip();
				if (i >= text.length) return object;
				if (text[i] === ":") i++;
				skip();
				if (i >= text.length) return object;
				const value = readValue();
				if (value !== undefined) object[key] = value;
			}
		}
		if (c === "[") {
			i++;
			const array: JsonValue[] = [];
			for (;;) {
				skip();
				if (i >= text.length) return array;
				if (text[i] === "]") {
					i++;
					return array;
				}
				if (text[i] === ",") {
					i++;
					continue;
				}
				const value = readValue();
				if (value !== undefined) array.push(value);
			}
		}
		if (c === '"') return readString();
		const rest = /^[^\s,\]}]*/.exec(text.slice(i))![0];
		i += rest.length;
		for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) if (word.startsWith(rest) && rest.length > 0) return value;
		const number = Number(rest);
		if (rest.length > 0 && Number.isFinite(number)) return number;
		const trimmed = /^-?\d+(?:\.\d+)?/.exec(rest)?.[0];
		return trimmed === undefined ? undefined : Number(trimmed);
	};
	return readValue();
}

function diff(path: JsonPath, before: JsonValue | undefined, after: JsonValue | undefined, out: JsonChange[]): void {
	if (after === undefined) return;
	if (before === undefined) {
		out.push({ kind: "set", path, value: after });
		return;
	}
	if (typeof before === "string" && typeof after === "string") {
		if (before === after) return;
		if (after.startsWith(before)) out.push({ kind: "append", path, text: after.slice(before.length) });
		else out.push({ kind: "set", path, value: after });
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		for (let index = 0; index < after.length; index++) diff([...path, index], before[index], after[index], out);
		return;
	}
	if (before !== null && after !== null && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
		for (const key of Object.keys(after)) diff([...path, key], (before as JsonObject)[key], (after as JsonObject)[key], out);
		return;
	}
	if (before !== after) out.push({ kind: "set", path, value: after });
}

export class StreamingJsonParser {
	#text = "";
	#value: JsonValue | undefined;
	append(text: string): readonly JsonChange[] {
		this.#text += text;
		const next = parsePrefix(this.#text);
		const changes: JsonChange[] = [];
		diff([], this.#value, next, changes);
		this.#value = next;
		return changes;
	}
	snapshot(): JsonValue | undefined {
		return this.#value;
	}
}

export class ToolCallArgumentsStream {
	#parser = new StreamingJsonParser();
	#text = "";
	append(delta: string): ToolCall["arguments"] {
		this.#text += delta;
		this.#parser.append(delta);
		const value = this.#parser.snapshot();
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
	}
}

export type { ToolReference };
