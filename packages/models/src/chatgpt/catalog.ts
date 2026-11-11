import type { ModelInfo } from "../kind.ts"
import type { Model } from "../types.ts"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Schema } from "effect"
import bundled from "./models.json" with { type: "json" }

export const CLIENT_VERSION = "0.164.0"

const Listed = Schema.Struct({
  slug: Schema.String,
  display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  visibility: Schema.optionalKey(Schema.NullOr(Schema.String)),
  priority: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tool_mode: Schema.optionalKey(Schema.NullOr(Schema.String)),
  context_window: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  default_reasoning_level: Schema.optionalKey(Schema.NullOr(Schema.String)),
  supported_reasoning_levels: Schema.optionalKey(Schema.Array(Schema.Struct({ effort: Schema.String }))),
})
const Models = Schema.Struct({ models: Schema.Array(Listed) })
type Models = typeof Models.Type

const decode = Schema.decodeUnknownSync(Models)

const info = (model: typeof Listed.Type): ModelInfo => ({
  id: model.slug,
  name: model.display_name ?? model.slug,
  ...(model.description ? { description: model.description } : {}),
  efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
  ...(model.default_reasoning_level ? { defaultEffort: model.default_reasoning_level } : {}),
  ...(model.context_window ? { contextWindow: model.context_window } : {}),
})

const readSaved = (path: string): Models | undefined => {
  try {
    return decode(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

/** ChatGPT's Responses API, as nisse speaks it to `/codex/responses`. */
export const CHATGPT_API = "openai-codex-responses"

// The catalog names no output limit; 0 tells the harness it is unknown. ChatGPT bills a subscription, not tokens.
const chatModel = (provider: string, baseUrl: string, model: typeof Listed.Type): Model<typeof CHATGPT_API> => ({
  id: model.slug,
  name: model.display_name ?? model.slug,
  api: CHATGPT_API,
  provider,
  baseUrl,
  reasoning: (model.supported_reasoning_levels ?? []).length > 0,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: model.context_window ?? 0,
  maxTokens: 0,
})

export type Catalog = ReturnType<typeof catalog>

export const catalog = (savedPath: string) => {
  let known: Models | undefined

  const current = () => (known ??= readSaved(savedPath) ?? decode(bundled))

  return {
    fetched: (body: unknown) => {
      const models = decode(body)
      mkdirSync(dirname(savedPath), { recursive: true, mode: 0o700 })
      writeFileSync(`${savedPath}.partial`, JSON.stringify(models))
      renameSync(`${savedPath}.partial`, savedPath)
      known = models
    },
    /** Every model the catalog has, listed or not, as the `Models` seam serves it. */
    chatModels: (provider: string, baseUrl: string): ReadonlyArray<Model<typeof CHATGPT_API>> =>
      current().models.map((model) => chatModel(provider, baseUrl, model)),
    wantsCodeMode: (slug: string) =>
      current().models.find((model) => model.slug === slug)?.tool_mode === "code_mode_only",
    listed: (): ReadonlyArray<ModelInfo> =>
      current()
        .models.filter((model) => (model.visibility ?? "list") === "list")
        .toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
        .map(info),
  }
}
