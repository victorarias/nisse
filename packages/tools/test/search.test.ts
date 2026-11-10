// `grep` and `glob` through a real Harness, in a git work tree and in a plain directory.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fauxAssistantMessage, fauxToolCall } from "@nisse/models/faux"
import { Effect } from "effect"
import { createGlobTool, createGrepTool } from "../src/index.ts"
import { type Chat, openChat, removeDirectories, resultText, run } from "./support.ts"

afterEach(removeDirectories)

const calls = (...calls: [string, Record<string, unknown>][]) => [
  ...calls.map(([name, args]) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" })),
  fauxAssistantMessage("done"),
]

/** `src/a.ts`, `src/b.md`, an ignored `build/out.ts` and a binary `logo.bin`, each mentioning `needle`. */
const files = (chat: Chat) => {
  const at = (path: string) => join(chat.workspace, path)
  mkdirSync(at("src"))
  mkdirSync(at("build"))
  writeFileSync(at("src/a.ts"), "const needle = 1\nconst other = 2\nexport { needle }\n")
  writeFileSync(at("src/b.md"), "# Needle\n")
  writeFileSync(at("build/out.ts"), "needle\n")
  writeFileSync(at("logo.bin"), new Uint8Array([0, 110, 101, 101, 100, 108, 101]))
  writeFileSync(at(".gitignore"), "build/\n")
  utimesSync(at("src/a.ts"), 1_000, 1_000)
  utimesSync(at("src/b.md"), 2_000, 2_000)
  return at
}

const git = (cwd: string) => {
  const done = Bun.spawnSync(["git", "init", "-q"], { cwd })
  if (done.exitCode !== 0) throw new Error(`git init failed: ${done.stderr}`)
}

test("tool-grep: grep finds matching lines by path and line, skipping binary and git-ignored files, and honours its options", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createGrepTool()],
        responses: calls(
          ["grep", { pattern: "needle" }],
          ["grep", { pattern: "needle", case_insensitive: true, glob: "*.md" }],
          ["grep", { pattern: "needle", path: "src" }],
          ["grep", { pattern: "(" }],
          ["grep", { pattern: "x", path: "nowhere" }],
        ),
      })
      files(chat)
      git(chat.workspace)
      yield* chat.ask("search")
      const results = yield* chat.toolResults()
      expect(results.map(resultText)).toEqual([
        "src/a.ts:1:const needle = 1\nsrc/a.ts:3:export { needle }",
        "src/b.md:1:# Needle",
        "src/a.ts:1:const needle = 1\nsrc/a.ts:3:export { needle }",
        "bad pattern: Invalid regular expression: missing )",
        "nowhere does not exist",
      ])
      expect(results.map((result) => result.isError)).toEqual([false, false, false, true, true])
    }),
  ))

test("tool-glob: glob lists matching files newest first, outside git skipping hidden names, inside git skipping ignored files", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createGlobTool()],
        responses: [
          ...calls(
            ["glob", { pattern: "**/*.ts" }],
            ["glob", { pattern: "*.md", path: "src" }],
            ["glob", { pattern: "*.rs" }],
          ),
          ...calls(["glob", { pattern: "**/*.ts" }]),
        ],
      })
      const at = files(chat)
      writeFileSync(at(".hidden.ts"), "")
      yield* chat.ask("list")
      expect((yield* chat.toolResults()).map(resultText)).toEqual([
        "build/out.ts\nsrc/a.ts",
        "src/b.md",
        "No files found.",
      ])
      git(chat.workspace)
      yield* chat.ask("list again, now in git")
      expect(resultText((yield* chat.toolResults()).at(-1)!)).toBe(".hidden.ts\nsrc/a.ts")
    }),
  ))
