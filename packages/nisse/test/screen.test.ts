import { afterEach, expect, test } from "bun:test"
import { readFileSync, rmSync, watch } from "node:fs"
import { join } from "node:path"
import type { AuthState } from "@nisse/protocol"
import { deadline, RawClient } from "./support/raw.ts"
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

test("a launcher opens nisse on an id it chose with a first prompt, and that id reopens the conversation", async () => {
  const nisseHome = home()
  const first = screenSession(["--conversation", "chosen-by-attn", "first words"], nisseEnv(nisseHome))
  await first.waitFor((screen) => screen.includes("You said: first words"))
  first.type("\x03")
  await first.exited
  expect(first.output()).toContain("nisse --conversation chosen-by-attn")
  const second = screenSession(["--conversation", "chosen-by-attn"], nisseEnv(nisseHome))
  const screen = await second.waitFor((screen) => screen.includes("You said: first words") && screen.includes("READY"))
  expect(screen.split("You said: first words").length).toBe(2)
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

test("a sign-in cancelled from another connection stops Claude's sign-in in the terminal", async () => {
  const nisseHome = home()
  const session = screenSession(
    [],
    nisseEnv(nisseHome, {
      FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../fixtures/claude/terminal_sign_in.ndjson"),
      FAKE_CLAUDE_AUTH_WAITS: "1",
    }),
  )
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  session.type("\x0c")
  await session.waitFor((screen) => screen.includes("fake claude auth login waiting"))
  const other = await RawClient.connect(nisseHome.socket)
  const auth = other.watch<AuthState>("auth/watch")
  await auth.until((states) => states.some((state) => state.phase === "waiting"))
  const waiting = auth.items.find((state) => state.phase === "waiting")!
  await other.call("auth/cancel", { provider: "claude", flow: waiting.flow })
  other.close()

  await session.waitFor(
    (screen) => /○ claude +signed out/.test(screen) && !screen.includes("SIGN IN") && screen.includes("READY"),
  )
  const fakeDir = join(nisseHome.dir, "fake-claude")
  const ended = () => readFileSync(join(fakeDir, "log.ndjson"), "utf8").includes('"authEnded":"SIGTERM"')
  const watcher = watch(fakeDir)
  await deadline(
    new Promise<void>((resolve) => {
      const check = () => ended() && resolve()
      watcher.on("change", check)
      check()
    }),
    5000,
    "the sign-in in the terminal ended",
  ).finally(() => watcher.close())
  session.type("\x03")
  await session.exited
}, 40_000)

test("an open TUI shows a sign-in another connection finished", async () => {
  const nisseHome = home()
  const session = screenSession(
    [],
    nisseEnv(nisseHome, {
      FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../fixtures/claude/terminal_sign_in.ndjson"),
    }),
  )
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  const other = await RawClient.connect(nisseHome.socket)
  const auth = other.watch<AuthState>("auth/watch")
  const started = (await other.call("auth/start", { provider: "claude" })).result as AuthState
  await auth.until((states) => states.some((state) => state.phase === "waiting"))
  await other.call("auth/respond", {
    provider: "claude",
    flow: started.flow,
    response: { _tag: "terminal_exited", success: true },
  })
  await auth.until((states) => states.at(-1)?.phase === "succeeded", 30_000)
  other.close()

  await session.waitFor((screen) => /● claude +person@example\.com · Claude Max/.test(screen))
  session.type("\x03")
  await session.exited
}, 40_000)

test("nisse login hands what the person types to Claude's own sign-in", async () => {
  const nisseHome = home()
  const session = screenSession(
    ["login", "claude"],
    nisseEnv(nisseHome, {
      FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../fixtures/claude/terminal_sign_in.ndjson"),
      FAKE_CLAUDE_AUTH_ASKS: "1",
    }),
  )
  await session.waitFor((screen) => screen.includes("fake claude asks for a code"))
  session.type("the-code\r")
  await session.waitFor((screen) => screen.includes("signed in to claude"), 30_000)
  expect(await session.exited).toBe(0)
  expect(readFileSync(join(nisseHome.dir, "fake-claude", "log.ndjson"), "utf8")).toContain('"authAnswer":"the-code"')
}, 40_000)

test("a subagent shows as a card under its parent, and ctrl+y answers the call it asks about", async () => {
  const nisseHome = home()
  const env = await scripted(nisseHome, [
    { tool: { name: "spawn_agent", input: { task_name: "scribe", message: "write it down" } } },
    { tool: { name: "wait_agent", input: { timeout_ms: 600_000 } } },
    { text: "the scribe is done" },
    { agent: "/root/scribe", tool: { name: "Bash", input: { command: "echo scribbled" } } },
    { agent: "/root/scribe", text: "wrote it" },
  ])
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  await session.waitFor(
    (screen) =>
      screen.includes("⧉ scribe") &&
      screen.includes("waiting on you") &&
      screen.includes("allow Bash(echo scribbled)?"),
  )
  session.type("\x19")
  const screen = await session.waitFor(
    (screen) => screen.includes("the scribe is done") && screen.includes("READY") && /⧉ scribe +done/.test(screen),
  )
  expect(screen).toContain("/root/scribe")
  expect(screen).toContain("wrote it")
  session.type("\x03")
  await session.exited
})

test("a call a subagent's subagent asks about shows on the card above it, and ctrl+y answers it", async () => {
  const nisseHome = home()
  await Bun.write(join(nisseHome.dir, "config.toml"), "[agents]\nmax_depth = 2\n")
  const env = await scripted(nisseHome, [
    { tool: { name: "spawn_agent", input: { task_name: "lead", message: "delegate further" } } },
    { tool: { name: "wait_agent", input: { timeout_ms: 600_000 } } },
    { text: "the lead is done" },
    { agent: "/root/lead", tool: { name: "spawn_agent", input: { task_name: "deep", message: "dig" } } },
    { agent: "/root/lead", tool: { name: "wait_agent", input: { timeout_ms: 600_000 } } },
    { agent: "/root/lead", text: "deep reported" },
    { agent: "/root/lead/deep", tool: { name: "Bash", input: { command: "echo dug" } } },
    { agent: "/root/lead/deep", text: "dug it" },
  ])
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  await session.waitFor((screen) => /⧉ lead +waiting on you/.test(screen) && screen.includes("allow Bash(echo dug)?"))
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("the lead is done") && screen.includes("READY"))
  session.type("\x03")
  await session.exited
}, 30_000)

test("a Claude subagent shows as a card in place of its call's result, and its own screen sends input to its parent", async () => {
  const nisseHome = home()
  const env = nisseEnv(nisseHome, {
    FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../fixtures/claude/subagent.ndjson"),
  })
  const parent = screenSession(["--provider", "claude"], env)
  await parent.waitFor((screen) => screen.includes("READY"))
  parent.type("go\r")
  const screen = await parent.waitFor(
    (screen) =>
      /⧉ Find gnome location in notes \(general-purpose\) +done/.test(screen) &&
      screen.includes("Under the floor.") &&
      screen.includes("READY"),
  )
  expect(screen).not.toContain("Subagent hand-back")
  parent.type("\x03")
  await parent.exited

  const client = await RawClient.connect(nisseHome.socket)
  const listed = (await client.call("conversation/list")).result as Array<{ id: string; lineage?: unknown }>
  client.close()
  const child = listed.find((conversation) => conversation.lineage !== undefined)!
  const own = screenSession(["--conversation", child.id], env)
  const opened = await own.waitFor((screen) => screen.includes("INPUT GOES THROUGH ITS PARENT"))
  expect(opened).toContain("the gnome lives under the floor")
  own.type("\x03")
  await own.exited
}, 40_000)

test("a person sees what extensions say in the footer and the transcript, and which failed to load", async () => {
  const nisseHome = home()
  const script = `${nisseHome.dir}/script.json`
  await Bun.write(
    script,
    JSON.stringify([{ tool: { name: "Read", input: { file_path: script } } }, { text: "read it" }]),
  )
  await Bun.write(join(nisseHome.extensions, "broken.ts"), "export default 42")
  await Bun.write(
    join(nisseHome.extensions, "watch.ts"),
    `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.after", (call) =>
    Effect.andThen(call.conversation.status("tests green"), call.conversation.toast("suite ran")),
  ),
)`,
  )
  const session = screenSession([], nisseEnv(nisseHome, { NISSE_MODEL_SCRIPT: script }))
  await session.waitFor((screen) => screen.includes("extension broken failed to load") && screen.includes("READY"))
  session.type("read the script\r")
  const screen = await session.waitFor((screen) => screen.includes("read it") && screen.includes("READY"))
  expect(screen).toContain("◆ watch: suite ran")
  expect(screen.split("\n").at(-1)).toContain("watch: tests green")
  session.type("\x03")
  await session.exited
})
