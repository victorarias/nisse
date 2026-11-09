// The model catalog's field types, from pi-ai's `src/providers/model-schema.ts` in earendil-works/pi at commit
// 7d073328e (MIT, see LICENSE). pi-ai declares them as schemas to validate its catalog files; nisse has no catalog
// files, so they are plain types here.

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
export const MODEL_THINKING_LEVELS = ["off", ...THINKING_LEVELS] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number]
export type ModelInputModality = "text" | "image"
export type CacheRetention = "none" | "short" | "long"

/** Provider value sent for each thinking level. null marks a level unsupported. */
export type ThinkingLevelMap = { [Level in ModelThinkingLevel]?: string | null }

/** Best-effort prompt cache lifetime in seconds for the short and long retention tiers. */
export interface ModelPromptCache {
  short?: number
  long?: number
}

/** Costs in USD per million tokens. */
export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Used when total request input exceeds `inputTokensAbove`. */
export interface ModelCostTier extends ModelCostRates {
  inputTokensAbove: number
}

export interface ModelCost extends ModelCostRates {
  /** Request-wide pricing tiers. The highest matching input threshold applies to the full request. */
  tiers?: ModelCostTier[]
}

export interface ModelImageResizeOptions {
  maxWidth?: number
  maxHeight?: number
  /** Maximum base64-encoded payload size in bytes. */
  maxBytes?: number
  jpegQuality?: number
}

export interface ModelImageInputLimits {
  /** Cache-safe resize profile applied before a new image enters conversation history. */
  resize?: ModelImageResizeOptions
  maxPerMessage?: number
  maxPerRequest?: number
}

export interface ModelInputLimits {
  /** Maximum serialized provider request size in bytes. */
  maxRequestBytes?: number
  images?: ModelImageInputLimits
}
