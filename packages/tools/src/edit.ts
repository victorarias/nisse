// `edit`. Derived from pi-durable's `src/tools/edit.ts` (earendil-works/pi, packages/durable, commit 7d073328e), under
// the MIT license in this package's LICENSE (Copyright 2025 Mario Zechner).
import type { FileError } from "@sigma/env"
import type { JsonObject } from "@sigma/kernel"
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@sigma/harness"
import { arr, obj, type Static, str } from "@sigma/schema"
import { Effect } from "effect"
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.ts"
import { requireEnv, resolveToolPath, withFileMutationQueue } from "./environment.ts"

const replaceEditSchema = obj(
  {
    oldText: str({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: str({ description: "Replacement text for this targeted edit." }),
  },
  { open: true },
)

const editSchema = obj(
  {
    path: str({ description: "Path to the file to edit (relative or absolute)" }),
    edits: arr(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }),
  },
  { open: true },
)

export type EditToolInput = Static<typeof editSchema>
type SingleEditInput = { oldText: string; newText: string }

function isSingleEditInput(value: unknown): value is SingleEditInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const edit = value as Record<string, unknown>
  return typeof edit.oldText === "string" && typeof edit.newText === "string"
}

/**
 * Repairs shapes models commonly send: `edits` as a JSON string or as a single edit object, and a top-level
 * `oldText`/`newText` pair. Works on a copy; the call's arguments stay unchanged.
 */
function prepareEditArguments(input: JsonObject): JsonObject {
  const args: JsonObject = { ...input }
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
      else if (isSingleEditInput(parsed)) args.edits = [parsed]
    } catch {}
  } else if (isSingleEditInput(args.edits)) {
    args.edits = [args.edits]
  }
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args
  const edits = Array.isArray(args.edits) ? [...args.edits] : []
  edits.push({ oldText: args.oldText, newText: args.newText })
  const { oldText: _oldText, newText: _newText, ...rest } = args
  return { ...rest, edits }
}

export type EditToolDetails = {
  diff: string
  patch: string
  firstChangedLine?: number
}

const editAccessError = (path: string) => (error: FileError) =>
  new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error })

/**
 * Exact text replacements in one file, each matched against the original (with fuzzy matching of whitespace and
 * quotes), keeping its BOM and line endings. Details carry a diff and a unified patch for clients.
 */
export function createEditTool() {
  return defineTool({
    name: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    execute: (args: EditToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        if (!Array.isArray(args.edits) || args.edits.length === 0) {
          return yield* Effect.fail(
            new Error("Edit tool input is invalid. edits must contain at least one replacement."),
          )
        }
        const { path } = args
        const edits: Edit[] = args.edits
        const env = yield* requireEnv(api)
        const absolutePath = yield* resolveToolPath(env, path)
        const failed = editAccessError(path)
        return yield* withFileMutationQueue(
          env,
          absolutePath,
          Effect.gen(function* () {
            const info = yield* Effect.mapError(env.fileInfo(absolutePath), failed)
            if (info.kind !== "file" && info.kind !== "symlink") {
              return yield* Effect.fail(new Error(`Could not edit file: ${path}. Path is not a file.`))
            }
            const read = yield* Effect.mapError(env.readTextFile(absolutePath), failed)
            const { bom, text: content } = stripBom(read)
            const originalEnding = detectLineEnding(content)
            const { baseContent, newContent } = yield* Effect.try({
              try: () => applyEditsToNormalizedContent(normalizeToLF(content), edits, path),
              catch: (error) => error as Error,
            })
            yield* Effect.mapError(
              env.writeFile(absolutePath, bom + restoreLineEndings(newContent, originalEnding)),
              failed,
            )
            const diff = generateDiffString(baseContent, newContent)
            const details: EditToolDetails = {
              diff: diff.diff,
              patch: generateUnifiedPatch(path, baseContent, newContent),
              ...(diff.firstChangedLine === undefined ? {} : { firstChangedLine: diff.firstChangedLine }),
            }
            return {
              output: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
              details,
            } satisfies ToolExecutionResult
          }),
        )
      }),
  })
}
