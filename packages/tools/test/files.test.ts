// The file tools through a real Harness: the model calls them, and the files in the workspace are what a person sees.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ExecutionEnv } from "@sigma/env"
import { LocalExecutionEnv } from "@sigma/env/local"
import { fauxAssistantMessage, fauxToolCall } from "@sigma/models/faux"
import { Deferred, Effect, Fiber } from "effect"
import { createApplyPatchTool, createEditTool, withFileMutationQueue } from "../src/index.ts"
import { openChat, overriding, removeDirectories, resultText, run, temporaryDirectory } from "./support.ts"

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

test("tool-file-queue: a mutation interrupted while it waits does not let the next one run beside the one holding the file", () =>
  run(
    Effect.gen(function* () {
      const workspace = temporaryDirectory("sigma-tools-")
      // Signals once a call has resolved the file's key and taken its place in the queue, which it does in the same step.
      let resolved = Deferred.makeUnsafe<void>()
      writeFileSync(join(workspace, "notes.txt"), "alpha\n")
      const env = new LocalExecutionEnv({ cwd: workspace })
      const keyed = overriding(env, {
        canonicalPath: (path) =>
          Effect.tap(env.canonicalPath(path), () =>
            Effect.sync(() => {
              const signal = resolved
              queueMicrotask(() => Deferred.doneUnsafe(signal, Effect.void))
            }),
          ),
      })
      const nextKey = () => {
        const signal = (resolved = Deferred.makeUnsafe<void>())
        return Deferred.await(signal)
      }
      let holding = false
      const release = Deferred.makeUnsafe<void>()
      const first = nextKey()
      const holder = yield* Effect.forkChild(
        withFileMutationQueue(
          keyed,
          "notes.txt",
          Effect.gen(function* () {
            holding = true
            yield* Deferred.await(release)
            holding = false
          }),
        ),
      )
      yield* first
      const second = nextKey()
      const interrupted = yield* Effect.forkChild(withFileMutationQueue(keyed, "notes.txt", Effect.void))
      yield* second
      yield* Fiber.interrupt(interrupted)
      const third = nextKey()
      const next = yield* Effect.forkChild(
        withFileMutationQueue(
          keyed,
          "notes.txt",
          Effect.sync(() => holding),
        ),
      )
      yield* third
      // One turn of the event loop: if the queue let the next call through, its work has run by now.
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
      Deferred.doneUnsafe(release, Effect.void)
      yield* Fiber.join(holder)
      expect(yield* Fiber.join(next)).toBe(false)
    }),
  ))

test("tool-apply-patch: a move between two paths to one file through a symlinked directory changes the file and keeps it", () =>
  run(
    Effect.gen(function* () {
      const patch = [
        "*** Begin Patch",
        "*** Update File: linked/app.ts",
        "*** Move to: real/app.ts",
        "@@",
        "-const b = 2",
        "+const b = 3",
        "*** End Patch",
      ].join("\n")
      const chat = yield* openChat({
        tools: [createApplyPatchTool()],
        responses: [
          fauxAssistantMessage(fauxToolCall("apply_patch", { patch }), { stopReason: "toolUse" }),
          fauxAssistantMessage("done"),
        ],
      })
      const at = (path: string) => join(chat.workspace, path)
      mkdirSync(at("real"))
      symlinkSync(at("real"), at("linked"))
      writeFileSync(at("real/app.ts"), "const b = 2\n")
      yield* chat.ask("patch it")
      const [applied] = yield* chat.toolResults()
      expect(resultText(applied!)).toBe("Success. Updated the following files:\nM real/app.ts")
      expect(readFileSync(at("real/app.ts"), "utf8")).toBe("const b = 3\n")
    }),
  ))
