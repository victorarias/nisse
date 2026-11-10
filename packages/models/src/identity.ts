// How requests identify the calling app, from pi-ai's `src/utils/identity.ts` in earendil-works/pi at commit 7d073328e
// (MIT, see LICENSE). The header formatting for OpenRouter, NVIDIA and OpenCode is left out with those providers;
// `withClientIdentity` wraps the Effect seam.
import type { Models } from "./models.ts"

/**
 * The `User-Agent` sent to providers:
 * - `"detailed"`: `pi/<version> (<platform>; <runtime>/<runtime version>; <arch>)`, or `pi/<version> (browser)`
 *   outside Node.js and Bun.
 * - `"short"`: `pi`.
 * - `{ custom }`: the given value.
 */
export type UserAgentMode = "short" | "detailed" | { custom: string }

/** Who requests are attributed to. `getAttributionHeaders()` maps the fields to each provider's headers. */
export interface ClientAttribution {
  /** App name: OpenRouter app title, NVIDIA invoke origin (first letter upper-cased), OpenCode client. */
  name: string
  /** App URL: OpenRouter `HTTP-Referer`, the app's identity in OpenRouter's rankings, grouped by origin. */
  url: string
  /** App categories, e.g. `["cli-agent"]`: OpenRouter `X-OpenRouter-Categories`, comma-separated. */
  categories?: string[]
}

/** pi's attribution, used by pi-agent-core, pi-durable, and the coding agent. */
export const PI_ATTRIBUTION: ClientAttribution = { name: "pi", url: "https://pi.dev", categories: ["cli-agent"] }

/**
 * How pi-ai identifies the calling app to providers. Every field is optional; absent fields use pi-ai's defaults:
 * a detailed `User-Agent` with pi-ai's version and no attribution headers. Plain JSON, so it can be persisted.
 */
export interface ClientIdentity {
  /** Default: `"detailed"`. */
  userAgent?: UserAgentMode
  /** Provider attribution headers. Absent or `null`: none; `null` also turns off attribution set by a merged identity. */
  attribution?: ClientAttribution | null
  /** Version in the detailed `User-Agent`. Default: the pi-ai version. */
  version?: string
}

/** Merge identities field by field; later sources win and undefined fields are skipped. */
export function mergeClientIdentity(...sources: (ClientIdentity | undefined)[]): ClientIdentity | undefined {
  let merged: ClientIdentity | undefined
  for (const source of sources) {
    if (!source) continue
    merged = { ...merged }
    if (source.userAgent !== undefined) merged.userAgent = source.userAgent
    if (source.attribution !== undefined) merged.attribution = source.attribution
    if (source.version !== undefined) merged.version = source.version
  }
  return merged
}

/**
 * `models` with `identity` as the default identity of its requests: a request's `identity` overrides it field by
 * field, and it overrides the identity `models` was created with. Everything else is delegated unchanged.
 */
export function withClientIdentity(models: Models, identity: ClientIdentity): Models {
  const withIdentity = <T extends { identity?: ClientIdentity }>(options: T | undefined): T => {
    const merged = mergeClientIdentity(identity, options?.identity)
    return { ...options, ...(merged === undefined ? {} : { identity: merged }) } as T
  }
  return {
    ...models,
    streamSimple: (model, context, options) => models.streamSimple(model, context, withIdentity(options)),
    completeSimple: (model, context, options) => models.completeSimple(model, context, withIdentity(options)),
    fetchDeferred: (model, handle, options) => models.fetchDeferred(model, handle, withIdentity(options)),
    cancelDeferred: (model, handle, options) => models.cancelDeferred(model, handle, withIdentity(options)),
    generateImages: (model, context, options) => models.generateImages(model, context, withIdentity(options)),
    classify: (model, context, options) => models.classify(model, context, withIdentity(options)),
  }
}
