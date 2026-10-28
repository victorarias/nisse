import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { deadline } from "./support/raw.ts"
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

test("closing the terminal ends nisse instead of leaving it running unseen", async () => {
  const session = screenSession([], nisseEnv(home()))
  await session.waitFor((screen) => screen.includes("READY"))
  session.hangUp()
  await deadline(session.exited, 5000, "nisse exited")
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

const scripted = async (nisseHome: ReturnType<typeof tempHome>, steps: unknown) => {
  const script = `${nisseHome.dir}/script.json`
  await Bun.write(script, JSON.stringify(steps))
  return nisseEnv(nisseHome, { NISSE_MODEL_SCRIPT: script })
}

test("nisse asks before a command runs, ctrl+y allows it and its output shows under the call", async () => {
  const nisseHome = home()
  const env = await scripted(nisseHome, [
    { tool: { name: "Bash", input: { command: "echo hello-from-bash" } } },
    { text: "all done" },
  ])
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("run it\r")
  await session.waitFor(
    (screen) =>
      screen.includes("▸ Bash(echo hello-from-bash)") &&
      screen.includes("allow this call?") &&
      screen.includes("WAITING"),
  )
  session.type("\x19")
  const screen = await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  expect(screen.indexOf("✓ allowed by ada")).toBeGreaterThan(screen.indexOf("▸ Bash(echo hello-from-bash)"))
  expect(screen.indexOf("     hello-from-bash")).toBeGreaterThan(screen.indexOf("✓ allowed by ada"))
  expect(screen).not.toContain("allow this call?")
  session.type("\x03")
  await session.exited
})

test("tab switches a prompt sent mid-run from queueing to steering the run", async () => {
  const nisseHome = home()
  const env = await scripted(nisseHome, [
    { tool: { name: "Bash", input: { command: "sleep 1" } } },
    { text: "turning left now" },
  ])
  const session = screenSession(["--auto"], env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("drive\r")
  await session.waitFor((screen) => screen.includes("▸ Bash(sleep 1)") && screen.includes("QUEUE · tab"))
  session.type("\t")
  await session.waitFor((screen) => screen.includes("STEER · tab"))
  session.type("turn left\r")
  await session.waitFor((screen) => screen.includes("steering · turn left"))
  const screen = await session.waitFor((screen) => screen.includes("turning left now") && screen.includes("READY"))
  expect(screen.indexOf("turn left")).toBeLessThan(screen.indexOf("turning left now"))
  expect(screen).not.toContain("steering ·")
  session.type("\x03")
  await session.exited
})

test("the splash lists every provider and how it is signed in", async () => {
  const session = screenSession([], nisseEnv(home()))
  const screen = await session.waitFor(
    (screen) => screen.includes("person@example.com · Claude Max") && screen.includes("signed out"),
  )
  expect(screen).toMatch(/● claude +person@example\.com · Claude Max/)
  expect(screen).toMatch(/○ openai +signed out/)
  expect(screen).toContain("^L  sign in")
  session.type("\x03")
  await session.exited
})

test("/model lists every provider's models, and enter switches the conversation's model for everyone", async () => {
  const session = screenSession([], nisseEnv(home()))
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("/model\r")
  await session.waitFor((screen) => screen.includes("claude · Sonnet") && screen.includes("openai · GPT-5.5"))
  session.type("\x1b[B")
  session.type("\x1b[B")
  session.type("\x1b[C")
  await session.waitFor((screen) => screen.includes("claude · Sonnet ‹ low ›"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("◆ ada switched to claude · sonnet · low"))
  expect(screen).not.toContain("claude · Sonnet ‹")
  expect(screen).toContain("claude · sonnet · low  nisse")
  session.type("\x03")
  await session.exited
}, 20_000)

test("^L signs in to a signed-out Claude by running its own sign-in in the terminal", async () => {
  const nisseHome = home()
  const session = screenSession(
    [],
    nisseEnv(nisseHome, {
      FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../fixtures/claude/terminal_sign_in.ndjson"),
    }),
  )
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  session.type("\x0c")
  const screen = await session.waitFor((screen) => /● claude +person@example\.com · Claude Max/.test(screen), 30_000)
  expect(session.output()).toContain("fake claude auth login done")
  expect(screen).not.toContain("SIGN IN")
  session.type("\x03")
  await session.exited
}, 40_000)
