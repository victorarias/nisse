// Image limits, the processor seam and base64. Derived from pi-durable's `src/tools/image-processor.ts`
// (earendil-works/pi, packages/durable, commit 7d073328e), under the MIT license in this package's LICENSE (Copyright 2025
// Mario Zechner); `prepare` returns an Effect.

import type { ModelInputLimits } from "@sigma/models"
import type { Effect } from "effect"

/** Limits an image the model sees must keep; the defaults below are the coding agent's. */
export type ImageLimits = {
  /** Pixels. Default 2000. */
  readonly maxWidth: number
  /** Pixels. Default 2000. */
  readonly maxHeight: number
  /** Bytes of base64. Default 4.5 MiB, below Anthropic's 5 MB. */
  readonly maxBytes: number
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 }

/** A model's image limits: `DEFAULT_IMAGE_LIMITS` overridden by its `inputLimits.images.resize`. */
export function imageLimitsOf(model: { readonly inputLimits?: ModelInputLimits } | undefined): ImageLimits {
  const resize = model?.inputLimits?.images?.resize
  return {
    maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
    maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
    maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
  }
}

/** An image the model can take: a supported format, within the limits, as base64. */
export type PreparedImage = {
  readonly data: string
  readonly mimeType: string
  /** Set when the image was resized: its size before and after, for the model to map coordinates back. */
  readonly resized?: {
    readonly from: { readonly width: number; readonly height: number }
    readonly to: { readonly width: number; readonly height: number }
  }
  /** The original format, set when it differs from `mimeType`: BMP becomes PNG, a large PNG may become JPEG. */
  readonly convertedFrom?: string
}

/**
 * Decodes, orients, resizes, and re-encodes images so the model can take them. `read` uses one when given; without
 * one, it passes supported images within the byte limit through as they are. `@sigma/tools/images` provides a
 * Photon-based one.
 */
export type ImageProcessor = {
  /**
   * The image, prepared to fit `limits`, or `undefined` when it cannot be decoded or made to fit. An Effect, so a
   * processor can do the work off the event loop; it fails only when the processor itself breaks.
   */
  prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Effect.Effect<PreparedImage | undefined, Error>
}

/** Formats every provider takes inline; others, such as BMP, need converting. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/**
 * Standard base64 of `bytes`. `btoa` takes a binary string, built 8 KiB at a time: a single `String.fromCharCode`
 * call with megabytes of arguments overflows the stack.
 */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 8192) {
    // `apply` takes any array-like, though its type asks for an array.
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192) as unknown as number[]))
  }
  return btoa(parts.join(""))
}

/** The length of the base64 of `byteLength` bytes. */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}
