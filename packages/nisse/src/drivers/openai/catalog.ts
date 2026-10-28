import type { ModelInfo } from "@nisse/protocol"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Schema } from "effect"
import bundled from "./models.json" with { type: "json" }

export const CLIENT_VERSION = "0.164.0"

const Model = Schema.Struct({
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
const Models = Schema.Struct({ models: Schema.Array(Model) })
type Models = typeof Models.Type

const decode = Schema.decodeUnknownSync(Models)

const info = (model: typeof Model.Type): ModelInfo => ({
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
    listed: (): ReadonlyArray<ModelInfo> =>
      current()
        .models.filter((model) => (model.visibility ?? "list") === "list" && model.tool_mode !== "code_mode_only")
        .toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
        .map(info),
  }
}
