// `apply_patch`: the Codex patch format (add, delete, update and move files) through the call's environment, each file
// changed under the per-file mutation queue.
import type { ExecutionEnv } from "@sigma/env"
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@sigma/harness"
import { obj, type Static, str } from "@sigma/schema"
import { Effect } from "effect"
import { requireEnv, resolveToolPath, sameFile, withFileMutationQueue } from "./environment.ts"

type Change =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; readonly moveTo?: string; readonly chunks: Array<Chunk> }

interface Chunk {
  context?: string
  readonly old: Array<string>
  readonly new: Array<string>
  atEnd: boolean
}

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"
const ADD = "*** Add File: "
const DELETE = "*** Delete File: "
const UPDATE = "*** Update File: "
const MOVE = "*** Move to: "
const END_OF_FILE = "*** End of File"

class PatchError extends Error {}

const parse = (patch: string): Array<Change> => {
  const lines = patch.trim().split(/\r?\n/)
  if (lines[0]?.trim() !== BEGIN || lines.at(-1)?.trim() !== END)
    throw new PatchError(`a patch starts with \`${BEGIN}\` and ends with \`${END}\``)
  const body = lines.slice(1, -1)
  const changes: Array<Change> = []
  let at = 0
  while (at < body.length) {
    const line = body[at++]!
    if (line.startsWith(ADD)) {
      let content = ""
      while (at < body.length && body[at]!.startsWith("+")) content += `${body[at++]!.slice(1)}\n`
      changes.push({ kind: "add", path: line.slice(ADD.length).trim(), content })
    } else if (line.startsWith(DELETE)) {
      changes.push({ kind: "delete", path: line.slice(DELETE.length).trim() })
    } else if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim()
      const moveTo = body[at]?.startsWith(MOVE) ? body[at++]!.slice(MOVE.length).trim() : undefined
      const chunks: Array<Chunk> = []
      while (at < body.length && (!body[at]!.startsWith("*** ") || body[at] === END_OF_FILE)) {
        const next = body[at++]!
        if (next === END_OF_FILE) {
          const last = chunks.at(-1)
          if (last) last.atEnd = true
          continue
        }
        if (next.startsWith("@@")) {
          const context = next.slice(2).trim()
          chunks.push({ ...(context === "" ? {} : { context }), old: [], new: [], atEnd: false })
          continue
        }
        if (chunks.length === 0) chunks.push({ old: [], new: [], atEnd: false })
        const chunk = chunks.at(-1)!
        const [mark, rest] = [next.slice(0, 1), next.slice(1)]
        if (mark === "+") chunk.new.push(rest)
        else if (mark === "-") chunk.old.push(rest)
        else if (mark === " " || mark === "") {
          chunk.old.push(rest)
          chunk.new.push(rest)
        } else throw new PatchError(`unexpected line in ${path}: ${next}`)
      }
      if (chunks.length === 0) throw new PatchError(`the update of ${path} changes nothing`)
      changes.push({ kind: "update", path, ...(moveTo === undefined ? {} : { moveTo }), chunks })
    } else if (line.trim() !== "") {
      throw new PatchError(`unexpected line: ${line}`)
    }
  }
  return changes
}

const comparisons: ReadonlyArray<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
]

const seek = (lines: ReadonlyArray<string>, wanted: ReadonlyArray<string>, from: number, atEnd: boolean) => {
  if (wanted.length > lines.length) return undefined
  const last = lines.length - wanted.length
  const starts = atEnd ? [last] : Array.from({ length: Math.max(0, last + 1 - from) }, (_, i) => from + i)
  for (const same of comparisons) {
    const found = starts.find((start) => wanted.every((line, i) => same(lines[start + i]!, line)))
    if (found !== undefined) return found
  }
  return undefined
}

const updated = (original: string, chunks: ReadonlyArray<Chunk>) => {
  const lines = original.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const replacements: Array<{ at: number; removed: number; added: ReadonlyArray<string> }> = []
  let from = 0
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const found = seek(lines, [chunk.context], from, false)
      if (found === undefined) throw new PatchError(`could not find the context \`${chunk.context}\``)
      from = found + 1
    }
    if (chunk.old.length === 0) {
      replacements.push({ at: lines.length, removed: 0, added: chunk.new })
      continue
    }
    const found = seek(lines, chunk.old, from, chunk.atEnd)
    if (found === undefined) throw new PatchError(`could not find the lines to change:\n${chunk.old.join("\n")}`)
    replacements.push({ at: found, removed: chunk.old.length, added: chunk.new })
    from = found + chunk.old.length
  }
  for (const { at, removed, added } of replacements.toSorted((a, b) => b.at - a.at)) lines.splice(at, removed, ...added)
  return `${lines.join("\n")}\n`
}

const applyPatchSchema = obj({
  patch: str({ description: "The patch, from `*** Begin Patch` to `*** End Patch`." }),
})

export type ApplyPatchToolInput = Static<typeof applyPatchSchema>

const text = (text: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
})

const parentOf = (env: ExecutionEnv, path: string) => env.joinPath([path, ".."])

/** Writes `content` to `path`, creating its parent directories. */
const write = (env: ExecutionEnv, path: string, content: string) =>
  Effect.andThen(
    Effect.flatMap(parentOf(env, path), (parent) => env.createDir(parent, { recursive: true })),
    env.writeFile(path, content),
  )

/** One change, under the mutation queue of each file it touches; its line in the summary. */
const apply = (env: ExecutionEnv, change: Change): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const path = yield* resolveToolPath(env, change.path)
    switch (change.kind) {
      case "add":
        yield* withFileMutationQueue(env, path, write(env, path, change.content))
        return `A ${change.path}`
      case "delete":
        yield* withFileMutationQueue(env, path, env.remove(path))
        return `D ${change.path}`
      case "update": {
        const targetName = change.moveTo ?? change.path
        const target = yield* resolveToolPath(env, targetName)
        const update = Effect.gen(function* () {
          const original = yield* env.readTextFile(path)
          const content = yield* Effect.try({
            try: () => updated(original, change.chunks),
            catch: (error) =>
              error instanceof PatchError ? new PatchError(`${change.path}: ${error.message}`) : (error as Error),
          })
          yield* write(env, target, content)
          if (!(yield* sameFile(env, path, target))) yield* env.remove(path)
        })
        yield* withFileMutationQueue(env, [path, target], update)
        return `M ${targetName}`
      }
    }
  })

/**
 * Applies a patch in the Codex format: `*** Add File:`, `*** Delete File:` and `*** Update File:` (with an optional
 * `*** Move to:`) sections, whose hunks match lines exactly, then ignoring trailing and then surrounding whitespace.
 * Changes apply in order; the first that fails stops the patch, and the error names it.
 */
export function createApplyPatchTool() {
  return defineTool({
    name: "apply_patch",
    description:
      "Edit files with a patch. It starts with `*** Begin Patch` and ends with `*** End Patch`; between them, `*** Add File: <path>` followed by `+` lines, `*** Delete File: <path>`, or `*** Update File: <path>` (optionally followed by `*** Move to: <path>`) with hunks that start with `@@` and mark lines with ` `, `-` or `+`.",
    parameters: applyPatchSchema,
    execute: ({ patch }: ApplyPatchToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        let changes: Array<Change>
        try {
          changes = parse(patch)
        } catch (error) {
          return text(`invalid patch: ${(error as Error).message}`, true)
        }
        const env = yield* requireEnv(api)
        const summary = ["Success. Updated the following files:"]
        for (const change of changes) {
          const line = yield* Effect.result(apply(env, change))
          if (line._tag === "Failure") {
            const error = line.failure
            return text(
              error instanceof PatchError ? error.message : `could not change ${change.path}: ${error.message}`,
              true,
            )
          }
          summary.push(line.success)
        }
        return text(summary.join("\n"))
      }),
  })
}
