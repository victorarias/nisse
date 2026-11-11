// Claude Code on the kernel wire (NISSE_KERNEL=1): a real server in process, driven as a raw JSON-RPC client, with
// Claude Code played by the fake `claude` replaying a recorded process per spawn.
import { expect, test } from "bun:test"
import { FakeClaude } from "../support/claude.ts"
import type { EntryRecord } from "@nisse/wire"
import { RawClient } from "../support/raw.ts"
import {
  runEnds,
  runningKernelServer,
  settled,
  submit,
  transcript,
  type ViewWatch,
  watchView,
} from "../support/kernel.ts"
import type { ServerOptions } from "../support/server.ts"

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
      return { call: message.toolCallId, text: message.content.map((b) => b.text ?? "").join(""), isError: message.isError }
    })
const calls = (entries: ReadonlyArray<EntryRecord>) =>
  entries.flatMap((entry) =>
    entry.kind === "pi.assistant"
      ? ((entry.model![0] as { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }).content
          .filter((block) => block.type === "toolCall")
          .map((block) => ({ id: block.id!, name: block.name!, arguments: block.arguments })))
      : [],
  )

const conversationWith = async (
  claude: FakeClaude,
  ask: Record<string, string> = {},
  options: ServerOptions = {},
) => {
  const server = await runningKernelServer([], { ...options, claude: claude.options })
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
    submit: (text: string, steer = false) => submit(client, conversation, text, crypto.randomUUID(), steer),
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

test("claude-answer: Claude's answer through Claude Code is committed as nisse's message", async () => {
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
    "pi.user",
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

test("claude-resume: each run resumes the Claude Code session where nisse's transcript ends", async () => {
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
  expect(transcript(session.view.seen()).slice(-2)).toEqual(["assistant: PLUM", "run_end: answered"])
})

test("claude-session-gone: when Claude Code lost the session, a fresh one is given the conversation so far", async () => {
  using claude = new FakeClaude("session_gone")
  await using session = await conversationWith(claude)
  await session.submit("Remember the word PLUM. Reply with exactly: noted")
  await session.view.until(settled(1))
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
  expect(kinds.filter((kind) => kind === "pi.user")).toHaveLength(3)
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

  await using server = await runningKernelServer([], { home: first.server.home, claude: claude.options })
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

test("claude-resume: a run that answered before the server stopped is not run again", async () => {
  using claude = new FakeClaude("crash_points")
  const first = await conversationWith(claude, { approvals: "auto" })
  await first.submit(
    "First write one short sentence saying that you will read the notes. Then use the Read tool to read notes.txt. Then reply with where the gnome lives, in three words.",
  )
  await first.view.until(settled(1))
  first.client.close()
  await first.server.stop()

  await using server = await runningKernelServer([], { home: first.server.home, claude: claude.options })
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
    "pi.user",
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
  await using session = await conversationWith(claude)
  await session.submit("go")
  const child = await subagentOf(session)
  await child.view.until((watch) => results(watch.seen()).length > 0)

  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await child.view.until(childEnded)

  expect(runEnds(session.view.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
  expect(runEnds(child.view.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
})
