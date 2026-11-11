import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import type { ScriptStep } from "@nisse/models"
import { tempHome } from "../support/server.ts"
import { screenSession, stopServer } from "../support/terminal.ts"
import { kernelEnv } from "../support/kernel.ts"

const homes: Array<ReturnType<typeof tempHome>> = []
const home = () => {
  const created = tempHome()
  homes.push(created)
  return created
}

afterEach(async () => {
  for (const created of homes.splice(0)) {
    await stopServer(created)
    rmSync(created.dir, { recursive: true, force: true })
  }
})

/** The TUI on the kernel, in a fresh home whose server answers from `script`. */
const open = async (script: ReadonlyArray<ScriptStep> = [], args: Array<string> = [], nisseHome = home()) =>
  screenSession(args, await kernelEnv(nisseHome, script))

test("answer-tui: a person types a prompt, presses enter and reads the answer under their name", async () => {
  const session = await open([{ text: "hello ada" }])
  await session.waitFor((screen) => screen.includes("PROMPT") && screen.includes("READY"))
  session.type("hello nisse")
  await session.waitFor((screen) => screen.includes("hello nisse"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("hello ada") && screen.includes("READY"))
  expect(screen).toContain("ADA")
  expect(screen).toContain("NISSE")
  session.type("\x03")
  expect(await session.exited).toBe(0)
})
