// The file tools through a real Harness: the model calls them, and the files in the workspace are what a person sees.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ExecutionEnv } from "@nisse/env"
import { fauxAssistantMessage, fauxToolCall } from "@nisse/models/faux"
import { Deferred, Effect } from "effect"
import { createApplyPatchTool, createEditTool } from "../src/index.ts"
import { openChat, overriding, removeDirectories, resultText, run } from "./support.ts"

afterEach(removeDirectories)

/**
 * An environment whose reads of `name` wait until two calls have resolved its path, so two edits running side by side
 * would both read the original if nothing kept them apart.
 */
const readsAfterTwoResolves = (name: string) => {
  let resolves = 0
  const resolved = Deferred.makeUnsafe<void>()
  return (env: ExecutionEnv): ExecutionEnv =>
    overriding(env, {
      absolutePath: (path) =>
        Effect.tap(env.absolutePath(path), (absolute) =>
          Effect.sync(() => {
            if (basename(absolute) === name && ++resolves === 2) Deferred.doneUnsafe(resolved, Effect.void)
          }),
        ),
      readTextFile: (path) =>
        basename(path) === name
          ? Effect.andThen(Deferred.await(resolved), env.readTextFile(path))
          : env.readTextFile(path),
    })
}

test("tool-file-queue: two edits of one file the model calls in parallel both land", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createEditTool()],
        env: readsAfterTwoResolves("notes.txt"),
        settings: { toolExecution: "parallel" },
        responses: [
          fauxAssistantMessage(
            [
              fauxToolCall("edit", { path: "notes.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
              fauxToolCall("edit", { path: "notes.txt", edits: [{ oldText: "omega", newText: "OMEGA" }] }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("done"),
        ],
      })
      const notes = join(chat.workspace, "notes.txt")
      writeFileSync(notes, "alpha\nbeta\nomega\n")
      yield* chat.ask("change both ends")
      const results = yield* chat.toolResults()
      expect(results.map(resultText)).toEqual([
        "Successfully replaced 1 block(s) in notes.txt.",
        "Successfully replaced 1 block(s) in notes.txt.",
      ])
      expect(readFileSync(notes, "utf8")).toBe("ALPHA\nbeta\nOMEGA\n")
    }),
  ))

test("tool-apply-patch: a patch adds, updates, moves and deletes files, and a hunk that does not match changes nothing after it", () =>
  run(
    Effect.gen(function* () {
      const patch = [
        "*** Begin Patch",
        "*** Add File: docs/new.md",
        "+# New",
        "*** Update File: src/app.ts",
        "*** Move to: src/main.ts",
        "@@",
        " const a = 1",
        "-const b = 2",
        "+const b = 3",
        "*** Delete File: old.txt",
        "*** End Patch",
      ].join("\n")
      const failing = ["*** Begin Patch", "*** Update File: src/main.ts", "-missing line", "+x", "*** End Patch"].join(
        "\n",
      )
      const chat = yield* openChat({
        tools: [createApplyPatchTool()],
        responses: [
          fauxAssistantMessage(fauxToolCall("apply_patch", { patch }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("apply_patch", { patch: failing }), { stopReason: "toolUse" }),
          fauxAssistantMessage("done"),
        ],
      })
      const at = (path: string) => join(chat.workspace, path)
      mkdirSync(at("src"))
      writeFileSync(at("src/app.ts"), "const a = 1\nconst b = 2\n")
      writeFileSync(at("old.txt"), "bye\n")
      yield* chat.ask("patch it")
      const [applied, refused] = yield* chat.toolResults()
      expect(resultText(applied!)).toBe(
        "Success. Updated the following files:\nA docs/new.md\nM src/main.ts\nD old.txt",
      )
      expect(refused!.isError).toBe(true)
      expect(resultText(refused!)).toBe("src/main.ts: could not find the lines to change:\nmissing line")
      expect(readFileSync(at("docs/new.md"), "utf8")).toBe("# New\n")
      expect(readFileSync(at("src/main.ts"), "utf8")).toBe("const a = 1\nconst b = 3\n")
      expect(existsSync(at("src/app.ts"))).toBe(false)
      expect(existsSync(at("old.txt"))).toBe(false)
    }),
  ))
