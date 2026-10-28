import { expect, test } from "bun:test"
import type { Delivery } from "@nisse/protocol"
import { FakeClaude } from "./support/claude.ts"
import { bodies, RawClient, statusOf } from "./support/raw.ts"
import { runningServer, type ServerOptions } from "./support/server.ts"

const settled = (count: number) => (deliveries: ReadonlyArray<Delivery>) =>
  bodies(deliveries).filter((body) => body._tag === "run_end").length >= count && deliveries.at(-1)?.status === "idle"

const said = (deliveries: ReadonlyArray<Delivery>): Array<unknown> =>
  bodies(deliveries).filter(
    (body) => body._tag !== "user" && body._tag !== "approval" && body._tag !== "approval_answer",
  )

const conversationWith = async (claude: FakeClaude, options: { approvals?: string } & ServerOptions = {}) => {
  const server = await runningServer([], { ...options, claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", {
      cwd: server.home.dir,
      provider: "claude",
      approvals: options.approvals ?? "ask",
    })
  ).result.id as string
  const view = client.subscribe({ conversation })
  await view.until((deliveries) => deliveries.length > 0)
  const submit = (text: string, steer = false) =>
    client.call("conversation/submit", { conversation, requestId: crypto.randomUUID(), author: "ada", text, steer })
  const answer = async (allow: boolean, count = 1) => {
    await view.until(
      (deliveries) =>
        statusOf(deliveries) === "waiting" &&
        bodies(deliveries).filter((body) => body._tag === "approval").length === count,
    )
    const approval = bodies(view.deliveries).findLast((body) => body._tag === "approval") as { approval: string }
    await client.call("approval/resolve", { conversation, approval: approval.approval, author: "ada", allow })
  }
  return {
    server,
    client,
    conversation,
    view,
    submit,
    answer,
    [Symbol.asyncDispose]: async () => {
      client.close()
      await server[Symbol.asyncDispose]()
    },
  }
}

test("Claude's answer through Claude Code is committed as nisse's message", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude)
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "message", text: "fixture text ok" },
    { _tag: "run_end", outcome: "answered" },
  ])
  expect(claude.userTexts()).toEqual([["Reply with exactly: fixture text ok"]])
})

test("a command Claude wants to run waits for a person, and Claude Code hears the answer", async () => {
  for (const [fixture, allow, reply] of [
    ["bash_allowed", true, "made"],
    ["bash_declined", false, undefined],
  ] as const) {
    using claude = new FakeClaude(fixture)
    await using session = await conversationWith(claude)
    await session.submit("Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made")
    await session.answer(allow)
    await session.view.until(settled(1))
    const [answer] = claude.permissionAnswers()
    expect(answer).toMatchObject(
      allow ? { behavior: "allow" } : { behavior: "deny", message: "the person did not allow this call" },
    )
    const entries = said(session.view.deliveries) as Array<{ _tag: string } & Record<string, unknown>>
    expect(entries.map((entry) => entry._tag).slice(0, 2)).toEqual(["tool_call", "tool_result"])
    expect(entries.at(-1)).toEqual({ _tag: "run_end", outcome: "answered" })
    if (reply) expect(entries.at(-2)).toEqual({ _tag: "message", text: reply })
  }
})

test("Claude reads files without asking and the read shows as a call and its result", async () => {
  using claude = new FakeClaude("read")
  await using session = await conversationWith(claude)
  await session.submit("read it")
  await session.view.until(settled(1))
  expect(claude.permissionAnswers()).toEqual([])
  expect(said(session.view.deliveries).map((entry) => (entry as { _tag: string })._tag)).toEqual([
    "tool_call",
    "tool_result",
    "message",
    "run_end",
  ])
})

test("a steer sent while Claude works reaches Claude Code in the same run", async () => {
  using claude = new FakeClaude("steer")
  await using session = await conversationWith(claude)
  await session.submit("Run the bash command `touch steered.txt` with the Bash tool, then reply with exactly: done")
  await session.view.until((deliveries) => bodies(deliveries).some((body) => body._tag === "approval"))
  await session.submit("Also end your reply with the word BANANA.", true)
  await session.answer(true)
  await session.view.until(settled(1))
  expect(claude.userTexts()).toEqual([
    ["Run the bash command `touch steered.txt` with the Bash tool, then reply with exactly: done"],
    ["Also end your reply with the word BANANA."],
  ])
  expect(said(session.view.deliveries).slice(-3)).toEqual([
    { _tag: "message", text: "done" },
    { _tag: "message", text: "done BANANA" },
    { _tag: "run_end", outcome: "answered" },
  ])
  expect(bodies(session.view.deliveries).filter((body) => body._tag === "run_end")).toHaveLength(1)
})

test("each run resumes the Claude Code session where nisse's transcript ends", async () => {
  using claude = new FakeClaude("died_while_idle")
  await using session = await conversationWith(claude)
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(2))
  const [first, second] = claude.spawns()
  expect(second).toMatchObject({
    "--resume": first!["--session-id"],
    "--resume-session-at": "190a62a3-be35-438c-961e-f0de63b6ca5c",
  })
  expect(claude.userTexts(1)).toEqual([["Which word did I ask you to remember? Reply with that word only."]])
  expect(said(session.view.deliveries).at(-2)).toEqual({ _tag: "message", text: "PLUM" })
})

test("when Claude Code lost the session, a fresh one is given the conversation so far", async () => {
  using claude = new FakeClaude("session_gone")
  await using session = await conversationWith(claude)
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
  await session.submit("Which word did I ask you to remember? Reply with that word only.")
  await session.view.until(settled(2))
  expect(claude.userTexts(2)).toEqual([
    [
      "This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.",
      "Remember the word PLUM. Reply with exactly: noted",
      "You answered: noted",
      "Which word did I ask you to remember? Reply with that word only.",
    ],
  ])
  expect(said(session.view.deliveries).slice(-2)).toEqual([
    { _tag: "message", text: "PLUM" },
    { _tag: "run_end", outcome: "answered" },
  ])
})

test("a signed-out Claude Code fails the run with its own words", async () => {
  using claude = new FakeClaude("auth_failed")
  await using session = await conversationWith(claude)
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "run_end", outcome: "failed", message: "Invalid API key · Please run /login" },
  ])
})

test("a run cut off by a server stop resumes, and Claude Code is told which call was cut off", async () => {
  using claude = new FakeClaude("resume_after_kill")
  const first = await conversationWith(claude)
  const prompt =
    "Run the bash command `echo started > started.fifo && python3 -c 'import time; time.sleep(120)'` with the Bash tool. If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok"
  await first.submit(prompt)
  await first.answer(true)
  await claude.logged((fake) => fake.permissionAnswers().length === 1)
  first.client.close()
  await first.server.stop()

  await using server = await runningServer([], { home: first.server.home, claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const view = client.subscribe({ conversation: first.conversation })
  await view.until((deliveries) => deliveries.length > 0 && deliveries.at(-1)?.status === "idle", 10_000)
  const call = bodies(view.deliveries).find((body) => body._tag === "tool_call") as { call: string }
  expect(claude.spawns()[1]).toMatchObject({ "--resume-session-at": "b2a87c3c-db3b-4459-9666-b8c4c38bc556" })
  expect(claude.userTexts(1)).toEqual([
    [`Your Bash call ${call.call} was cut off: interrupted; it may or may not have taken effect`],
  ])
  expect(said(view.deliveries).slice(-2)).toEqual([
    { _tag: "message", text: "resumed ok" },
    { _tag: "run_end", outcome: "answered" },
  ])
  client.close()
}, 20_000)
