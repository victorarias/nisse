// The `script` provider: answers from a list of steps, the format of `NISSE_MODEL_SCRIPT`. Each request takes the
// next unused step for its agent; with none left, it answers `You said: <the last user text>`. It streams word by
// word, with `delayMs` before each word.
import { Duration, Effect, Schema, Stream } from "effect"
import type { Provider } from "./models.ts"
import { failure, replay } from "./replay.ts"
import { contentText } from "./text.ts"
import type { AssistantMessage, JsonObject, Model, TranscriptContext, Usage } from "./types.ts"
import { uuidv7 } from "./uuid.ts"

export const ScriptStep = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, input: Schema.Unknown })),
  fail: Schema.optionalKey(Schema.String),
  delayMs: Schema.optionalKey(Schema.Int),
  agent: Schema.optionalKey(Schema.String),
})
export type ScriptStep = typeof ScriptStep.Type

/** The agent a request is for when its `metadata.agent` names none: nisse's root conversation. */
export const ROOT_AGENT = "/root"

const ZERO: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// A script has no context window or output limit; the largest safe integer keeps estimates from ever reaching one.
export const SCRIPT_MODEL: Model<"script"> = {
  id: "script",
  name: "Script",
  api: "script",
  provider: "script",
  baseUrl: "",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number.MAX_SAFE_INTEGER,
  maxTokens: Number.MAX_SAFE_INTEGER,
}

const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? []

const lastUserText = (context: TranscriptContext) => {
  const message = context.messages.findLast((candidate) => candidate.role === "user")
  return message?.role === "user" ? contentText(message.content) : ""
}

const answer = (step: ScriptStep, model: Model<string>): AssistantMessage => {
  const text = step.text ?? ""
  const base: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO,
    stopReason: "stop",
    timestamp: Date.now(),
  }
  if (step.fail !== undefined) {
    return { ...failure(base, step.fail), content: text === "" ? [] : [{ type: "text", text }] }
  }
  if (step.tool === undefined) return { ...base, content: [{ type: "text", text }] }
  return {
    ...base,
    content: [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      { type: "toolCall", id: `call_${uuidv7()}`, name: step.tool.name, arguments: step.tool.input as JsonObject },
    ],
    stopReason: "toolUse",
  }
}

export function scriptProvider(steps: readonly ScriptStep[]): Provider {
  const taken = new Set<number>()
  const nextFor = (agent: string) => {
    const index = steps.findIndex((step, at) => !taken.has(at) && (step.agent ?? ROOT_AGENT) === agent)
    if (index < 0) return undefined
    taken.add(index)
    return steps[index]
  }
  return {
    id: "script",
    models: [SCRIPT_MODEL],
    streamSimple: (model, context, options) =>
      Stream.suspend(() => {
        const agent = options.metadata?.agent
        const step = nextFor(typeof agent === "string" ? agent : ROOT_AGENT) ?? {
          text: `You said: ${lastUserText(context)}`,
          delayMs: 30,
        }
        const delay = step.delayMs ?? 0
        return replay(answer(step, model), {
          split: words,
          pause: () => (delay > 0 ? Effect.sleep(Duration.millis(delay)) : Effect.void),
        })
      }),
  }
}
