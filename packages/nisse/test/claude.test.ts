// Claude Code: a real server in process, driven as a raw JSON-RPC client, with
// Claude Code played by the fake `claude` replaying a recorded process per spawn.
import { expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { FakeClaude } from "./support/claude.ts"
import {
  type AuthState,
  type EntryRecord,
  type ProviderModels,
  type ProviderSnapshot,
  STATUS_LINES_KIND,
  TOAST_KIND,
  USER_KIND,
} from "@nisse/protocol"
import { homeWithExtensions } from "./support/extensions.ts"
import { deadline, RawClient } from "./support/raw.ts"
import {
  runEnds,
  runningServer,
  servingUntilIdle,
  settled,
  submit,
  tempHome,
  transcript,
  type ViewWatch,
  watchView,
  type ServerOptions,
} from "./support/server.ts"

type Approvals = { requests: Record<string, { tool: string }> }
const approvalsOf = (watch: ViewWatch) => watch.view().docs["nisse.approvals"] as Approvals | undefined
const waitingApproval = async (watch: ViewWatch) => {
  await watch.until((current) => Object.keys(approvalsOf(current)?.requests ?? {}).length > 0)
  return Object.keys(approvalsOf(watch)!.requests)[0]!
}
const results = (entries: ReadonlyArray<EntryRecord>) =>
  entries
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => {
      const message = entry.model![0] as { content: Array<{ text?: string }>; isError: boolean; toolCallId: string }
      return {
        call: message.toolCallId,
        text: message.content.map((b) => b.text ?? "").join(""),
        isError: message.isError,
      }
    })
const calls = (entries: ReadonlyArray<EntryRecord>) =>
  entries.flatMap((entry) =>
    entry.kind === "pi.assistant"
      ? (
          entry.model![0] as { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }
        ).content
          .filter((block) => block.type === "toolCall")
          .map((block) => ({ id: block.id!, name: block.name!, arguments: block.arguments }))
      : [],
  )

const conversationWith = async (claude: FakeClaude, ask: Record<string, string> = {}, options: ServerOptions = {}) => {
  const server = await runningServer([], { ...options, claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", { cwd: server.home.dir, provider: "claude", approvals: "ask", ...ask })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await view.until(() => true)
  return {
    server,
    client,
    conversation,
    view,
    submit: (text: string, steer = false) => submit(client, conversation, text, crypto.randomUUID(), "ada", steer),
    answer: async (allow: boolean, watch?: ViewWatch, on = conversation) => {
      const approval = await waitingApproval(watch ?? view)
      await client.call("approval/resolve", { conversation: on, approval, author: "ada", allow })
    },
    [Symbol.asyncDispose]: async () => {
      client.close()
      await server[Symbol.asyncDispose]()
    },
  }
}

test("claude-answer, provider-claude: Claude's answer through Claude Code is committed as nisse's message", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude)
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  expect(transcript(session.view.view().entries)).toEqual([
    "user: Reply with exactly: fixture text ok",
    "assistant: fixture text ok",
    "run_end: answered",
  ])
  expect(claude.userTexts()).toEqual([["Reply with exactly: fixture text ok"]])
})

test("claude-system-prompt: Claude Code keeps its own system prompt, adds the conversation's instructions, and its commands know the conversation", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude, { instructions: "Report with attn when done." })
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  const initialize = claude.log().find((entry) => entry.initialize)?.initialize
  expect(initialize.systemPrompt).toBeUndefined()
  expect(initialize.appendSystemPrompt).toBe("Report with attn when done.")
  expect(claude.log().find((entry) => entry.argv)?.rootConversation).toBe(session.conversation)
})

test("claude-approval: a command Claude wants to run waits for a person, and Claude Code hears the answer", async () => {
  for (const [fixture, allow, reply] of [
    ["bash_allowed", true, "made"],
    ["bash_declined", false, "declined"],
  ] as const) {
    using claude = new FakeClaude(fixture)
    await using session = await conversationWith(claude)
    await session.submit("Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made")
    const approval = await waitingApproval(session.view)
    expect(approvalsOf(session.view)!.requests[approval]).toMatchObject({ tool: "Bash" })
    await session.answer(allow)
    await session.view.until(settled(1))
    expect(claude.permissionAnswers()).toEqual([
      expect.objectContaining(
        allow ? { behavior: "allow" } : { behavior: "deny", message: "the person did not allow this call" },
      ),
    ])
    const entries = session.view.seen()
    expect(calls(entries).map((call) => call.name)).toEqual(["Bash"])
    expect(results(entries)).toHaveLength(1)
    expect(entries.filter((entry) => entry.kind === "nisse.approval").map((entry) => entry.data)).toEqual([
      expect.objectContaining({ approval, author: "ada", allow }),
    ])
    expect(approvalsOf(session.view)!.requests).toEqual({})
    expect(transcript(entries).slice(-2)).toEqual([`assistant: ${reply}`, "run_end: answered"])
  }
})

test("claude-read: Claude reads files without asking and the read shows as a call and its result", async () => {
  using claude = new FakeClaude("read")
  await using session = await conversationWith(claude)
  await session.submit("read it")
  await session.view.until(settled(1))
  expect(claude.permissionAnswers()).toEqual([])
  const entries = session.view.seen()
  expect(entries.map((entry) => entry.kind)).toEqual([
    "nisse.user",
    "pi.assistant",
    "pi.tool-result",
    "pi.assistant",
    "nisse.run_end",
  ])
  expect(calls(entries)).toMatchObject([{ name: "Read" }])
  expect(results(entries)).toEqual([
    expect.objectContaining({ text: "1\tthe gnome lives under the floor\n2\t", isError: false }),
  ])
})

test("claude-resume, claude-live: a Claude Code process that exits while it waits for the next run is replaced by one that resumes where nisse's transcript ends", async () => {
  using claude = new FakeClaude("died_while_idle")
  await using session = await conversationWith(claude)
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  process.kill(claude.pids()[0]!, "SIGKILL")
  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(2))
  const [first, second] = claude.spawns()
  expect(second).toMatchObject({
    "--resume": first!["--session-id"],
    "--resume-session-at": "190a62a3-be35-438c-961e-f0de63b6ca5c",
  })
  expect(claude.userTexts(1)).toEqual([["Which word did I ask you to remember? Reply with that word only."]])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: PLUM", "run_end: answered"])
})

/** The recording's first process lost its session after it answered: its process is gone, so the next run resumes. */
const sessionLost = async (claude: FakeClaude, options: ServerOptions = {}) => {
  const session = await conversationWith(claude, {}, options)
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  process.kill(claude.pids()[0]!, "SIGKILL")
  return session
}

test("claude-session-gone: when Claude Code lost the session, a fresh one is given the conversation so far", async () => {
  using claude = new FakeClaude("session_gone")
  await using session = await sessionLost(claude)
  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(2))
  expect(claude.spawns()[2]!["--resume"]).toBeUndefined()
  expect(claude.userTexts(2)).toEqual([
    [
      "This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.",
      "Remember the word PLUM. Reply with exactly: noted",
      "You answered: noted",
      "Which word did I ask you to remember? Reply with that word only.",
    ],
  ])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: PLUM", "run_end: answered"])
  expect(runEnds(session.view.seen()).map((end) => end.outcome)).toEqual(["answered", "answered"])
})

test("claude-live: the next run reaches the Claude Code process that served the last one, told only its prompt, and what the process spent counts once", async () => {
  using claude = new FakeClaude("session_gone")
  await using session = await sessionLost(claude)
  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(2))
  await session.submit("Now reply with that word in lowercase.")
  await session.view.until(settled(3))
  // The third run went to the fresh process the second one started.
  expect(claude.spawns()).toHaveLength(3)
  expect(claude.userTexts(2).at(-1)).toEqual(["Now reply with that word in lowercase."])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: plum", "run_end: answered"])
  // The first process's totals and the second's last ones: the second process's first result is inside its last.
  const usage = session.view.view().docs["pi.usage"] as { models: Record<string, Record<string, number>> }
  expect(usage.models["claude/claude-haiku-5-5"]).toMatchObject({
    input: 2 + 4,
    output: 4 + 10,
    cacheRead: 16_112 + 37_850,
    cacheWrite: 9_309 + 13_157,
  })
})

const startClaude = async (client: RawClient, cwd: string) =>
  (await client.call("conversation/start", { cwd, provider: "claude" })).result.conversation as string

test("claude-idle-release: a live Claude Code process closes after the idle period, and the next run resumes its session", async () => {
  using claude = new FakeClaude("died_while_idle")
  await using session = await conversationWith(claude, {}, { claudeIdle: "50 millis" })
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  await claude.logged((fake) => fake.exited(0))
  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(2))
  const [first, second] = claude.spawns()
  expect(second!["--resume"]).toBe(first!["--session-id"])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: PLUM", "run_end: answered"])
})

/** A clock for the live Claude Code processes that moves only when the test moves it. */
const testClock = () => Effect.runPromise(Effect.scoped(TestClock.make()))
const advance = (clock: TestClock.TestClock, by: Duration.Input) => Effect.runPromise(clock.adjust(by))
/** Who submitted each input of the conversation, and what. */
const inputs = (entries: ReadonlyArray<EntryRecord>) =>
  entries
    .filter((entry) => entry.kind === USER_KIND)
    .map((entry) => `${(entry.data as { author: string }).author}: ${transcript([entry])[0]!.slice("user: ".length)}`)

test("claude-idle-compaction: an idle Claude conversation past 200,000 tokens compacts once, two minutes before its prompt cache expires, then its process closes", async () => {
  // The recording's runs report a context of about 230,000 tokens and write the 1-hour cache.
  using claude = new FakeClaude("idle_compaction")
  const clock = await testClock()
  await using session = await conversationWith(claude, { approvals: "auto" }, { claudeClock: clock })
  await session.submit("Reply with exactly: one")
  await session.view.until(settled(1))
  // Past the 30 minutes a process waits for its next run: one that waits to compact stays live.
  await advance(clock, "57 minutes")
  await session.submit("Reply with exactly: two")
  await session.view.until(settled(2))
  // The first run's compaction was due at 58 minutes; the second run moved it to 58 minutes after itself.
  await advance(clock, "57 minutes")
  await session.client.call("conversation/list", {})
  expect(claude.userTexts(0)).toHaveLength(2)
  await advance(clock, "1 minute")
  await session.view.until(settled(3))
  await claude.logged((fake) => fake.exited(0))
  expect(claude.spawns()).toHaveLength(1)
  expect(claude.userTexts(0)).toEqual([["Reply with exactly: one"], ["Reply with exactly: two"], ["/compact"]])
  expect(inputs(session.view.seen())).toEqual([
    "ada: Reply with exactly: one",
    "ada: Reply with exactly: two",
    "nisse: /compact",
  ])
  expect(session.view.seen().filter((entry) => entry.kind === "pi.compaction")).toHaveLength(1)
  expect(runEnds(session.view.seen()).map((end) => end.outcome)).toEqual(["answered", "answered", "answered"])
})

test("claude-idle-compaction: a conversation whose last request wrote the 5-minute cache compacts three minutes into its pause", async () => {
  // Recorded under a sign-in Claude Code gives the 5-minute cache, as it does an API key.
  using claude = new FakeClaude("idle_compaction_5m")
  const clock = await testClock()
  await using session = await conversationWith(claude, { approvals: "auto" }, { claudeClock: clock })
  await session.submit("Reply with exactly: one")
  await session.view.until(settled(1))
  await advance(clock, "3 minutes")
  await session.view.until(settled(2))
  await claude.logged((fake) => fake.exited(0))
  expect(inputs(session.view.seen())).toEqual(["ada: Reply with exactly: one", "nisse: /compact"])
  expect(session.view.seen().filter((entry) => entry.kind === "pi.compaction")).toHaveLength(1)
})

test("claude-idle-compaction, claude-idle-release: a short context, or claude_idle_compaction = false, closes after the idle period without compacting", async () => {
  for (const [fixture, config] of [
    ["text", {}],
    ["idle_compaction", { claude_idle_compaction: false }],
  ] as const) {
    using claude = new FakeClaude(fixture)
    const clock = await testClock()
    await using session = await conversationWith(claude, { approvals: "auto" }, { claudeClock: clock, config })
    await session.submit(fixture === "text" ? "Reply with exactly: fixture text ok" : "Reply with exactly: one")
    await session.view.until(settled(1))
    await advance(clock, "1 hour")
    await claude.logged((fake) => fake.exited(0))
    // A compaction would have reached the process before it closed.
    expect(claude.userTexts(0)).toHaveLength(1)
    expect(inputs(session.view.seen())).toHaveLength(1)
  }
})

test("server-idle-exit, claude-idle-release: a live Claude Code process keeps the server up after its client leaves, until the process closes", async () => {
  using claude = new FakeClaude("text")
  const home = tempHome()
  const served = await servingUntilIdle(home, "10 millis", [], { claude: claude.options, claudeIdle: "500 millis" })
  const client = await RawClient.connect(home.socket)
  const conversation = await startClaude(client, home.dir)
  await submit(client, conversation, "Reply with exactly: fixture text ok")
  const view = watchView(client, conversation)
  await view.until(settled(1))
  const answered = performance.now()
  client.close()
  await deadline(served.exited, 5000, "server exit")
  // Without the process's hold the server would have gone 10 ms after the client did, closing the process with it.
  expect(performance.now() - answered).toBeGreaterThanOrEqual(500)
  await claude.logged((fake) => fake.exited(0))
  rmSync(home.dir, { recursive: true, force: true })
})

test("server-stop, claude-live: stopping the server closes its live Claude Code processes at once", async () => {
  using claude = new FakeClaude("text")
  const home = tempHome()
  const served = await servingUntilIdle(home, "1 hour", [], { claude: claude.options })
  const client = await RawClient.connect(home.socket)
  const conversation = await startClaude(client, home.dir)
  await submit(client, conversation, "Reply with exactly: fixture text ok")
  await watchView(client, conversation).until(settled(1))
  expect(claude.exited(0)).toBe(false)
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  client.close()
  await deadline(served.exited, 5000, "server exit")
  // Long before the 30 minutes a live process waits.
  await claude.logged((fake) => fake.exited(0))
  rmSync(home.dir, { recursive: true, force: true })
})

test("queue-run: a prompt sent while Claude works runs once Claude answers, resuming the same session", async () => {
  using claude = new FakeClaude("bash_allowed", "text")
  // The recordings are one process each, so no process stays live for the queued run.
  await using session = await conversationWith(claude, {}, { claudeIdle: 0 })
  await session.submit("Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made")
  await waitingApproval(session.view)
  await session.submit("Reply with exactly: fixture text ok")
  await session.answer(true)
  await session.view.until(settled(2))
  expect(claude.spawns()[1]!["--resume"]).toBe(claude.spawns()[0]!["--session-id"])
  expect(claude.userTexts(1)).toEqual([["Reply with exactly: fixture text ok"]])
  expect(transcript(session.view.seen()).slice(-3)).toEqual([
    "user: Reply with exactly: fixture text ok",
    "assistant: fixture text ok",
    "run_end: answered",
  ])
})

test("claude-sign-in-error: a signed-out Claude Code fails the run with its own words", async () => {
  using claude = new FakeClaude("auth_failed")
  await using session = await conversationWith(claude)
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(transcript(session.view.seen())).toEqual([
    "user: hello",
    "run_end: failed (Invalid API key · Please run /login)",
  ])
})

test("claude-model: the conversation's model and effort reach Claude Code", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude, { model: "opus", effort: "high" })
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  expect(claude.spawns()[0]).toMatchObject({ "--model": "opus", "--effort": "high" })
})

test("claude-model, claude-live: a switch of model and effort reaches the live Claude Code process, and clearing the effort resumes the session in a new one", async () => {
  using claude = new FakeClaude("switch_model")
  await using session = await conversationWith(claude, { model: "haiku" })
  const select = (selection: Record<string, string>) =>
    session.client.call("conversation/select_model", {
      conversation: session.conversation,
      author: "ada",
      selection: { provider: "claude", ...selection },
    })
  await session.submit("Reply with exactly: one")
  await session.view.until(settled(1))
  expect((await select({ model: "sonnet", effort: "low" })).error).toBeUndefined()
  await session.submit("Reply with exactly: two")
  await session.view.until(settled(2))
  expect((await select({ model: "sonnet" })).error).toBeUndefined()
  await session.submit("What were your two previous replies? Reply with just them, separated by a comma.")
  await session.view.until(settled(3))

  const [first, second] = claude.spawns()
  expect(first).toMatchObject({ "--model": "haiku" })
  expect(first!["--effort"]).toBeUndefined()
  // The first process is switched before it is told the second prompt.
  const told = claude
    .log()
    .filter((entry) => entry.spawn === 0 && entry.received !== undefined)
    .map(({ received }) => received.request ?? received.message.content[0].text)
  expect(told).toEqual([
    "Reply with exactly: one",
    { subtype: "set_model", model: "sonnet" },
    { subtype: "apply_flag_settings", settings: { effortLevel: "low" } },
    "Reply with exactly: two",
  ])
  // Claude Code clears an effort to the model's default, not the person's, so a new process resumes the session.
  expect(second).toMatchObject({ "--model": "sonnet", "--resume": first!["--session-id"] })
  expect(second!["--effort"]).toBeUndefined()
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: one, two", "run_end: answered"])
})

test("steer-claude: a steer sent while Claude works reaches Claude Code in the same run", async () => {
  using claude = new FakeClaude("steer")
  await using session = await conversationWith(claude)
  await session.submit("Run the bash command `touch steered.txt` with the Bash tool, then reply with exactly: done")
  await waitingApproval(session.view)
  await session.submit("Also end your reply with the word BANANA.", true)
  await session.answer(true)
  await session.view.until(settled(1))
  expect(claude.userTexts()).toEqual([
    ["Run the bash command `touch steered.txt` with the Bash tool, then reply with exactly: done"],
    ["Also end your reply with the word BANANA."],
  ])
  const told = transcript(session.view.seen())
  expect(told.slice(-3)).toEqual(["assistant: done", "assistant: done BANANA", "run_end: answered"])
  expect(told.indexOf("user: Also end your reply with the word BANANA.")).toBeLessThan(told.indexOf("assistant: done"))
  expect(runEnds(session.view.seen())).toHaveLength(1)
})

test("steer-claude: two steers each reach Claude Code after the result of the call that was running", async () => {
  using claude = new FakeClaude("two_steers")
  await using session = await conversationWith(claude)
  await session.submit(
    "Run the bash command `touch one.txt` with the Bash tool, then, as a separate call, run `touch two.txt` with the Bash tool, then reply with exactly: done",
  )
  await waitingApproval(session.view)
  await session.submit("Also end your reply with the word BANANA.", true)
  await session.answer(true)
  await session.view.until(
    (watch) => calls(watch.seen()).length === 2 && Object.keys(approvalsOf(watch)?.requests ?? {}).length === 1,
  )
  await session.submit("And start your reply with the word CHERRY.", true)
  await session.answer(true)
  await session.view.until(settled(1))
  const steers = claude
    .log()
    .filter((entry) => entry.received?.type === "user" && entry.received.priority === "next" && entry.spawn === 0)
  expect(steers).toHaveLength(2)
  const kinds = session.view.seen().map((entry) => entry.kind)
  expect(kinds.filter((kind) => kind === "nisse.user")).toHaveLength(3)
  expect(runEnds(session.view.seen())).toEqual([expect.objectContaining({ outcome: "answered" })])
})

test("claude-cut-off: a run cut off by a server stop resumes, and Claude Code is told which call was cut off", async () => {
  using claude = new FakeClaude("resume_after_kill")
  const first = await conversationWith(claude)
  await first.submit(
    "Run the bash command `echo started > started.fifo && python3 -c 'import time; time.sleep(120)'` with the Bash tool. If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok",
  )
  await first.answer(true)
  await claude.logged((fake) => fake.permissionAnswers().length === 1)
  first.client.close()
  await first.server.stop()

  await using server = await runningServer([], { home: first.server.home, claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const view = watchView(client, first.conversation)
  await view.until(settled(1))
  const [call] = calls(view.seen())
  expect(claude.spawns()[1]).toMatchObject({ "--resume-session-at": "b2a87c3c-db3b-4459-9666-b8c4c38bc556" })
  expect(claude.userTexts(1)).toEqual([
    [`Your Bash call ${call!.id} was cut off: interrupted; it may or may not have taken effect`],
  ])
  expect(results(view.seen())).toEqual([
    { call: call!.id, text: "interrupted; it may or may not have taken effect", isError: true },
  ])
  expect(calls(view.seen())).toHaveLength(1)
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: resumed ok", "run_end: answered"])
  client.close()
}, 20_000)

test("claude-stop, claude-live: stopping a run mid-call interrupts Claude Code's turn, and the next prompt goes to the same process, told only that prompt", async () => {
  using claude = new FakeClaude("stop_keeps_process")
  await using session = await conversationWith(claude, { approvals: "auto" })
  await session.submit(
    "Run the bash command `echo started > started.txt && python3 -c 'import time; time.sleep(120)'` with the Bash tool. Then reply with exactly: slept",
  )
  // Claude Code is running the call once nisse answered its PreToolUse hook.
  await claude.logged((fake) => fake.log().some((entry) => entry.answered === "hook_callback"))
  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  const [call] = calls(session.view.seen())
  expect(results(session.view.seen())).toEqual([
    { call: call!.id, text: "interrupted; it may or may not have taken effect", isError: true },
  ])
  expect(runEnds(session.view.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
  expect(claude.log().some((entry) => entry.received?.request?.subtype === "interrupt")).toBe(true)

  await session.submit("Did your last Bash call finish? Reply with exactly one word: finished or interrupted")
  await session.view.until(settled(2))
  expect(claude.spawns()).toHaveLength(1)
  // Claude Code's session holds the stop, so nothing about the cut-off call is told again.
  expect(claude.userTexts(0).at(-1)).toEqual([
    "Did your last Bash call finish? Reply with exactly one word: finished or interrupted",
  ])
  expect(claude.exited(0)).toBe(false)
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: interrupted", "run_end: answered"])
})

test("claude-stop, claude-resume: a Claude Code process that does not end its turn after a stop is closed, and the next run resumes, told which call was cut off", async () => {
  // The recording's process never answers the interrupt: it went on until the server was killed.
  using claude = new FakeClaude("resume_after_kill")
  await using session = await conversationWith(claude, {}, { claudeStop: "100 millis" })
  await session.submit(
    "Run the bash command `echo started > started.fifo && python3 -c 'import time; time.sleep(120)'` with the Bash tool. If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok",
  )
  await session.answer(true)
  await claude.logged((fake) => fake.permissionAnswers().length === 1)
  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await claude.logged((fake) => fake.exited(0))

  await session.submit("Go on.")
  await session.view.until(settled(2))
  const [call] = calls(session.view.seen())
  expect(claude.spawns()[1]).toMatchObject({ "--resume": claude.spawns()[0]!["--session-id"] })
  expect(claude.userTexts(1)).toEqual([
    [`Your Bash call ${call!.id} was cut off: interrupted; it may or may not have taken effect`, "Go on."],
  ])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: resumed ok", "run_end: answered"])
})

test("claude-resume: a run that answered before the server stopped is not run again", async () => {
  using claude = new FakeClaude("crash_points")
  const first = await conversationWith(claude, { approvals: "auto" })
  await first.submit(
    "First write one short sentence saying that you will read the notes. Then use the Read tool to read notes.txt. Then reply with where the gnome lives, in three words.",
  )
  await first.view.until(settled(1))
  first.client.close()
  await first.server.stop()

  await using server = await runningServer([], { home: first.server.home, claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const view = watchView(client, first.conversation)
  await view.until(() => true)
  expect(transcript(view.view().entries)).toEqual([
    "user: First write one short sentence saying that you will read the notes. Then use the Read tool to read notes.txt. Then reply with where the gnome lives, in three words.",
    "assistant: I will read the notes.",
    "assistant: ",
    "assistant: Under the floor.",
    "run_end: answered",
  ])
  expect(claude.spawns()).toHaveLength(1)
  client.close()
})

test("claude-read: a skill Claude Code runs shows as its call and result, and Claude answers from it", async () => {
  using claude = new FakeClaude("skill")
  await using session = await conversationWith(claude)
  await session.submit("Use the Skill tool to run the gnome-facts skill, then do what it says.")
  await session.view.until(settled(1))
  expect(calls(session.view.seen())).toMatchObject([{ name: "Skill" }])
  expect(results(session.view.seen())).toHaveLength(1)
  expect(transcript(session.view.seen()).slice(-2)).toEqual([
    "assistant: the gnome lives under the floor",
    "run_end: answered",
  ])
})

const AGENT_CALL = "toolu_01DxmcUXKnbFWBQecJLTs1n3"

/** The conversation of the first subagent Claude started, from its entry in the parent. */
const subagentOf = async (session: Awaited<ReturnType<typeof conversationWith>>) => {
  await session.view.until((watch) => watch.seen().some((entry) => entry.kind === "nisse.subagent"))
  const entry = session.view.seen().find((entry) => entry.kind === "nisse.subagent")!
  const data = entry.data as { call: string; conversation: number; title: string; agentType?: string }
  const id = String(data.conversation)
  return { id, data, view: watchView(session.client, id) }
}

const childEnded = (watch: ViewWatch) => runEnds(watch.seen()).length > 0

test("subagent-claude: a Claude subagent works in a conversation of its own under the one that started it", async () => {
  using claude = new FakeClaude("subagent")
  await using session = await conversationWith(claude)
  await session.submit("go")
  await session.view.until(settled(1))
  const child = await subagentOf(session)
  await child.view.until(childEnded)

  expect(session.view.seen().map((entry) => entry.kind)).toEqual([
    "nisse.user",
    "pi.assistant",
    "nisse.subagent",
    "pi.tool-result",
    "pi.assistant",
    "nisse.run_end",
  ])
  expect(calls(session.view.seen())).toMatchObject([{ id: AGENT_CALL, name: "Agent" }])
  expect(child.data).toEqual({
    call: AGENT_CALL,
    conversation: Number(child.id),
    title: "Find gnome location in notes",
    agentType: "general-purpose",
  })
  const summary =
    "The gnome lives under the floor.\n\nThe exact line from `" +
    session.server.home.dir +
    "/notes.txt` (line 1) is: `the gnome lives under the floor`\n\nI did not modify any files."
  const told = transcript(child.view.seen())
  expect(told[0]).toStartWith("user: Read the file notes.txt using the Read tool.")
  expect(told.slice(1)).toEqual(["assistant: ", `assistant: ${summary}`, "run_end: answered"])
  expect(results(child.view.seen())).toEqual([
    expect.objectContaining({ text: "1\tthe gnome lives under the floor\n2\t", isError: false }),
  ])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: Under the floor.", "run_end: answered"])
})

test("subagent-claude: a call a Claude subagent wants to make waits for a person in the subagent's conversation", async () => {
  using claude = new FakeClaude("subagent_asks")
  await using session = await conversationWith(claude)
  await session.submit("go")
  const child = await subagentOf(session)
  const approval = await waitingApproval(child.view)
  expect(approvalsOf(child.view)!.requests[approval]).toMatchObject({ tool: "Bash" })
  expect(Object.keys(approvalsOf(session.view)?.requests ?? {})).toEqual([])

  await session.answer(true, child.view, child.id)
  await session.view.until(settled(1))
  await child.view.until(childEnded)
  expect(claude.permissionAnswers()).toEqual([
    {
      behavior: "allow",
      toolUseID: "toolu_014CZioACz8p6vaiRZxtSoto",
      updatedInput: { command: "touch made.txt", description: "Create made.txt" },
    },
  ])
  expect(runEnds(child.view.seen())).toEqual([expect.objectContaining({ outcome: "answered" })])
})

test("subagent-interrupt: stopping a Claude subagent stops only it, and its parent's run carries on", async () => {
  using claude = new FakeClaude("subagent_stopped")
  await using session = await conversationWith(claude)
  await session.submit("go")
  const child = await subagentOf(session)
  await child.view.until((watch) => results(watch.seen()).length > 0)

  await session.client.call("conversation/interrupt", { conversation: child.id })
  await session.view.until(settled(1))
  await child.view.until(childEnded)

  expect(runEnds(child.view.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
  expect(transcript(session.view.seen()).slice(-2)).toEqual([
    "assistant: The subagent was stopped.",
    "run_end: answered",
  ])
  expect(claude.log().some((entry) => entry.received?.request?.subtype === "stop_task")).toBe(true)
})

test("subagent-interrupt: stopping a run ends the Claude subagents working under it", async () => {
  using claude = new FakeClaude("subagent_working")
  // The recording has no interrupt, so its process is closed once the stop times out.
  await using session = await conversationWith(claude, {}, { claudeStop: "100 millis" })
  await session.submit("go")
  const child = await subagentOf(session)
  await child.view.until((watch) => results(watch.seen()).length > 0)

  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await child.view.until(childEnded)

  expect(runEnds(session.view.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
  expect(runEnds(child.view.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
})

test("claude-sign-in: signing in to Claude runs Claude Code's own sign-in in a terminal with the provider's environment, then names the account", async () => {
  using claude = new FakeClaude("terminal_sign_in")
  await using server = await runningServer([], { claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const auth = client.watch<AuthState>("auth/watch")
  const before = ((await client.call("providers/list", {})).result as Array<ProviderSnapshot>).find(
    (provider) => provider.id === "claude",
  )!

  const started = (await client.call("auth/start", { provider: "claude" })).result as AuthState
  await auth.until((states) => states.some((state) => state.phase === "waiting"))
  const waiting = auth.items.find((state) => state.phase === "waiting")!
  await client.call("auth/respond", {
    provider: "claude",
    flow: started.flow,
    response: { _tag: "terminal_exited", success: true },
  })
  await auth.until((states) => states.at(-1)?.phase === "succeeded", 30_000)
  client.close()

  expect(before.health).toMatchObject({ status: "signed_out", message: "not signed in to Claude Code" })
  expect(waiting.interaction).toEqual({
    _tag: "terminal",
    command: [claude.options.executable!, "auth", "login"],
    env: claude.options.env!,
  })
  expect(auth.items.at(-1)?.message).toBe("person@example.com · Claude Max")
}, 40_000)

test("claude-compact, claude-session-gone: a resume at a position Claude Code compacted away starts a fresh session told the conversation", async () => {
  using claude = new FakeClaude("compaction_resume")
  // A run resumes at the position only when no process stayed live, as in the recording.
  await using session = await conversationWith(claude, { approvals: "auto" }, { claudeIdle: 0 })
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  await session.submit("/compact")
  await session.view.until(settled(2))
  // Claude Code compacted its own context: the transcript keeps its summary as a compaction.
  const compaction = session.view.seen().find((entry) => entry.kind === "pi.compaction")!
  expect(compaction.head).toBe(compaction.id)
  expect((compaction.model![0] as { content: string }).content).toContain("PLUM")

  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(3))
  const [first, compacting, resumed, fresh] = claude.spawns()
  // The position is still the answer before the compaction, which the resumed session no longer holds (F12).
  expect(compacting!["--resume-session-at"]).toBe("4de5c42b-c831-4d4d-b66d-efaa28971d5a")
  expect(resumed).toMatchObject({
    "--resume": first!["--session-id"],
    "--resume-session-at": "4de5c42b-c831-4d4d-b66d-efaa28971d5a",
  })
  expect(fresh!["--resume"]).toBeUndefined()
  expect(fresh!["--session-id"]).not.toBe(first!["--session-id"])
  const told = claude.userTexts(3)[0]!
  expect(told[0]).toContain("PLUM")
  expect(told.at(-1)).toBe("Which word did I ask you to remember? Reply with that word only.")
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: PLUM", "run_end: answered"])
  expect(runEnds(session.view.seen()).map((end) => end.outcome)).toEqual(["answered", "answered", "answered"])
})

test("compact-rpc, claude-compact: conversation/compact compacts a Claude conversation by sending Claude Code /compact with the instructions, and answers once it has", async () => {
  using claude = new FakeClaude("compaction_resume")
  // A run resumes at the position only when no process stayed live, as in the recording.
  await using session = await conversationWith(claude, { approvals: "auto" }, { claudeIdle: 0 })
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  const compacted = await session.client.call("conversation/compact", {
    conversation: session.conversation,
    author: "ada",
    instructions: "keep the word",
  })
  expect(compacted.result).toEqual({ outcome: "compacted" })
  expect(claude.userTexts(1)).toEqual([["/compact keep the word"]])
  await session.view.until(settled(2))
  expect(inputs(session.view.seen())).toEqual([
    "ada: Remember the word PLUM. Reply with exactly: noted",
    "ada: /compact keep the word",
  ])
  const compaction = session.view.seen().find((entry) => entry.kind === "pi.compaction")!
  expect((compaction.model![0] as { content: string }).content).toContain("PLUM")
})

test("claude-clear: /clear starts a new context in the transcript, and the next run starts a Claude Code session without it", async () => {
  using claude = new FakeClaude("clear")
  // The recording started a process per run.
  await using session = await conversationWith(claude, { approvals: "auto" }, { claudeIdle: 0 })
  const prompts = [
    "Remember the word PLUM. Reply with exactly: noted",
    "/clear",
    "Reply with exactly: cleared",
    "Did I ask you to remember a word earlier? Reply with yes or no only.",
  ]
  for (const [index, prompt] of prompts.entries()) {
    await session.submit(prompt)
    await session.view.until(settled(index + 1))
  }
  const reset = session.view.seen().find((entry) => entry.kind === "pi.reset")!
  expect(reset.head).toBe(reset.id)
  const [first, clearing, fresh, resumed] = claude.spawns()
  expect(clearing!["--resume"]).toBe(first!["--session-id"])
  expect(fresh!["--resume"]).toBeUndefined()
  expect(claude.userTexts(2)).toEqual([["Reply with exactly: cleared"]])
  expect(resumed!["--resume"]).toBe(fresh!["--session-id"])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: No.", "run_end: answered"])
})

test("claude-auto: in a conversation started without asking, a call Claude Code would ask about runs, allowed for it", async () => {
  using claude = new FakeClaude("bash_allowed")
  await using session = await conversationWith(claude, { approvals: "auto" })
  await session.submit("Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made")
  await session.view.until(settled(1))
  expect(claude.permissionAnswers()).toEqual([expect.objectContaining({ behavior: "allow" })])
  expect(session.view.seen().some((entry) => entry.kind === "nisse.approval")).toBe(false)
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: made", "run_end: answered"])
})

test("subagent-spawn: a Claude subagent is listed under its parent with the call that started it, and takes no input of its own", async () => {
  using claude = new FakeClaude("subagent")
  await using session = await conversationWith(claude)
  await session.submit("go")
  await session.view.until(settled(1))
  const child = await subagentOf(session)
  await child.view.until(childEnded)
  const listed = (await session.client.call("conversation/list")).result as Array<{
    id: string
    cwd: string
    model: unknown
    lineage?: unknown
  }>
  const parent = listed.find((conversation) => conversation.id === session.conversation)!
  const listedChild = listed.find((conversation) => conversation.id === child.id)!
  // A Claude subagent works where its parent does, on its parent's model.
  expect(listedChild.cwd).not.toBe("")
  expect(listedChild).toMatchObject({ cwd: parent.cwd, model: parent.model })
  expect(listedChild.lineage).toEqual({
    parent: session.conversation,
    root: session.conversation,
    call: AGENT_CALL,
    title: "Find gnome location in notes",
    agentType: "general-purpose",
  })
  const refused = await submit(session.client, child.id, "hello?")
  expect(refused.error?.data[0]?.error?._tag).toBe("TakesNoInput")
  const switched = await session.client.call("conversation/select_model", {
    conversation: child.id,
    author: "ada",
    selection: { provider: "claude", model: "haiku" },
  })
  expect(switched.error?.data[0]?.error?._tag).toBe("TakesNoInput")
})

test("claude-health: Claude Code says once how it is signed in and which models it offers, without asking Claude anything", async () => {
  using claude = new FakeClaude("models")
  await using server = await runningServer([], { claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const lists: Array<{ providers: Array<ProviderSnapshot>; models: Array<ProviderModels> }> = []
  for (let asked = 0; asked < 2; asked++) {
    lists.push({
      providers: (await client.call("providers/list", {})).result as Array<ProviderSnapshot>,
      models: (await client.call("models/list", {})).result as Array<ProviderModels>,
    })
  }
  client.close()

  // Each list says when it was made; the rest is the one probe's answer.
  const unstamped = (list: (typeof lists)[number]) => ({
    ...list,
    providers: list.providers.map(({ health: { checkedAt: _, ...health }, ...provider }) => ({ ...provider, health })),
  })
  expect(unstamped(lists[1]!)).toEqual(unstamped(lists[0]!))
  const { providers, models } = lists[0]!
  expect(providers.find((provider) => provider.id === "claude")).toMatchObject({
    driver: "claude",
    signIn: ["terminal"],
    health: { status: "ready", version: "2.1.310" },
  })
  const listed = models.find((list) => list.provider === "claude")!
  expect(listed.defaultModel).toBeUndefined()
  expect(listed.models[0]).toEqual({
    id: "sonnet",
    name: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  })
  expect(listed.models.map((model) => model.id)).not.toContain("default")
  expect(claude.probes()).toBe(1)
  expect(claude.spawns()).toHaveLength(0)
})

const switchToClaude = (session: Awaited<ReturnType<typeof conversationWith>>) =>
  session.client.call("conversation/select_model", {
    conversation: session.conversation,
    author: "ada",
    selection: { provider: "claude" },
  })

test("claude-switch: switching to Claude from another provider retells the conversation to a new Claude Code session", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude, { provider: "script" })
  await session.submit("first words")
  await session.view.until(settled(1))
  expect((await switchToClaude(session)).error).toBeUndefined()
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(2))

  expect(claude.spawns()[0]!["--resume"]).toBeUndefined()
  expect(claude.userTexts(0)).toEqual([
    [
      "This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.",
      "first words",
      "You answered: You said: first words",
      "Reply with exactly: fixture text ok",
    ],
  ])
  expect(
    session.view
      .seen()
      .filter((entry) => entry.kind === "nisse.model")
      .map((entry) => entry.data),
  ).toEqual([{ author: "ada", selection: { provider: "claude" } }])
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: fixture text ok", "run_end: answered"])
})

test("claude-switch: retelling a long conversation to Claude keeps its first prompt and the one being answered", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude, { provider: "script" })
  const long = (word: string) => `${word} ${"x".repeat(20_000)} `
  for (const [index, word] of ["first", "second", "third"].entries()) {
    await session.submit(long(word))
    await session.view.until(settled(index + 1))
  }
  await switchToClaude(session)
  const asked = `${"y".repeat(50_000)} Reply with exactly: fixture text ok`
  await session.submit(asked)
  await session.view.until(settled(4))

  const told = claude.userTexts(0)[0]!
  expect(told.slice(1)).toEqual([long("first"), "(5 entries left out here)", asked])
}, 20_000)

const clock = `import { Extension, Tool } from "@nisse/extension"
import { Effect, Schema } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.transform((tools) => {
    tools.add(
      Tool.make({
        name: "Clock",
        description: "The time in a zone",
        input: Schema.Struct({ zone: Schema.String }),
        readOnly: true,
        run: ({ zone }) => Effect.succeed(Tool.ok("noon in " + zone)),
      }),
    )
  }),
)`

/** Refuses `touch`, rewrites `echo original`, and reads one line of every file. */
const guard = `import { Extension, Tool } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.before", (call) =>
    Effect.gen(function* () {
      const input = call.input as { command?: string; file_path?: string }
      if (input.command?.startsWith("touch")) return yield* Tool.refuse("no touching")
      if (input.command === "echo original") call.input = { ...input, command: "echo rewritten" }
      if (input.file_path !== undefined) call.input = { ...input, limit: 1 }
    }),
  ),
)`

test("claude-extensions: an extension's tool reaches Claude through nisse's own MCP server, without asking", async () => {
  using claude = new FakeClaude("own_tool")
  await using session = await conversationWith(claude, {}, { home: homeWithExtensions({ "clock.ts": clock }) })
  await session.submit("what time is it")
  await session.view.until(settled(1))
  const entries = session.view.seen()
  expect(calls(entries)).toMatchObject([{ name: "Clock", arguments: { zone: "CET" } }])
  expect(results(entries)).toEqual([expect.objectContaining({ text: "noon in CET", isError: false })])
  expect(transcript(entries).slice(-2)).toEqual(["assistant: It is noon in CET.", "run_end: answered"])
  // Claude Code is offered the tool once, over MCP, not also as one of its own.
  expect(claude.spawns()[0]!["--disallowedTools"]).toBe("Clock")
  expect(claude.log().find((entry) => entry.initialize)?.initialize.sdkMcpServers).toEqual(["nisse"])
  expect(claude.mcpAnswers()).toEqual([
    expect.objectContaining({ result: { content: [{ type: "text", text: "noon in CET" }], isError: false } }),
  ])
  expect(entries.some((entry) => entry.kind === "nisse.approval")).toBe(false)
})

test("claude-extensions: an extension refuses a call Claude wants, in nisse's words, and Claude Code hears why", async () => {
  using claude = new FakeClaude("bash_hook_denied")
  await using session = await conversationWith(claude, {}, { home: homeWithExtensions({ "guard.ts": guard }) })
  await session.submit("touch it")
  await session.view.until(settled(1))
  const why = "Tool call blocked: guard refused this call: no touching"
  expect(results(session.view.seen())).toEqual([expect.objectContaining({ text: why, isError: true })])
  expect(claude.hookAnswers()).toEqual([
    { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why },
  ])
})

test("claude-extensions: an extension's rewrite of a call is what Claude Code runs and what the transcript shows", async () => {
  using claude = new FakeClaude("bash_hook_rewritten")
  await using session = await conversationWith(claude, {}, { home: homeWithExtensions({ "guard.ts": guard }) })
  await session.submit("echo it")
  await session.view.until(settled(1))
  const entries = session.view.seen()
  expect(calls(entries)).toMatchObject([
    { name: "Bash", arguments: { command: "echo rewritten", description: "Print the word original" } },
  ])
  expect(results(entries)).toEqual([expect.objectContaining({ text: "rewritten", isError: false })])
  expect(claude.hookAnswers()).toEqual([
    {
      hookEventName: "PreToolUse",
      updatedInput: { command: "echo rewritten", description: "Print the word original" },
    },
  ])
})

/** Sets a status line and toasts after each call. */
const tell = `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.after", (call) =>
    Effect.gen(function* () {
      yield* call.conversation.status(\`last ran \${call.tool}\`)
      yield* call.conversation.toast(\`\${call.tool} finished\`)
    }),
  ),
)`

/** Puts every result in capitals. */
const shout = `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.after", (call) =>
    Effect.sync(() => {
      call.outcome.output = call.outcome.output.toUpperCase()
    }),
  ),
)`

const toasts = (entries: ReadonlyArray<EntryRecord>) =>
  entries.filter((entry) => entry.kind === TOAST_KIND).map((entry) => entry.data as { extension: string; text: string })

test("claude-extensions: an extension's execute.after runs after Claude's calls, and its status line and toast show", async () => {
  using claude = new FakeClaude("bash_hook_rewritten")
  await using session = await conversationWith(
    claude,
    {},
    { home: homeWithExtensions({ "guard.ts": guard, "tell.ts": tell }) },
  )
  await session.submit("echo it")
  await session.view.until(settled(1))
  expect(toasts(session.view.seen())).toEqual([{ extension: "tell", text: "Bash finished" }])
  expect(session.view.view().docs[STATUS_LINES_KIND]).toEqual({ lines: { tell: "last ran Bash" } })
})

test("claude-extensions: execute.after changes what Claude reads, and a change Claude Code drops is toasted", async () => {
  using claude = new FakeClaude("read_after_hooked")
  await using session = await conversationWith(claude, {}, { home: homeWithExtensions({ "shout.ts": shout }) })
  await session.submit("read it, then echo")
  await session.view.until(settled(1))
  const entries = session.view.seen()
  expect(results(entries).map((result) => result.text)).toEqual(["1\tTHE GNOME LIVES UNDER THE FLOOR\n2\t", "quiet"])
  // The fake replays its recorded results, so what reached Claude Code is nisse's answer to the Read's hook.
  const after = claude.hookAnswers().filter((output) => output.hookEventName === "PostToolUse")
  expect(after).toEqual([
    {
      hookEventName: "PostToolUse",
      updatedToolOutput: expect.objectContaining({
        file: expect.objectContaining({ content: "THE GNOME LIVES UNDER THE FLOOR\n" }),
      }),
    },
  ])
  // Claude Code keeps Bash's own result, so the extension hears its change did not reach Claude.
  expect(toasts(entries)).toEqual([
    { extension: "shout", text: "execute.after changed Bash's result, but the model gets Bash's own result" },
  ])
})

test("claude-extensions: an extension's hooks reach the calls of Claude's subagents, in the subagent's conversation", async () => {
  using claude = new FakeClaude("subagent_hooked")
  await using session = await conversationWith(claude, {}, { home: homeWithExtensions({ "guard.ts": guard }) })
  await session.submit("find the gnome")
  const child = await subagentOf(session)
  await session.view.until(settled(1))
  await child.view.until(childEnded)
  const notes = `${session.server.home.dir}/notes.txt`
  expect(calls(child.view.seen())).toMatchObject([{ name: "Read", arguments: { file_path: notes, limit: 1 } }])
  expect(calls(session.view.seen()).map((call) => call.name)).not.toContain("Read")
  expect(claude.hookAnswers()).toEqual([{ hookEventName: "PreToolUse", updatedInput: { file_path: notes, limit: 1 } }])
})

test("claude-extensions: an extension's tool runs for Claude's subagents, in the subagent's conversation", async () => {
  using claude = new FakeClaude("subagent_own_tool")
  await using session = await conversationWith(claude, {}, { home: homeWithExtensions({ "clock.ts": clock }) })
  await session.submit("ask a subagent the time in CET")
  const child = await subagentOf(session)
  await session.view.until(settled(1))
  await child.view.until(childEnded)
  const clocks = calls(child.view.seen()).filter((call) => call.name === "Clock")
  expect(clocks).toMatchObject([{ arguments: { zone: "CET" } }])
  expect(results(child.view.seen()).filter((result) => result.call === clocks[0]!.id)).toEqual([
    expect.objectContaining({ text: "noon in CET", isError: false }),
  ])
  expect(calls(session.view.seen()).map((call) => call.name)).not.toContain("Clock")
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: noon in CET", "run_end: answered"])
})

test("subagent-claude: a Claude subagent that hands back its report answers with the report, not Claude Code's placeholder", async () => {
  using claude = new FakeClaude("subagent_own_tool")
  await using session = await conversationWith(claude, {}, { home: homeWithExtensions({ "clock.ts": clock }) })
  await session.submit("ask a subagent the time in CET")
  const child = await subagentOf(session)
  await session.view.until(settled(1))
  await child.view.until(childEnded)
  // Claude Code 2.1.312 says the report was delivered elsewhere; the report itself is the SubagentHandback call's.
  expect(transcript(child.view.seen()).slice(-2)).toEqual(["assistant: noon in CET", "run_end: answered"])
  // The parent's Agent call keeps the report too, so a retelling of the parent still has it.
  expect(results(session.view.seen())).toEqual([expect.objectContaining({ text: "noon in CET", isError: false })])
})

/** Adds a read-only `Clock` tool, and removes Claude Code's `WebFetch` and nisse's `bash`. */
const clockWithoutWeb = `import { Extension, Tool } from "@nisse/extension"
import { Effect, Schema } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.transform((tools) => {
    tools.add(
      Tool.make({
        name: "Clock",
        description: "The time in a zone",
        input: Schema.Struct({ zone: Schema.String }),
        readOnly: true,
        run: ({ zone }) => Effect.succeed(Tool.ok("noon in " + zone)),
      }),
    )
    tools.remove("WebFetch")
    tools.remove("bash")
  }),
)`

test("claude-extensions: a tool an extension removes is withheld from Claude Code, by Claude Code's name for nisse's own", async () => {
  using claude = new FakeClaude("own_tool")
  const home = homeWithExtensions({ "clock.ts": clockWithoutWeb })
  await using session = await conversationWith(claude, {}, { home })
  await session.submit("what time is it")
  await session.view.until(settled(1))
  expect(results(session.view.seen())).toEqual([expect.objectContaining({ text: "noon in CET", isError: false })])
  expect(claude.spawns()[0]!["--disallowedTools"]).toBe("WebFetch,Bash,Clock")
})

/** What a Claude Code session sets for the commands it runs, a server among them: the names Claude Code 2.1.312 sets. */
const HOST_SESSION: Record<string, string> = {
  AI_AGENT: "claude-code_2-1-312_agent",
  CLAUDECODE: "1",
  CLAUDE_AGENT_SDK_VERSION: "0.0.1-host",
  CLAUDE_CODE_BRIDGE_SESSION_ID: "host-bridge",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_EXECPATH: "/host/claude",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "host-token",
  CLAUDE_CODE_SESSION_ATTENDED: "1",
  CLAUDE_CODE_SESSION_ID: "host-session",
  CLAUDE_EFFORT: "high",
  CLAUDE_PID: "4242",
}

/** The test's in-process server runs as if started from a shell inside a Claude Code session, until disposed. */
const insideClaudeCode = () => {
  const before = Object.fromEntries(Object.keys(HOST_SESSION).map((name) => [name, process.env[name]]))
  Object.assign(process.env, HOST_SESSION)
  return {
    [Symbol.dispose]: () => {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
  }
}

test("claude-environment: a server started inside a Claude Code session hands none of that session's variables to the Claude Code it starts, and the provider's own environment still arrives", async () => {
  using _host = insideClaudeCode()
  using claude = new FakeClaude("models", "text")
  await using session = await conversationWith(claude)
  await session.client.call("providers/list", {})
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  await session.client.call("auth/logout", { provider: "claude" })

  const started = claude.log().filter((entry) => entry.env !== undefined)
  const kind = (entry: { probe?: number; auth?: unknown }) =>
    entry.auth !== undefined ? "auth" : entry.probe !== undefined ? "probe" : "spawn"
  expect(new Set(started.map(kind))).toEqual(new Set(["probe", "spawn", "auth"]))
  // The SDK names its own spawns `sdk-ts` and its version; nothing may carry the host session's values.
  const inherited = (entry: { env: Record<string, string> }) =>
    Object.keys(HOST_SESSION).filter((name) => entry.env[name] === HOST_SESSION[name])
  expect(started.map((entry) => ({ [kind(entry)]: inherited(entry) }))).toEqual(
    started.map((entry) => ({ [kind(entry)]: [] })),
  )
  expect(started.map((entry) => entry.env.FAKE_CLAUDE_DIR)).toEqual(started.map(() => claude.dir))
  expect(started.find((entry) => kind(entry) === "spawn")!.env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts")
})

test("claude-title: a fresh Claude Code session is named after the conversation's first prompt, so Claude Code asks no model for a name", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude)
  await session.submit("Reply with exactly: fixture text ok\nand nothing more")
  await session.view.until(settled(1))
  const initialize = claude.log().find((entry) => entry.initialize)?.initialize
  expect(initialize.title).toBe("Reply with exactly: fixture text ok")
})

test("claude-tool-search: tool search set to auto in the person's Claude Code settings is turned on for nisse's sessions, and any other value is left alone", async () => {
  for (const [value, expected] of [
    ["auto", "true"],
    ["auto:10", "true"],
    ["auto:250", undefined],
    ["false", undefined],
    [undefined, undefined],
  ] as const) {
    using claude = new FakeClaude("text")
    const config = join(claude.dir, "config")
    mkdirSync(config)
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify(value === undefined ? {} : { env: { ENABLE_TOOL_SEARCH: value } }),
    )
    const options = { ...claude.options, env: { ...claude.options.env, CLAUDE_CONFIG_DIR: config } }
    await using server = await runningServer([], { claude: options })
    const client = await RawClient.connect(server.home.socket)
    const conversation = (await client.call("conversation/start", { cwd: server.home.dir, provider: "claude" })).result
      .conversation as string
    const view = watchView(client, conversation)
    await submit(client, conversation, "Reply with exactly: fixture text ok", crypto.randomUUID(), "ada")
    await view.until(settled(1))
    client.close()
    const argv: Array<string> = claude.log().find((entry) => entry.argv && entry.probe === undefined).argv
    const settings = argv.includes("--settings") ? JSON.parse(argv[argv.indexOf("--settings") + 1]!) : undefined
    expect({ value, override: settings?.env?.ENABLE_TOOL_SEARCH }).toEqual({ value, override: expected })
  }
})
