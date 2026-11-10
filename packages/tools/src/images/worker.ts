// The worker thread of `createNodePhotonImages()`: Photon prepares images here, off the caller's event loop. Derived from
// pi-durable's `src/images/node-worker.ts` (earendil-works/pi, packages/durable, commit 7d073328e), under the MIT
// license in this package's LICENSE (Copyright 2025 Mario Zechner).
import { parentPort } from "node:worker_threads"
import { Effect } from "effect"
import type { ImageLimits, PreparedImage } from "../image-processor.ts"
import { photonWasm } from "./node.ts"
import { createPhotonImages } from "./photon.ts"

/** One request: the image to prepare, and its ID for the reply. */
export type PrepareRequest = {
  readonly id: number
  readonly bytes: Uint8Array
  readonly mimeType: string
  readonly limits: ImageLimits
}

/** The reply to a request: its result, or why it failed. */
export type PrepareReply =
  | { readonly id: number; readonly result: PreparedImage | undefined }
  | { readonly id: number; readonly error: string }

const port = parentPort
if (port === null) throw new Error("The Photon image worker needs a parent thread")
const images = createPhotonImages(photonWasm())
port.on("message", (request: PrepareRequest) => {
  void Effect.runPromise(images.prepare(request.bytes, request.mimeType, request.limits)).then(
    (result) => port.postMessage({ id: request.id, result } satisfies PrepareReply),
    (error: unknown) =>
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PrepareReply),
  )
})
