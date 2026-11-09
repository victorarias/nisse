import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { LocalExecutionEnv } from "@nisse/env/local"
import { Deferred, Effect, Fiber } from "effect"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function env(): LocalExecutionEnv {
  const cwd = mkdtempSync(join("/tmp", "nisse-env-"))
  dirs.push(cwd)
  return new LocalExecutionEnv({ cwd })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The join rule (F6): a fiber interrupted while it runs a command must not outlive the command's processes, or a
// cancelled tool call would leave work running behind the run that cancelled it.
test("env-shell: interrupting a command returns only once its process and its children are gone", async () => {
  const local = env()
  const pids = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<number[]>()
      let output = ""
      const fiber = yield* Effect.forkChild(
        local.exec("sleep 60 & echo $$ $!; wait", {
          onOutput: (text) => {
            output += text
            if (output.includes("\n"))
              Deferred.doneUnsafe(started, Effect.succeed(output.trim().split(" ").map(Number)))
          },
        }),
      )
      const pids = yield* Deferred.await(started)
      expect(pids.every(alive)).toBe(true)
      yield* Fiber.interrupt(fiber)
      return pids
    }),
  )
  expect(pids.filter(alive)).toEqual([])
})

test("env-shell: an interrupted command still names its spill file", async () => {
  const local = env()
  const spill = await Effect.runPromise(
    Effect.gen(function* () {
      const spilled = yield* Deferred.make<string>()
      const fiber = yield* Effect.forkChild(
        local.exec("printf 12345678901234567890; sleep 60", {
          spill: { afterBytes: 10, afterLines: 10 },
          onSpill: (path) => Deferred.doneUnsafe(spilled, Effect.succeed(path)),
        }),
      )
      const path = yield* Deferred.await(spilled)
      yield* Fiber.interrupt(fiber)
      return path
    }),
  )
  dirs.push(join(spill, ".."))
  expect(await Bun.file(spill).text()).toBe("12345678901234567890")
})
