// The call's execution environment, tool paths, and the per-file mutation queue (spec 7.3). Derived from pi-durable's
// `src/tools/env.ts`, `path-utils.ts` and `file-mutation-queue.ts` (earendil-works/pi, packages/durable, commit
// 7d073328e), under the MIT license in this package's LICENSE (Copyright 2025 Mario Zechner).
import type { ExecutionEnv } from "@nisse/env"
import type { ToolExecutionApi } from "@nisse/harness"
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
 * work it started has settled. Not a lock against `bash` or other processes.
 */
export const withFileMutationQueue = <A, E, R>(
  env: ExecutionEnv,
  path: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  Effect.flatMap(mutationKey(env, path), (key) =>
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
      ({ release, tail }) =>
        Effect.sync(() => {
          release()
          if (queues.get(key) === tail) queues.delete(key)
        }),
    ),
  )
