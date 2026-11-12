// The TUI: the real TUI in a PTY on an @xterm/headless screen, typed into, against a real server.
import { afterEach, expect, test } from "bun:test"
import { readFileSync, rmSync, watch } from "node:fs"
import { join } from "node:path"
import type { ScriptStep } from "@nisse/models"
import type { AuthState } from "@nisse/protocol"
import { FakeOpenAi, signIn } from "./support/openai.ts"
import { deadline, RawClient } from "./support/raw.ts"
import { scriptEnv, runningServer, serving, settled, start, submit, watchView, tempHome } from "./support/server.ts"
import { png } from "./support/png.ts"
import { screenSession, stopServer } from "./support/terminal.ts"

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

type Home = ReturnType<typeof tempHome>
type Session = ReturnType<typeof screenSession>

/** The TUI, in `nisseHome`, whose server answers from `script` when the TUI starts it. */
const open = async (
  script: ReadonlyArray<ScriptStep> = [],
  args: Array<string> = [],
  nisseHome: Home = home(),
  extra: Record<string, string | undefined> = {},
) => screenSession(args, { ...(await scriptEnv(nisseHome, script)), ...extra })

const quit = async (session: Session) => {
  session.type("\x03")
  expect(await session.exited).toBe(0)
}

const call = (name: string, input: Record<string, unknown>, agent?: string): ScriptStep => ({
  tool: { name, input },
  ...(agent === undefined ? {} : { agent }),
})

/** The mouse wheel turned once over the transcript, as an SGR mouse report. */
const wheelUp = "\x1b[<64;20;5M"
const wheelDown = "\x1b[<65;20;5M"

/** Turns the wheel until `predicate` holds, waiting for each turn to show before the next. */
const scrollUntil = (wheel: string) => async (session: Session, predicate: (screen: string) => boolean) => {
  for (let turn = 0; turn < 400; turn++) {
    const before = session.screen()
    if (predicate(before)) return before
    session.type(wheel.repeat(5))
    // At an end, a turn changes nothing until a load or a commit does.
    await session.waitFor((screen) => screen !== before, 10_000)
  }
  throw new Error(`never scrolled to it:\n${session.screen()}`)
}
const scrollUpUntil = scrollUntil(wheelUp)
const scrollDownUntil = scrollUntil(wheelDown)

/** `count` prompts `prompt 1`.. answered `answer 1`.., each run settled before the next is sent. */
const converse = async (client: RawClient, conversation: string, count: number, from = 1) => {
  const view = watchView(client, conversation)
  for (let n = from; n < from + count; n++) {
    await submit(client, conversation, `prompt ${n}`)
    await view.until(settled(n - from + 1), 10_000)
  }
}

const answers = (count: number): Array<ScriptStep> =>
  Array.from({ length: count }, (_, n) => ({ text: `answer ${n + 1}` }))

test("answer-tui, answer-author: a person types a prompt, presses enter and reads the answer under their name", async () => {
  const session = await open([{ text: "hello ada" }])
  await session.waitFor((screen) => screen.includes("PROMPT") && screen.includes("READY"))
  session.type("hello nisse")
  await session.waitFor((screen) => screen.includes("hello nisse"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("hello ada") && screen.includes("READY"))
  expect(screen).toContain("ADA")
  expect(screen).toContain("NISSE")
  await quit(session)
})

test("answer-author: without USER the TUI names a person's message after the system's user name", async () => {
  const session = await open([{ text: "hello" }], [], home(), { USER: undefined })
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("who am i\r")
  const screen = await session.waitFor((screen) => screen.includes("hello") && screen.includes("READY"))
  // The system's user name, as a process without USER is told it.
  const { USER: _, ...withoutUser } = process.env
  const name = Bun.spawnSync(["bun", "-e", "console.log(require('node:os').userInfo().username)"], { env: withoutUser })
  expect(screen).toContain(name.stdout.toString().trim().toUpperCase())
  await quit(session)
})

test("answer-newline: alt+enter adds a line to the prompt, and enter sends every line as one message", async () => {
  const session = await open([{ text: "got both" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("line one")
  session.type("\x1b\r")
  session.type("line two")
  await session.waitFor((screen) => screen.includes("line one") && screen.includes("line two"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("got both") && screen.includes("READY"))
  const lines = screen.split("\n")
  const first = lines.findIndex((line) => line.includes("line one"))
  expect(lines[first + 1]).toContain("line two")
  expect(lines.findIndex((line) => line.includes("ADA"))).toBe(first - 1)
  await quit(session)
})

test("tui-hangup, idle-closed: closing the terminal ends nisse instead of leaving it running unseen", async () => {
  const session = await open()
  await session.waitFor((screen) => screen.includes("READY"))
  session.hangUp()
  await deadline(session.exited, 5000, "nisse exited")
})

test("reopen-hint, reopen-tui: quitting prints the command that reopens the conversation, and it opens with its transcript", async () => {
  const nisseHome = home()
  const first = await open([{ text: "I remember" }], [], nisseHome)
  await first.waitFor((screen) => screen.includes("READY"))
  first.type("remember me\r")
  await first.waitFor((screen) => screen.includes("I remember") && screen.includes("READY"))
  await quit(first)
  const id = first.output().match(/nisse --conversation (\w+)/)?.[1]
  expect(id).toBeDefined()
  const second = await open([], ["--conversation", id!], nisseHome)
  const screen = await second.waitFor((screen) => screen.includes("I remember") && screen.includes("READY"))
  expect(screen).toContain("remember me")
  await quit(second)
})

test("start-with-id: a launcher opens nisse on an id it chose with a first prompt, and that id reopens the conversation", async () => {
  const nisseHome = home()
  const first = await open(
    [{ text: "You said: first words" }],
    ["--conversation", "chosen-by-attn", "first words"],
    nisseHome,
  )
  await first.waitFor((screen) => screen.includes("You said: first words") && screen.includes("READY"))
  await quit(first)
  expect(first.output()).toContain("nisse --conversation chosen-by-attn")
  const second = await open([], ["--conversation", "chosen-by-attn"], nisseHome)
  const screen = await second.waitFor((screen) => screen.includes("You said: first words") && screen.includes("READY"))
  expect(screen.split("You said: first words").length).toBe(2)
  await quit(second)
})

test("interrupt-tui: escape stops nisse mid-answer and the answer shows it was interrupted", async () => {
  const session = await open([{ text: "one two three four five six seven eight nine ten", delayMs: 300 }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("count\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("one"))
  session.type("\x1b")
  const screen = await session.waitFor((screen) => screen.includes("interrupted") && screen.includes("READY"))
  expect(screen).not.toContain("ten")
  await quit(session)
})

test("queue-show: a prompt sent while nisse works waits in the queue, then runs", async () => {
  const session = await open([{ text: "slow one two three", delayMs: 300 }, { text: "fast reply" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("first\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("QUEUE"))
  session.type("second\r")
  await session.waitFor((screen) => screen.includes("queued · second"))
  const screen = await session.waitFor((screen) => screen.includes("fast reply"))
  expect(screen).not.toContain("queued · second")
  await quit(session)
})

test("approval-ask, approval-allow-tui: nisse asks before a command runs, ctrl+y allows it and its output shows under the call", async () => {
  const session = await open([call("bash", { command: "echo hello-from-bash" }), { text: "all done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("run it\r")
  await session.waitFor(
    (screen) =>
      screen.includes("▸ bash(echo hello-from-bash)") &&
      screen.includes("allow this call?") &&
      screen.includes("WAITING"),
  )
  session.type("\x19")
  const screen = await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  expect(screen.indexOf("✓ allowed by ada")).toBeGreaterThan(screen.indexOf("▸ bash(echo hello-from-bash)"))
  expect(screen.indexOf("     hello-from-bash")).toBeGreaterThan(screen.indexOf("✓ allowed by ada"))
  expect(screen).not.toContain("allow this call?")
  await quit(session)
})

test("approval-ask, codemode-nested-policy: a script's call that waits for a person shows its command under the script before ctrl+y allows it", async () => {
  const code = 'await tools.bash({ command: "echo nested-hello" })'
  const session = await open([call("codemode", { code }), { text: "all done" }], ["--model", "script-code-mode"])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("run it\r")
  const asking = await session.waitFor((screen) => screen.includes("WAITING") && screen.includes("allow this call?"))
  expect(asking.indexOf("▸ bash(echo nested-hello)")).toBeGreaterThan(asking.indexOf("▸ codemode"))
  expect(asking.indexOf("allow this call?")).toBeGreaterThan(asking.indexOf("▸ bash(echo nested-hello)"))
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  await quit(session)
})

test("approval-deny-tui: ctrl+n denies a call, the denial shows as its result and the run goes on", async () => {
  const session = await open([call("bash", { command: "echo never-ran" }), { text: "carrying on" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("run it\r")
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("\x0e")
  const screen = await session.waitFor((screen) => screen.includes("carrying on") && screen.includes("READY"))
  expect(screen.indexOf("✗ denied by ada")).toBeGreaterThan(screen.indexOf("▸ bash(echo never-ran)"))
  expect(screen).not.toContain("     never-ran")
  expect(screen).not.toContain("allow this call?")
  await quit(session)
})

test("steer-toggle, steer-show: tab switches a prompt sent mid-run from queueing to steering, and the steer shows until it lands", async () => {
  const session = await open([call("bash", { command: "sleep 1" }), { text: "turning left now" }], ["--auto"])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("drive\r")
  await session.waitFor((screen) => screen.includes("▸ bash(sleep 1)") && screen.includes("QUEUE · tab"))
  session.type("\t")
  await session.waitFor((screen) => screen.includes("STEER · tab"))
  session.type("turn left\r")
  await session.waitFor((screen) => screen.includes("steering · turn left"))
  const screen = await session.waitFor((screen) => screen.includes("turning left now") && screen.includes("READY"))
  expect(screen.indexOf("turn left")).toBeLessThan(screen.indexOf("turning left now"))
  expect(screen).not.toContain("steering ·")
  await quit(session)
})

test("signin-status: the splash lists every provider and how it is signed in", async () => {
  const session = await open()
  const screen = await session.waitFor(
    (screen) => screen.includes("person@example.com · Claude Max") && screen.includes("signed out"),
  )
  expect(screen).toMatch(/● claude +person@example\.com · Claude Max/)
  expect(screen).toMatch(/○ openai +signed out/)
  expect(screen).toContain("^L  sign in")
  await quit(session)
})

test("model-list, model-status: /model lists every provider's models, enter switches the conversation's model, and the status bar names it", async () => {
  const session = await open([], ["--provider", "claude"])
  await session.waitFor((screen) => screen.includes("READY") && screen.includes("claude  nisse"))
  session.type("/model\r")
  await session.waitFor((screen) => screen.includes("claude · Sonnet") && screen.includes("openai · GPT-5.5"))
  // The picker opens on the conversation's model, Claude's own choice; Sonnet is the next row.
  session.type("\x1b[B")
  session.type("\x1b[C")
  await session.waitFor((screen) => screen.includes("claude · Sonnet ‹ low ›"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("◆ ada switched to claude · sonnet · low"))
  expect(screen).not.toContain("claude · Sonnet ‹")
  expect(screen).toContain("claude · sonnet · low  nisse")
  await quit(session)
}, 20_000)

const signInFixture = join(import.meta.dir, "../../../fixtures/claude/terminal_sign_in.ndjson")

test("signin-terminal: ^L signs in to a signed-out Claude by running its own sign-in in the terminal", async () => {
  const session = await open([], [], home(), { FAKE_CLAUDE_FIXTURE: signInFixture })
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  session.type("\x0c")
  const screen = await session.waitFor((screen) => /● claude +person@example\.com · Claude Max/.test(screen), 30_000)
  expect(session.output()).toContain("fake claude auth login done")
  expect(screen).not.toContain("SIGN IN")
  await quit(session)
}, 40_000)

test("signin-cancel: a sign-in cancelled from another connection stops Claude's sign-in in the terminal", async () => {
  const nisseHome = home()
  const session = await open([], [], nisseHome, { FAKE_CLAUDE_FIXTURE: signInFixture, FAKE_CLAUDE_AUTH_WAITS: "1" })
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

test("signin-shared: an open TUI shows a sign-in another connection finished", async () => {
  const nisseHome = home()
  const session = await open([], [], nisseHome, { FAKE_CLAUDE_FIXTURE: signInFixture })
  await session.waitFor((screen) => /○ claude +signed out/.test(screen))
  const other = await RawClient.connect(nisseHome.socket)
  const auth = other.watch<AuthState>("auth/watch")
  const started = (await other.call("auth/start", { provider: "claude" })).result as AuthState
  await auth.until((states) => states.some((state) => state.phase === "waiting"))
  // Answered the moment the waiting state shows, as a fast client does.
  const answered = await other.call("auth/respond", {
    provider: "claude",
    flow: started.flow,
    response: { _tag: "terminal_exited", success: true },
  })
  expect(answered.result).toEqual({ accepted: true })
  await auth.until((states) => states.at(-1)?.phase === "succeeded", 30_000)
  other.close()
  await session.waitFor((screen) => /● claude +person@example\.com · Claude Max/.test(screen))
  await quit(session)
}, 40_000)

test("subagent-card: a subagent shows as a card under its parent, and ctrl+y answers the call it asks about", async () => {
  const session = await open([
    call("spawn_agent", { task_name: "scribe", message: "write it down", fork_turns: "none" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { text: "the scribe is done" },
    call("bash", { command: "echo scribbled" }, "/root/scribe"),
    { agent: "/root/scribe", text: "wrote it" },
  ])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  await session.waitFor(
    (screen) =>
      screen.includes("⧉ scribe") &&
      screen.includes("waiting on you") &&
      screen.includes("allow bash(echo scribbled)?"),
  )
  session.type("\x19")
  const screen = await session.waitFor(
    (screen) => screen.includes("the scribe is done") && screen.includes("READY") && /⧉ scribe +done/.test(screen),
  )
  // The subagent's answer, mailed to its parent, reads as what it said under its name.
  const lines = screen.split("\n")
  expect(lines[lines.findIndex((line) => line.includes("/root/scribe")) + 1]).toContain("wrote it")
  expect(screen).not.toContain("Payload:")
  await quit(session)
}, 30_000)

test("subagent-card, codemode-nested-policy: a subagent a script started shows as a card under the script, and ctrl+y answers the call it asks about", async () => {
  const spawn = 'await tools.spawn_agent({ task_name: "scribe", message: "write it down", fork_turns: "none" })'
  const session = await open(
    [
      call("codemode", { code: `${spawn}\nawait tools.wait_agent({ timeout_ms: 600000 })` }),
      { text: "the scribe is done" },
      call("codemode", { code: 'await tools.bash({ command: "echo scribbled" })' }, "/root/scribe"),
      { agent: "/root/scribe", text: "wrote it" },
    ],
    ["--model", "script-code-mode"],
  )
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  const asking = await session.waitFor(
    (screen) => /⧉ scribe +waiting on you/.test(screen) && screen.includes("allow bash(echo scribbled)?"),
  )
  expect(asking.indexOf("⧉ scribe")).toBeGreaterThan(asking.indexOf("▸ codemode"))
  session.type("\x19")
  await session.waitFor(
    (screen) => screen.includes("the scribe is done") && screen.includes("READY") && /⧉ scribe +done/.test(screen),
  )
  await quit(session)
})

test("subagent-approve: a call a subagent's subagent asks about shows on the card above it, and ctrl+y answers it", async () => {
  const nisseHome = home()
  await Bun.write(join(nisseHome.dir, "config.toml"), "[agents]\nmax_depth = 2\n")
  const session = await open(
    [
      call("spawn_agent", { task_name: "lead", message: "delegate further", fork_turns: "none" }),
      call("wait_agent", { timeout_ms: 600_000 }),
      { text: "the lead is done" },
      call("spawn_agent", { task_name: "deep", message: "dig", fork_turns: "none" }, "/root/lead"),
      call("wait_agent", { timeout_ms: 600_000 }, "/root/lead"),
      { agent: "/root/lead", text: "deep reported" },
      call("bash", { command: "echo dug" }, "/root/lead/deep"),
      { agent: "/root/lead/deep", text: "dug it" },
    ],
    [],
    nisseHome,
  )
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("delegate\r")
  await session.waitFor((screen) => /⧉ lead +waiting on you/.test(screen) && screen.includes("allow bash(echo dug)?"))
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("the lead is done") && screen.includes("READY"))
  await quit(session)
}, 30_000)

test("subagent-card: a Claude subagent shows as a card in place of its call's result, and its own screen sends input to its parent", async () => {
  const nisseHome = home()
  const extra = { FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../fixtures/claude/subagent.ndjson") }
  const parent = await open([], ["--provider", "claude"], nisseHome, extra)
  await parent.waitFor((screen) => screen.includes("READY"))
  parent.type("go\r")
  const screen = await parent.waitFor(
    (screen) =>
      /⧉ Find gnome location in notes \(general-purpose\) +done/.test(screen) &&
      screen.includes("Under the floor.") &&
      screen.includes("READY"),
    20_000,
  )
  expect(screen).not.toContain("Subagent hand-back")
  expect(screen.match(/⧉/g)).toHaveLength(1)
  await quit(parent)

  const client = await RawClient.connect(nisseHome.socket)
  const listed = (await client.call("conversation/list")).result as Array<{ id: string; lineage?: unknown }>
  client.close()
  const child = listed.find((conversation) => conversation.lineage !== undefined)!
  const own = await open([], ["--conversation", child.id], nisseHome, extra)
  const opened = await own.waitFor((screen) => screen.includes("INPUT GOES THROUGH ITS PARENT"))
  expect(opened).toContain("the gnome lives under the floor")
  await quit(own)
}, 40_000)

test("status-line, toast, extensions-failed: a person sees what extensions say in the footer and the transcript, and which failed to load", async () => {
  const nisseHome = home()
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
  const session = await open(
    [call("read", { path: join(nisseHome.dir, "config.toml") }), { text: "read it" }],
    [],
    nisseHome,
  )
  await session.waitFor((screen) => screen.includes("extension broken failed to load") && screen.includes("READY"))
  session.type("read the config\r")
  const screen = await session.waitFor((screen) => screen.includes("read it") && screen.includes("READY"))
  expect(screen).toContain("◆ watch: suite ran")
  expect(screen.split("\n").at(-1)).toContain("watch: tests green")
  await quit(session)
})

test("skills-tui: a message that names a skill shows which skills came with it, also after a reopen", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  const nisseHome = home()
  await Bun.write(
    join(nisseHome.dir, "skills", "ship", "SKILL.md"),
    "---\nname: ship\ndescription: Ship it\n---\nShip.",
  )
  await using _server = await runningServer([], { home: nisseHome, openai: fake.options() })
  await signIn(nisseHome)
  const first = await open([], ["--provider", "openai", "--conversation", "shipping"], nisseHome)
  await first.waitFor((screen) => screen.includes("READY"))
  first.type("$ship it now\r")
  await first.waitFor((screen) => screen.includes("Hello there") && screen.includes("READY"))
  const lines = first.screen().split("\n")
  expect(lines[lines.findIndex((line) => line.includes("$ship it now")) + 1]).toContain("with ship")
  await quit(first)
  const second = await open([], ["--conversation", "shipping"], nisseHome)
  const reopened = await second.waitFor((screen) => screen.includes("Hello there"))
  expect(reopened).toContain("with ship")
  await quit(second)
})

test("image-attach: a dragged image's pasted path shows on the prompt as attached, and the model receives the image with the message", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  const nisseHome = home()
  const path = join(nisseHome.dir, "Screen Shot.png")
  await Bun.write(path, png(3, 2))
  await using _server = await runningServer([], { home: nisseHome, openai: fake.options() })
  await signIn(nisseHome)
  const session = await open([], ["--provider", "openai"], nisseHome)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("what is this? ")
  // A terminal pastes a file dropped on it as its path, with spaces escaped.
  session.type(`\x1b[200~${path.replaceAll(" ", "\\ ")}\x1b[201~`)
  await session.waitFor((screen) => screen.includes("attaching Screen Shot.png"))
  session.type("\r")
  await session.waitFor((screen) => screen.includes("Hello there") && screen.includes("READY"))
  const lines = session.screen().split("\n")
  expect(lines[lines.findIndex((line) => line.includes("ADA")) + 2]).toContain("with Screen Shot.png")
  expect(session.screen()).not.toContain("attaching")
  const input = JSON.parse(fake.responses()[0]!.body).input as Array<{ role?: string; content?: Array<any> }>
  const content = input.find((item) => item.role === "user")!.content!
  expect(content.map((part) => part.type)).toEqual(["input_text", "input_image"])
  expect(content[1].image_url).toBe(`data:image/png;base64,${Buffer.from(png(3, 2)).toString("base64")}`)
  await quit(session)
})

test("image-attach: an image the server cannot decode is refused on screen by name, and nothing is sent", async () => {
  const nisseHome = home()
  // Its header says PNG, so the prompt attaches it; its pixels are cut off.
  await Bun.write(join(nisseHome.dir, "cut.png"), png(4, 4).subarray(0, 40))
  const session = await open([{ text: "never" }], [], nisseHome)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type(`look ${join(nisseHome.dir, "cut.png")}`)
  await session.waitFor((screen) => screen.includes("attaching cut.png"))
  session.type("\r")
  const screen = await session.waitFor((screen) => screen.includes("✗ cut.png (image/png) cannot be decoded"))
  expect(screen).not.toContain("ADA")
  await quit(session)
})

test("crash-tui: the open TUI finishes the answer after the server is killed mid-answer", async () => {
  const nisseHome = home()
  const env = await scriptEnv(nisseHome, [{ text: "one two three four five six seven eight nine ten", delayMs: 100 }])
  const server = await serving(env)
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("count\r")
  await session.waitFor((screen) => screen.includes("WORKING") && screen.includes("one two"))
  server.kill("SIGKILL")
  await server.exited
  // The TUI brings a server back; the run picks up where it was cut off and answers once.
  const screen = await session.waitFor(
    (screen) => screen.includes("one two three four five six seven eight nine ten") && screen.includes("READY"),
    20_000,
  )
  expect(screen).not.toContain("missing messages")
  await quit(session)
}, 30_000)

test("crash-tui: quitting while the server cannot come back ends nisse, though a typed prompt waits to be sent", async () => {
  const nisseHome = home()
  const env = await scriptEnv(nisseHome, [])
  const server = await serving(env)
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  // Every server the TUI starts now refuses this config, so the prompt is sent again and again while the TUI waits.
  await Bun.write(join(nisseHome.dir, "config.toml"), "[extensions.guard\n")
  server.kill("SIGKILL")
  await server.exited
  session.type("never sent\r")
  await quit(session)
}, 30_000)

test("server-cannot-start: an open TUI whose server cannot start shows why, starts one at most once a second, and carries on once it can", async () => {
  const nisseHome = home()
  const env = await scriptEnv(nisseHome, [{ text: "back again" }])
  const server = await serving(env)
  const session = screenSession([], env)
  await session.waitFor((screen) => screen.includes("READY"))
  const config = join(nisseHome.dir, "config.toml")
  await Bun.write(config, "[extensions.guard\n")
  server.kill("SIGKILL")
  await server.exited
  await session.waitFor(
    (screen) => screen.includes("nisse's server cannot start") && screen.includes("TOML Parse error"),
    10_000,
  )
  // Each server the TUI starts writes its refusal to the home's log as it exits, and the TUI waits a second after it
  // before starting the next: the gap between two refusals is more than that second.
  const refusals = () => readFileSync(nisseHome.log, "utf8").split("TOML Parse error").length - 1
  const watcher = watch(nisseHome.dir)
  const seen: Array<{ readonly count: number; readonly at: number }> = []
  await deadline(
    new Promise<void>((resolve) => {
      const check = () => {
        const count = refusals()
        if (count !== seen.at(-1)?.count) seen.push({ count, at: performance.now() })
        if (seen.length >= 3) resolve()
      }
      watcher.on("change", check)
      check()
    }),
    10_000,
    "three refusals in the home's log",
  ).finally(() => watcher.close())
  expect(seen.map(({ count }) => count - seen[0]!.count)).toEqual([0, 1, 2])
  expect(seen[2]!.at - seen[1]!.at).toBeGreaterThan(900)
  // A prompt typed now clears the notice, which comes back while the server still refuses; the prompt waits.
  session.type("hi\r")
  await session.waitFor((screen) => !screen.includes("cannot start"))
  await session.waitFor((screen) => screen.includes("cannot start"), 5_000)
  // The config fixed, the next server starts, the notice goes and the prompt is answered.
  rmSync(config)
  await session.waitFor(
    (screen) => screen.includes("back again") && screen.includes("READY") && !screen.includes("cannot start"),
    10_000,
  )
  await quit(session)
}, 40_000)

test("idle-tui: the TUI draws nothing and uses no CPU while nothing changes", async () => {
  const session = await open([{ text: "done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("hi\r")
  await session.waitFor((screen) => screen.includes("done") && screen.includes("READY"))
  // The second after an answer still settles, so the measure starts after it.
  await Bun.sleep(1000)
  const drawn = session.output().length
  const before = cpuSeconds(session.pid)
  await Bun.sleep(3000)
  expect(session.output().length).toBe(drawn)
  // Drawing nothing is the promise; CPU only catches heavy work that draws nothing. Bun's GC runs in bursts
  // after an answer: these 3 s measured 0-2 hundredths locally and 10 on a macOS CI runner. Idle wakeups cost
  // less than that noise (a 30 fps render loop 3-6, a 1 ms timer 2), so 50 is a tripwire for a spin or a
  // relayout on every frame, not for timers.
  expect(Math.round((cpuSeconds(session.pid) - before) * 100)).toBeLessThanOrEqual(50)
  await quit(session)
}, 20_000)

test("answer-scroll, tui-load-earlier: a conversation longer than the window scrolls back to its first message, loading earlier entries on the way, and a reconnect leaves no gap", async () => {
  const nisseHome = home()
  const env = await scriptEnv(nisseHome, answers(41))
  const server = await serving(env)
  const client = await RawClient.connect(nisseHome.socket)
  const conversation = await start(client, nisseHome.dir)
  // 40 runs of three entries each: more than the window's 50 newest, and than twice that.
  await converse(client, conversation, 40)
  client.close()

  const session = screenSession(["--conversation", conversation], env)
  await session.waitFor((screen) => screen.includes("answer 40") && screen.includes("READY"))
  expect(session.screen()).not.toContain("answer 1\n")
  const top = await scrollUpUntil(session, (screen) => /^ +prompt 1 *$/m.test(screen))
  expect(top).not.toContain("earlier messages")
  // Eighty speaker bars, and no warning about listeners printed over the screen.
  expect(session.output()).not.toContain("MaxListeners")
  expect(top).toMatch(/^ +answer 1 *$/m)

  // The server goes away. A prompt typed now waits for the server the TUI brings back, where the TUI watches again
  // from the newest entry it holds.
  server.kill("SIGKILL")
  await server.exited
  // The server the TUI brings back plays its script from the start.
  await Bun.write(join(nisseHome.dir, "script.json"), JSON.stringify([{ text: "answer 41" }]))
  session.type("prompt 41\r")
  await scrollDownUntil(session, (screen) => screen.includes("answer 41"))
  await session.waitFor((screen) => screen.includes("answer 41") && screen.includes("READY"), 20_000)
  const back = await scrollUpUntil(session, (screen) => /^ +prompt 1 *$/m.test(screen))
  expect(back).not.toContain("missing messages")
  await quit(session)
}, 120_000)

test("tui-fill-gap: a TUI that fell behind marks where entries are missing, and loads them once scrolled to", async () => {
  const nisseHome = home()
  await using _server = await runningServer(answers(45), { home: nisseHome, connectionQueue: 16 })
  const client = await RawClient.connect(nisseHome.socket)
  const conversation = await start(client, nisseHome.dir)
  await converse(client, conversation, 2)
  const session = await open([], ["--conversation", conversation], nisseHome)
  await session.waitFor((screen) => screen.includes("answer 2") && screen.includes("READY"))
  // A frozen TUI reads nothing; its watch falls behind while 40 more runs commit, more than a window holds.
  session.pause()
  await converse(client, conversation, 40, 3)
  session.resume()
  await session.waitFor((screen) => screen.includes("answer 42") && screen.includes("READY"), 20_000)
  await scrollUpUntil(session, (screen) => screen.includes("missing messages") || /^ +answer 3 *$/m.test(screen))
  const filled = await scrollUpUntil(session, (screen) => /^ +answer 2 *$/m.test(screen))
  expect(filled).not.toContain("missing messages")
  expect(filled).toMatch(/^ +prompt 3 *$/m)
  client.close()
  await quit(session)
}, 120_000)

/** A process's CPU time in seconds, user and system, to the hundredth. */
const cpuSeconds = (pid: number) => {
  if (process.platform === "linux") {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")
    return (Number(fields[11]) + Number(fields[12])) / 100
  }
  const out = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)])
    .stdout.toString()
    .trim()
  const [minutes, seconds] = out.split(":")
  return Number(minutes) * 60 + Number(seconds)
}

/** The TUI on the conversation `talk`, and a raw client of its server for what is slow to type. */
const openTalk = async (script: ReadonlyArray<ScriptStep>) => {
  const nisseHome = home()
  const session = await open(script, ["--conversation", "talk"], nisseHome)
  await session.waitFor((screen) => screen.includes("READY"))
  const client = await RawClient.connect(nisseHome.socket)
  return { session, client }
}

const ask = async (session: Session, prompt: string, answer: string) => {
  session.type(`${prompt}\r`)
  await session.waitFor((screen) => screen.includes(answer) && screen.includes("READY"))
}

test("fork-rpc: /fork moves the screen to a new conversation that goes on from before the last prompt", async () => {
  const session = await open([{ text: "answer one" }, { text: "answer two" }, { text: "another way" }])
  await session.waitFor((screen) => screen.includes("READY"))
  await ask(session, "prompt one", "answer one")
  await ask(session, "prompt two", "answer two")
  const before = session.screen().split("\n")[0]!
  session.type("/fork\r")
  const forked = await session.waitFor(
    (screen) => screen.split("\n")[0] !== before && screen.includes("answer one") && screen.includes("READY"),
  )
  expect(forked).not.toContain("answer two")
  await ask(session, "prompt three", "another way")
  await quit(session)
})

test("reset-rpc, reset-handoff: /reset draws a new context with its handoff, and the conversation goes on after it", async () => {
  const session = await open([{ text: "answer one" }])
  await session.waitFor((screen) => screen.includes("READY"))
  await ask(session, "prompt one", "answer one")
  session.type("/reset we were counting sheep\r")
  const screen = await session.waitFor((screen) => screen.includes("started a new context"))
  expect(screen).toContain("we were counting sheep")
  // With no step left the script repeats the newest user text it was sent.
  await ask(session, "go on", "You said: go on")
  await quit(session)
})

test("compact-rpc, compaction-live-status: /compact says when there is nothing to compact, shows a compaction running, and why one failed", async () => {
  // Past the 20,000 tokens a summary keeps by default, so the run before it is summarized.
  const long = "word ".repeat(20_000)
  const { session, client } = await openTalk([
    { text: "answer one" },
    { text: "answer two" },
    { text: "the summary of it all", delayMs: 300 },
    { text: "answer three" },
    { fail: "the summary model is gone" },
  ])
  session.type("/compact\r")
  await session.waitFor((screen) => screen.includes("nothing to compact"))
  const view = watchView(client, "talk")
  for (const runs of [1, 2]) {
    await submit(client, "talk", long)
    await view.until(settled(runs), 10_000)
  }
  session.type("/compact keep the numbers\r")
  await session.waitFor((screen) => screen.includes("◆ compacting"))
  await session.waitFor((screen) => screen.includes("compacted the context") && !screen.includes("◆ compacting"))
  await submit(client, "talk", long)
  await view.until(settled(3), 10_000)
  session.type("/compact\r")
  await session.waitFor((screen) => /compaction failed: .*the summary model is gone/.test(screen))
  client.close()
  await quit(session)
})

test("continue-rpc: /continue goes on after a failed run with no new input, and says why when there is nothing to go on with", async () => {
  const session = await open([{ fail: "provider went away" }, { text: "back on it" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("/continue\r")
  await session.waitFor((screen) => screen.includes("no run has ended here yet"))
  session.type("hi\r")
  await session.waitFor((screen) => screen.includes("provider went away") && screen.includes("READY"))
  session.type("/continue\r")
  await session.waitFor((screen) => screen.includes("back on it") && screen.includes("READY"))
  await quit(session)
})

test("withdraw-rpc: /withdraw takes back the queued prompt before it runs", async () => {
  const session = await open([call("bash", { command: "echo hi" }), { text: "all done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("first\r")
  // The run waits on its approval, so "second" waits in the queue.
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("second\r")
  await session.waitFor((screen) => screen.includes("queued · second"))
  session.type("/withdraw\r")
  await session.waitFor((screen) => screen.includes("withdrew: second") && !screen.includes("queued · second"))
  session.type("\x19")
  const screen = await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  expect(screen).not.toContain("You said: second")
  await quit(session)
})

test("configure-rpc, run-turn-limit: /instructions and /max-turns show who changed what, and a looping run ends naming the limit", async () => {
  const echo = call("bash", { command: "echo again" })
  const session = await open([echo, echo], ["--auto"])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("/instructions answer in French\r")
  await session.waitFor((screen) => screen.includes("set the instructions: answer in French"))
  session.type("/max-turns 1\r")
  await session.waitFor((screen) => screen.includes("set the turn limit to 1 turn"))
  session.type("/max-turns zero\r")
  await session.waitFor((screen) => screen.includes("max turns takes a whole number 1 or more, got zero"))
  session.type("loop\r")
  await session.waitFor((screen) => screen.includes("✗ reached the turn limit of 1 turn") && screen.includes("READY"))
  await quit(session)
})

test("usage-rpc, usage-context-live: the status bar counts tokens and the context, and /usage lists them by model", async () => {
  const { session, client } = await openTalk([
    { text: "answer one", usage: { input: 1200, output: 300 } },
    { text: "answer two", usage: { input: 2000, output: 500 } },
  ])
  await converse(client, "talk", 1)
  await session.waitFor((screen) => screen.includes("1.5k tokens · context 1.5k"))
  await converse(client, "talk", 1, 2)
  await session.waitFor((screen) => screen.includes("4.0k tokens · context 2.5k"))
  session.type("/usage\r")
  const screen = await session.waitFor((screen) => screen.includes("USAGE") && screen.includes("every conversation"))
  expect(screen).toContain("this conversation: 4.0k tokens")
  expect(screen).toContain("script/script  4.0k (3.2k in, 800 out)")
  session.type("\x1b")
  await session.waitFor((screen) => !screen.includes("USAGE") && screen.includes("answer two"))
  client.close()
  await quit(session)
})

test("task-graph-rpc: /tasks lists the work running now, and it empties once the work is done", async () => {
  const session = await open([call("bash", { command: "echo hi" }), { text: "all done" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("check\r")
  await session.waitFor((screen) => screen.includes("allow this call?"))
  session.type("/tasks\r")
  const screen = await session.waitFor((screen) => screen.includes("TASKS") && screen.includes("pi.tool"))
  expect(screen).toContain("pi.generation")
  session.type("\x19")
  await session.waitFor((screen) => screen.includes("nothing is running"))
  session.type("\x1b")
  await session.waitFor((screen) => screen.includes("all done") && screen.includes("READY"))
  await quit(session)
})

test("run-retry-live: the status bar counts down a provider's retry, and escape stops it", async () => {
  const session = await open([{ fail: "503 service unavailable" }])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("hi\r")
  await session.waitFor((screen) => /retrying in \d+s · .*503/.test(screen))
  session.type("\x1b")
  await session.waitFor((screen) => screen.includes("interrupted") && screen.includes("READY"))
  await quit(session)
})

test("commands-help: /help lists every command with what it does, and escape goes back", async () => {
  const session = await open([])
  await session.waitFor((screen) => screen.includes("READY"))
  session.type("/help\r")
  const screen = await session.waitFor((screen) => screen.includes("COMMANDS"))
  for (const command of ["/fork", "/reset", "/compact", "/continue", "/withdraw", "/instructions", "/max-turns"])
    expect(screen).toContain(command)
  session.type("\x1b")
  await session.waitFor((screen) => !screen.includes("COMMANDS"))
  await quit(session)
})

test("serve-read-only: under nisse serve --read-only the TUI shows a conversation and runs commands, but keeps a typed message unsent and says why", async () => {
  const nisseHome = home()
  const first = await open([{ text: "answer one" }], ["--conversation", "talk"], nisseHome)
  await first.waitFor((screen) => screen.includes("READY"))
  await ask(first, "prompt one", "answer one")
  await quit(first)
  // Replaces the server the first TUI started, once it stops.
  const env = await scriptEnv(nisseHome, [])
  const viewer = await serving(env, undefined, ["serve", "--read-only", "--restart"])
  const session = screenSession(["--conversation", "talk"], env)
  await session.waitFor((screen) => screen.includes("READ ONLY") && screen.includes("answer one"))
  session.type("/help\r")
  await session.waitFor((screen) => screen.includes("COMMANDS"))
  session.type("\x1b")
  await session.waitFor((screen) => !screen.includes("COMMANDS"))
  session.type("prompt two\r")
  const refused = await session.waitFor((screen) => screen.includes("read-only and sends nothing"))
  // Still in the prompt, not in the transcript.
  expect(refused).toMatch(/❯ prompt two/)
  await quit(session)
  viewer.kill()
  await viewer.exited
})

test("server-restart, serve-read-only: an open TUI keeps drawing while nisse serve --restart replaces its server, read-only and back", async () => {
  const nisseHome = home()
  const session = await open([{ text: "answer one" }], ["--conversation", "talk"], nisseHome)
  await session.waitFor((screen) => screen.includes("READY"))
  await ask(session, "prompt one", "answer one")
  // Replaces the server the TUI started; the TUI now shows a read-only home.
  const env = await scriptEnv(nisseHome, [])
  const viewer = await serving(env, undefined, ["serve", "--read-only", "--restart"])
  await session.waitFor((screen) => screen.includes("READ ONLY"))
  session.type("held back\r")
  await session.waitFor((screen) => screen.includes("read-only and sends nothing"))
  // And back to a server that writes: the TUI takes input again, with no read-only warning left, and draws what it
  // sends.
  const writer = await serving(env, undefined, ["serve", "--restart"])
  await viewer.exited
  await session.waitFor(
    (screen) => !screen.includes("READ ONLY") && !screen.includes("sends nothing") && screen.includes("PROMPT"),
  )
  session.type("\x15")
  await ask(session, "prompt two", "You said: prompt two")
  expect(session.screen()).toContain("answer one")
  await quit(session)
  writer.kill()
  await writer.exited
})
