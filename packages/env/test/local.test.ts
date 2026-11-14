import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { LocalExecutionEnv } from "@sigma/env/local"
import { Deferred, Effect, Fiber } from "effect"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function env(): LocalExecutionEnv {
  const cwd = mkdtempSync(join("/tmp", "sigma-env-"))
  dirs.push(cwd)
  return new LocalExecutionEnv({ cwd })
}

/** A zombie has exited and only waits to be reaped by its parent, which for a grandchild is not this process. */
function alive(pid: number): boolean {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim()
  return stat !== "" && !stat.startsWith("Z")
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

// Written after the spill started and before the interrupt, so only a spill flushed and ended before the interrupt
// returns can hold all of it.
const SPILLED_BYTES = 2_000_000

test("env-shell: an interrupted command's spill file holds all its output once the interrupt returns", async () => {
  const local = env()
  const script = `process.stdout.write("a".repeat(${SPILLED_BYTES}) + "END"); setTimeout(() => {}, 60000)`
  const spill = await Effect.runPromise(
    Effect.gen(function* () {
      const written = yield* Deferred.make<void>()
      let path: string | undefined
      let tail = ""
      const fiber = yield* Effect.forkChild(
        local.exec([process.execPath, "-e", script], {
          spill: { afterBytes: 10, afterLines: 10 },
          onSpill: (spillPath) => {
            path = spillPath
          },
          onOutput: (text) => {
            tail = (tail + text).slice(-3)
            if (tail === "END") Deferred.doneUnsafe(written, Effect.void)
          },
        }),
      )
      yield* Deferred.await(written)
      yield* Fiber.interrupt(fiber)
      return path!
    }),
  )
  dirs.push(join(spill, ".."))
  expect(Bun.file(spill).size).toBe(SPILLED_BYTES + 3)
})

test("env-shell: a caller's onSpill that throws fails the command with callback_error", async () => {
  const local = env()
  const error = await Effect.runPromise(
    Effect.flip(
      local.exec("printf 12345678901234567890", {
        spill: { afterBytes: 5, afterLines: 100 },
        onSpill: (path) => {
          dirs.push(join(path, ".."))
          throw new Error("onSpill failed")
        },
      }),
    ),
  )
  expect(error).toMatchObject({ code: "callback_error", message: "onSpill failed" })
})
