import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tempHome } from "./support/server.ts"
import { nisseEnv, screenSession, stopServer } from "./support/terminal.ts"

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

test("a person types a prompt, presses enter and reads the answer under their name", async () => {
  const session = screenSession([], nisseEnv(home()))
  await session.waitFor((screen) => screen.includes("PROMPT") && screen.includes("READY"))
  session.type("hello nisse")
  await session.waitFor((screen) => screen.includes("hello nisse"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("You said: hello nisse"))
  expect(screen).toContain("ADA")
  expect(screen).toContain("NISSE")
  session.type("\x03")
  expect(await session.exited).toBe(0)
})

test("quitting prints the command that reopens the conversation", async () => {
  const nisseHome = home()
  const first = screenSession([], nisseEnv(nisseHome))
  await first.waitFor((screen) => screen.includes("READY"))
  first.type("remember me\r")
  await first.waitFor((screen) => screen.includes("You said: remember me"))
  first.type("\x03")
  await first.exited
  const id = first.output().match(/nisse --conversation (\w+)/)?.[1]
  expect(id).toBeDefined()
  const second = screenSession(["--conversation", id!], nisseEnv(nisseHome))
  await second.waitFor((screen) => screen.includes("You said: remember me"))
  second.type("\x03")
  await second.exited
})

test("escape stops nisse mid-answer and the answer shows it was interrupted", async () => {
  const nisseHome = home()
  const script = `${nisseHome.dir}/script.json`
  await Bun.write(script, JSON.stringify([{ text: "one two three four five six seven eight nine ten", delayMs: 300 }]))
  const session = screenSession([], nisseEnv(nisseHome, { NISSE_MODEL_SCRIPT: script }))
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("count\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("one"))
  session.type("\x1b")
  const screen = await session.waitFor((screen) => screen.includes("interrupted") && screen.includes("READY"))
  expect(screen).not.toContain("ten")
  session.type("\x03")
  await session.exited
})

test("a prompt sent while nisse works waits in the queue, then runs", async () => {
  const nisseHome = home()
  const script = `${nisseHome.dir}/script.json`
  await Bun.write(script, JSON.stringify([{ text: "slow one two three", delayMs: 300 }, { text: "fast reply" }]))
  const session = screenSession([], nisseEnv(nisseHome, { NISSE_MODEL_SCRIPT: script }))
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("first\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("QUEUE"))
  session.type("second\r")
  await session.waitFor((screen) => screen.includes("queued · second"))
  const screen = await session.waitFor((screen) => screen.includes("fast reply"))
  expect(screen).not.toContain("queued · second")
  session.type("\x03")
  await session.exited
})
