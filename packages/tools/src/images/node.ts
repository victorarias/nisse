// Photon image preparation in a worker thread. Derived from pi-durable's `src/images/node.ts` (earendil-works/pi,
// packages/durable, commit 7d073328e), under the MIT license in this package's LICENSE (Copyright 2025 Mario Zechner).
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { Worker } from "node:worker_threads"
import { Effect } from "effect"
import type { ImageLimits, ImageProcessor, PreparedImage } from "../image-processor.ts"
import { createPhotonImages } from "./photon.ts"
import type { PrepareReply, PrepareRequest } from "./worker.ts"

export type NodePhotonImagesOptions = {
  /**
   * Prepare images in a worker thread, so a large photo does not block the event loop for the second or two Photon
   * takes. Default `true`; `false` prepares them on the calling thread.
   */
  readonly worker?: boolean
  /**
   * How long the worker stays after its last image before it exits, freeing Photon's WebAssembly memory, which never
   * shrinks while it lives. The next image starts a new one. Default 30 s.
   */
  readonly idleMs?: number
}

/** Photon's WebAssembly, read from the installed `@silvia-odwyer/photon`. */
export const photonWasm = (): Uint8Array =>
  readFileSync(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm"))

/**
 * `createPhotonImages()` with Photon's WebAssembly read from the installed `@silvia-odwyer/photon`, by default in a
 * worker thread that keeps the process alive only while it prepares an image. A worker that cannot start falls back to
 * the calling thread. A single-file binary cannot resolve the package: read its own copy of `photon_rs_bg.wasm` and call
 * `createPhotonImages()`.
 */
export function createNodePhotonImages(options: NodePhotonImagesOptions = {}): ImageProcessor {
  let local: ImageProcessor | undefined
  const inProcess = (): ImageProcessor => (local ??= createPhotonImages(photonWasm()))
  if (options.worker === false) return { prepare: (...args) => Effect.suspend(() => inProcess().prepare(...args)) }
  const idleMs = options.idleMs ?? 30_000
  let thread: PhotonThread | undefined
  let unavailable = false
  return {
    prepare: (bytes, mimeType, limits) =>
      Effect.suspend(() => {
        if (unavailable) return inProcess().prepare(bytes, mimeType, limits)
        return Effect.tryPromise({
          try: () => {
            thread ??= new PhotonThread(idleMs, () => {
              thread = undefined
            })
            return thread.prepare(bytes, mimeType, limits)
          },
          catch: (error) => error as Error,
        }).pipe(
          Effect.catch((error) => {
            if (!(error instanceof WorkerUnavailable)) return Effect.fail(error)
            // No worker on this platform or build: prepare here from now on.
            unavailable = true
            return inProcess().prepare(bytes, mimeType, limits)
          }),
        )
      }),
  }
}

/** The worker could not start, as opposed to failing on one image. */
class WorkerUnavailable extends Error {}

/** One worker thread and the requests it has not answered; it exits after `idleMs` without requests. */
class PhotonThread {
  readonly #worker: Worker
  readonly #pending = new Map<number, PromiseWithResolvers<PreparedImage | undefined>>()
  readonly #idleMs: number
  readonly #onExit: () => void
  #nextId = 0
  #idle: ReturnType<typeof setTimeout> | undefined
  /** Whether the worker answered once: a failure before that means it is unavailable. */
  #started = false

  constructor(idleMs: number, onExit: () => void) {
    this.#idleMs = idleMs
    this.#onExit = onExit
    try {
      this.#worker = new Worker(new URL("./worker.ts", import.meta.url))
    } catch (error) {
      throw new WorkerUnavailable("The Photon image worker cannot start", { cause: error })
    }
    this.#worker.unref()
    this.#worker.on("message", (reply: PrepareReply) => {
      this.#started = true
      const request = this.#pending.get(reply.id)
      if (request === undefined) return
      this.#pending.delete(reply.id)
      if ("error" in reply) request.reject(new Error(reply.error))
      else request.resolve(reply.result)
      this.#settled()
    })
    const fail = (error: unknown): void => {
      const failure = this.#started
        ? error
        : new WorkerUnavailable("The Photon image worker cannot start", { cause: error })
      for (const request of this.#pending.values()) request.reject(failure)
      this.#pending.clear()
      this.#exit()
    }
    this.#worker.on("error", fail)
    this.#worker.on("exit", (code) => fail(new Error(`The Photon image worker exited with code ${code}`)))
  }

  prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined> {
    const id = this.#nextId++
    const request = Promise.withResolvers<PreparedImage | undefined>()
    this.#pending.set(id, request)
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    this.#idle = undefined
    // A pending image keeps the process alive, as one prepared on the calling thread would.
    this.#worker.ref()
    // A copy, transferred: the caller keeps its bytes.
    const copy = bytes.slice()
    this.#worker.postMessage({ id, bytes: copy, mimeType, limits } satisfies PrepareRequest, [copy.buffer])
    return request.promise
  }

  #settled(): void {
    if (this.#pending.size > 0) return
    this.#worker.unref()
    this.#idle = setTimeout(() => {
      this.#exit()
      void this.#worker.terminate()
    }, this.#idleMs)
    this.#idle.unref()
  }

  #exit(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    this.#idle = undefined
    this.#onExit()
  }
}
