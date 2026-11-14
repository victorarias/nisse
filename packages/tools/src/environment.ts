// The call's execution environment, tool paths, and the per-file mutation queue (spec 7.3). Derived from pi-durable's
// `src/tools/env.ts`, `path-utils.ts` and `file-mutation-queue.ts` (earendil-works/pi, packages/durable, commit
// 7d073328e), under the MIT license in this package's LICENSE (Copyright 2025 Mario Zechner).
import type { ExecutionEnv } from "@sigma/env"
import type { ToolExecutionApi } from "@sigma/harness"
import { Effect } from "effect"

/** The call's execution environment; a tool without one fails with an ordinary error result. */
export const requireEnv = (api: Pick<ToolExecutionApi, "env">): Effect.Effect<ExecutionEnv, Error> =>
  api.env === undefined ? Effect.fail(new Error("No execution environment is configured")) : Effect.succeed(api.env)

const UNICODE_SPACES = /[  -   　]/g
const NARROW_NO_BREAK_SPACE = " "

function normalizeToolPath(path: string): string {
  const normalized = path.replace(UNICODE_SPACES, " ")
  return normalized.startsWith("@") ? normalized.slice(1) : normalized
}

/** A path a model wrote, absolute in `env`: unusual spaces become spaces, and a leading `@` is dropped. */
export const resolveToolPath = (env: ExecutionEnv, path: string) => env.absolutePath(normalizeToolPath(path))

/**
 * `resolveToolPath`, then the first spelling that exists among those macOS screenshots and decomposed names use: a
 * narrow no-break space before AM or PM, NFD, and a curly apostrophe.
 */
export const resolveReadToolPath = (env: ExecutionEnv, path: string) =>
  Effect.gen(function* () {
    const resolved = yield* resolveToolPath(env, path)
    const variants = [
      resolved,
      resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
      resolved.normalize("NFD"),
      resolved.replace(/'/g, "’"),
      resolved.normalize("NFD").replace(/'/g, "’"),
    ]
    for (const variant of new Set(variants)) {
      if (yield* env.exists(variant)) return variant
    }
    return resolved
  })

/** Tail of the mutation chain of each file, keyed by file system id and canonical path. */
const queues = new Map<string, Promise<void>>()

const mutationKey = (env: ExecutionEnv, path: string) =>
  Effect.gen(function* () {
    const absolutePath = yield* env.absolutePath(path)
    return `${env.id}\0${yield* canonical(env, absolutePath)}`
  })

/** Whether two paths in `env` name one file, through symlinks too. */
export const sameFile = (env: ExecutionEnv, a: string, b: string): Effect.Effect<boolean, Error> =>
  Effect.map(Effect.all([mutationKey(env, a), mutationKey(env, b)]), ([x, y]) => x === y)

/**
 * The canonical path; for a file that does not exist yet, its canonical parent joined with its name, so a `write` that
 * creates a file and a later mutation of it share one key even under a symlinked directory.
 */
const canonical = (env: ExecutionEnv, absolutePath: string): Effect.Effect<string, Error> =>
  env.canonicalPath(absolutePath).pipe(
    Effect.catch((error) => {
      if (error.code === "not_supported") return Effect.succeed(absolutePath)
      if (error.code !== "not_found") return Effect.fail(error)
      return Effect.gen(function* () {
        // The file system splits the path, so a name may contain characters that are separators elsewhere.
        const parent = yield* env.joinPath([absolutePath, ".."])
        if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath
        const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1))
        return yield* env.joinPath([yield* canonical(env, parent), name])
      })
    }),
  )

/**
 * Serializes `edit`, `write` and `apply_patch` mutations of one file within this process: same file system id and
 * canonical path, whichever environment object the call got. Other files, and other file systems, never wait.
 * Concurrent calls on one file run in the order their keys resolve. An interrupted mutation holds the file until the
 * work it started has settled, and a call interrupted while waiting holds it until the calls before it have. Not a lock
 * against `bash` or other processes.
 *
 * Given several paths, `work` holds each distinct file, taken in one order so two calls on the same files cannot wait on
 * each other; two paths to one file hold it once.
 */
export const withFileMutationQueue = <A, E, R>(
  env: ExecutionEnv,
  paths: string | ReadonlyArray<string>,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  Effect.flatMap(
    Effect.forEach(typeof paths === "string" ? [paths] : paths, (path) => mutationKey(env, path)),
    (keys) => [...new Set(keys)].sort().reduceRight<Effect.Effect<A, E, R>>((inner, key) => queued(key, inner), work),
  )

const queued = <A, E, R>(key: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    // The slot is taken in one step, so no other call can take it in between.
    Effect.sync(() => {
      const previous = queues.get(key) ?? Promise.resolve()
      const done = Promise.withResolvers<void>()
      const tail = previous.then(() => done.promise)
      queues.set(key, tail)
      return { previous, release: done.resolve, tail }
    }),
    ({ previous }) =>
      Effect.andThen(
        Effect.promise(() => previous),
        work,
      ),
    // The entry stays until its tail settles: a call interrupted while waiting still holds the place of those before it.
    ({ release, tail }) =>
      Effect.sync(() => {
        release()
        void tail.then(() => {
          if (queues.get(key) === tail) queues.delete(key)
        })
      }),
  )
