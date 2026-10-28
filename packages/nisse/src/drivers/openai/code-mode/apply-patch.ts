import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { failed, ok, tool } from "../../../tools/tool.ts"

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

const apply = (cwd: string, change: Change) => {
  const at = (path: string) => resolve(cwd, path)
  const write = (path: string, text: string) => {
    mkdirSync(dirname(at(path)), { recursive: true })
    writeFileSync(at(path), text)
  }
  switch (change.kind) {
    case "add":
      write(change.path, change.content)
      return `A ${change.path}`
    case "delete":
      rmSync(at(change.path))
      return `D ${change.path}`
    case "update": {
      let text: string
      try {
        text = updated(readFileSync(at(change.path), "utf8"), change.chunks)
      } catch (error) {
        if (error instanceof PatchError) throw new PatchError(`${change.path}: ${error.message}`)
        throw error
      }
      const target = change.moveTo ?? change.path
      write(target, text)
      if (at(target) !== at(change.path)) rmSync(at(change.path))
      return `M ${target}`
    }
  }
}

export const ApplyPatch = tool({
  name: "apply_patch",
  description:
    "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  readOnly: false,
  input: Schema.String,
  run: (patch, { cwd }) =>
    Effect.sync(() => {
      let changes: Array<Change>
      try {
        changes = parse(patch)
      } catch (error) {
        return failed(`invalid patch: ${(error as Error).message}`)
      }
      const summary = ["Success. Updated the following files:"]
      for (const change of changes) {
        try {
          summary.push(apply(cwd, change))
        } catch (error) {
          return failed(
            error instanceof PatchError
              ? error.message
              : `could not change ${change.path}: ${(error as Error).message}`,
          )
        }
      }
      return ok(summary.join("\n"))
    }),
})
