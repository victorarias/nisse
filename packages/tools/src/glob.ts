// `glob`: files whose path matches a glob, newest first, through the call's environment.
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@sigma/harness"
import { obj, opt, type Static, str } from "@sigma/schema"
import { Effect } from "effect"
import { requireEnv, resolveToolPath } from "./environment.ts"
import { filesBelow, globMatcher } from "./files.ts"

const GLOB_LIMIT = 200

const globSchema = obj({
  pattern: str({ description: "The glob to match paths against." }),
  path: opt(str({ description: "The directory to search. Default the working directory." })),
})

export type GlobToolInput = Static<typeof globSchema>

const text = (text: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
})

/** Lists files whose path below the searched directory matches a glob, newest first, up to 200; replay-safe. */
export function createGlobTool() {
  return defineTool({
    name: "glob",
    description: `Find files whose path matches a glob, such as \`**/*.ts\` or \`src/*.json\`. Returns paths, newest first, up to ${GLOB_LIMIT}. Inside a git repository, skips files that git ignores.`,
    parameters: globSchema,
    replay: "safe",
    execute: (input: GlobToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        const env = yield* requireEnv(api)
        const root = yield* resolveToolPath(env, input.path ?? ".")
        const files = yield* filesBelow(env, root)
        if (files === undefined) return text(`${input.path} does not exist`, true)
        const wanted = globMatcher(input.pattern)
        const shownRoot = input.path === undefined || input.path === "." ? "" : input.path.replace(/\/+$/, "")
        const stamped: { path: string; mtime: number }[] = []
        for (const file of files) {
          if (file === "" || !wanted(file)) continue
          const info = yield* Effect.option(env.fileInfo(yield* env.joinPath([root, file])))
          if (info._tag === "Some")
            stamped.push({ path: shownRoot === "" ? file : `${shownRoot}/${file}`, mtime: info.value.mtimeMs })
        }
        stamped.sort((a, b) => b.mtime - a.mtime)
        if (stamped.length === 0) return text("No files found.")
        const shown = stamped.slice(0, GLOB_LIMIT).map(({ path }) => path)
        return text(
          stamped.length > GLOB_LIMIT
            ? `${shown.join("\n")}\n[${stamped.length - GLOB_LIMIT} more not shown]`
            : shown.join("\n"),
        )
      }),
  })
}
