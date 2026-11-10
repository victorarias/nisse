// `write`. Derived from pi-durable's `src/tools/write.ts` (earendil-works/pi, packages/durable, commit 7d073328e),
// under the MIT license in this package's LICENSE (Copyright 2025 Mario Zechner).
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@nisse/harness"
import { obj, type Static, str } from "@nisse/schema"
import { Effect } from "effect"
import { requireEnv, resolveToolPath, withFileMutationQueue } from "./environment.ts"

// Open objects, as the tools accepted extra arguments when their schemas were TypeBox's.
const writeSchema = obj(
  {
    path: str({ description: "Path to the file to write (relative or absolute)" }),
    content: str({ description: "Content to write to the file" }),
  },
  { open: true },
)

export type WriteToolInput = Static<typeof writeSchema>

/** Creates or replaces a file, with its parent directories, through the call's environment. */
export function createWriteTool() {
  return defineTool({
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    execute: ({ path, content }: WriteToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        const env = yield* requireEnv(api)
        const absolutePath = yield* resolveToolPath(env, path)
        yield* withFileMutationQueue(env, absolutePath, env.writeFile(absolutePath, content))
        return { output: [{ type: "text", text: `Successfully wrote to ${path}` }] } satisfies ToolExecutionResult
      }),
  })
}
