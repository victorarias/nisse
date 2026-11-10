// `grep`: regular expression search of file contents through the call's environment.
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@nisse/harness"
import { bool, obj, opt, type Static, str } from "@nisse/schema"
import type { ExecutionEnv, FileError } from "@nisse/env"
import { Effect } from "effect"
import { requireEnv, resolveToolPath } from "./environment.ts"
import { filesBelow, globMatcher } from "./files.ts"

const MATCH_LIMIT = 200
const LINE_CHARS = 500
const BINARY_PROBE = 8192

const grepSchema = obj({
  pattern: str({ description: "The regular expression to search for." }),
  path: opt(str({ description: "The file or directory to search. Default the working directory." })),
  glob: opt(str({ description: "Only search files whose path matches this glob, such as `*.ts` or `src/**/*.ts`." })),
  case_insensitive: opt(bool({ description: "Ignore case. Default false." })),
})

export type GrepToolInput = Static<typeof grepSchema>

const text = (text: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
})

/** Searches file contents for a JavaScript regular expression, up to 200 matching lines; read-only, so replay-safe. */
export function createGrepTool() {
  return defineTool({
    name: "grep",
    description: `Search file contents for a regular expression (JavaScript syntax). Returns \`path:line:text\` for each matching line, in path order, up to ${MATCH_LIMIT} matches; very long lines are cut. Skips binary files and, inside a git repository, files that git ignores.`,
    parameters: grepSchema,
    replay: "safe",
    execute: (input: GrepToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        let regex: RegExp
        try {
          regex = new RegExp(input.pattern, input.case_insensitive ? "i" : "")
        } catch (error) {
          return text(`bad pattern: ${(error as Error).message}`, true)
        }
        const env = yield* requireEnv(api)
        const root = yield* resolveToolPath(env, input.path ?? ".")
        const files = yield* filesBelow(env, root)
        if (files === undefined) return text(`${input.path} does not exist`, true)
        const wanted = input.glob === undefined ? () => true : globMatcher(input.glob)
        const shownRoot = input.path === undefined || input.path === "." ? "" : input.path.replace(/\/+$/, "")
        const matches: string[] = []
        for (const file of files) {
          // A file named by `path` is matched as the model wrote it.
          if (!wanted(file === "" ? (input.path ?? "") : file)) continue
          const path = file === "" ? root : yield* env.joinPath([root, file])
          if (!(yield* Effect.orElseSucceed(isText(env, path), () => false))) continue
          const shown = file === "" ? (input.path ?? root) : shownRoot === "" ? file : `${shownRoot}/${file}`
          yield* Effect.orElseSucceed(
            searchLines(env, path, regex, (number, line) => {
              matches.push(
                `${shown}:${number}:${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} [line cut]` : line}`,
              )
              return matches.length < MATCH_LIMIT
            }),
            () => undefined,
          )
          if (matches.length === MATCH_LIMIT) {
            return text(`${matches.join("\n")}\n[stopped at ${MATCH_LIMIT} matches; narrow the pattern or path]`)
          }
        }
        return text(matches.length === 0 ? "No matches." : matches.join("\n"))
      }),
  })
}

/** Whether the file's first bytes hold no NUL, read without loading the rest. */
const isText = (env: ExecutionEnv, path: string) =>
  Effect.acquireUseRelease(
    env.openBinaryReader(path),
    (reader) => Effect.map(reader.read(0, BINARY_PROBE), (head) => !head.includes(0)),
    (reader) => reader.close(),
  )

/**
 * Hands each line of the file that matches `regex` to `found`, one line in memory at a time, until `found` returns
 * false.
 */
const searchLines = (
  env: ExecutionEnv,
  path: string,
  regex: RegExp,
  found: (number: number, line: string) => boolean,
): Effect.Effect<void, FileError> =>
  Effect.acquireUseRelease(
    env.openTextLineReader(path),
    (reader) =>
      Effect.gen(function* () {
        for (let number = 1; ; number++) {
          const line = yield* reader.readLine()
          if (line === undefined) return
          const text = line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text
          if (regex.test(text) && !found(number, text)) return
        }
      }),
    (reader) => reader.close(),
  )
