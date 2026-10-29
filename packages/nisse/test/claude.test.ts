import { expect, test } from "bun:test"
import type { AuthState, Delivery, ProviderModels, ProviderSnapshot } from "@nisse/protocol"
import { FakeClaude } from "./support/claude.ts"
import { bodies, errorTag, RawClient, statusOf } from "./support/raw.ts"
import { runningServer, type ServerOptions } from "./support/server.ts"

const settled = (count: number) => (deliveries: ReadonlyArray<Delivery>) =>
  bodies(deliveries).filter((body) => body._tag === "run_end").length >= count && deliveries.at(-1)?.status === "idle"

const said = (deliveries: ReadonlyArray<Delivery>): Array<unknown> =>
  bodies(deliveries).filter(
    (body) => body._tag !== "user" && body._tag !== "approval" && body._tag !== "approval_answer",
  )

interface StartWith {
  readonly approvals?: string
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
}

const conversationWith = async (claude: FakeClaude, options: StartWith & ServerOptions = {}) => {
  const server = await runningServer([], { ...options, claude: claude.options })
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", {
      cwd: server.home.dir,
      provider: options.provider ?? "claude",
      approvals: options.approvals ?? "ask",
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
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

const AGENT_CALL = "toolu_01DxmcUXKnbFWBQecJLTs1n3"

const subagentOf = async (session: Awaited<ReturnType<typeof conversationWith>>) => {
  await session.view.until((deliveries) => bodies(deliveries).some((body) => body._tag === "subagent"))
  const listed = (await session.client.call("conversation/list")).result as Array<{
    id: string
    lineage?: Record<string, unknown>
  }>
  const child = listed.find((conversation) => conversation.lineage?.parent === session.conversation)!
  return { ...child, view: session.client.subscribe({ conversation: child.id }) }
}

const ended = (deliveries: ReadonlyArray<Delivery>) =>
  bodies(deliveries).some((body) => body._tag === "run_end") && deliveries.at(-1)?.status === "idle"

test("a Claude subagent works in a conversation of its own under the one that started it", async () => {
  using claude = new FakeClaude("subagent")
  await using session = await conversationWith(claude)
  await session.submit("go")
  await session.view.until(settled(1))
  const child = await subagentOf(session)
  await child.view.until(ended)

  expect(said(session.view.deliveries)).toMatchObject([
    { _tag: "tool_call", call: AGENT_CALL, tool: "Agent" },
    { _tag: "subagent", call: AGENT_CALL, conversation: child.id, title: "Find gnome location in notes" },
    { _tag: "tool_result", call: AGENT_CALL, error: false },
    { _tag: "message", text: "Under the floor." },
    { _tag: "run_end", outcome: "answered" },
  ])
  expect(child.lineage).toEqual({
    parent: session.conversation,
    root: session.conversation,
    call: AGENT_CALL,
    title: "Find gnome location in notes",
    agentType: "general-purpose",
  })
  const summary =
    "The gnome lives under the floor.\n\nThe exact line from `" +
    session.server.home.dir +
    "/notes.txt` (line 1) is: `the gnome lives under the floor`\n\nI did not modify any files."
  expect(child.view.deliveries.flatMap((delivery) => delivery.entries)).toMatchObject([
    { author: { _tag: "agent", conversation: session.conversation }, body: { _tag: "user" } },
    { body: { _tag: "tool_call", tool: "Read" } },
    { body: { _tag: "tool_result", output: "1\tthe gnome lives under the floor\n2\t", error: false } },
    { body: { _tag: "message", text: summary } },
    { body: { _tag: "run_end", outcome: "answered" } },
  ])
  expect((bodies(child.view.deliveries)[0] as { text: string }).text).toStartWith(
    "Read the file notes.txt using the Read tool.",
  )
})

test("a Claude subagent takes input only through its parent", async () => {
  using claude = new FakeClaude("subagent")
  await using session = await conversationWith(claude)
  await session.submit("go")
  const child = await subagentOf(session)
  await session.view.until(settled(1))

  const submitted = await session.client.call("conversation/submit", {
    conversation: child.id,
    requestId: "r1",
    author: "ada",
    text: "and the cat?",
  })
  const switched = await session.client.call("conversation/select_model", {
    conversation: child.id,
    author: "ada",
    selection: { provider: "claude", model: "opus" },
  })

  expect([errorTag(submitted), errorTag(switched)]).toEqual(["TakesNoInput", "TakesNoInput"])
  expect(claude.spawns()).toHaveLength(1)
})

test("a Claude subagent leaves the model a new conversation starts with as the person last chose it", async () => {
  using claude = new FakeClaude("subagent")
  await using session = await conversationWith(claude, { model: "opus", effort: "high" })
  await session.submit("go")
  await subagentOf(session)
  await session.view.until(settled(1))

  const next = await session.client.call("conversation/start", { cwd: session.server.home.dir })
  expect(next.result.model).toEqual({ provider: "claude", model: "opus", effort: "high" })
})

test("a call a Claude subagent wants to make waits for a person in the subagent's conversation", async () => {
  using claude = new FakeClaude("subagent_asks")
  await using session = await conversationWith(claude)
  await session.submit("go")
  const child = await subagentOf(session)
  await child.view.until((deliveries) => statusOf(deliveries) === "waiting")
  const approval = bodies(child.view.deliveries).find((body) => body._tag === "approval") as {
    approval: string
    tool: string
  }
  expect(approval.tool).toBe("Bash")
  expect(statusOf(session.view.deliveries)).toBe("working")

  await session.client.call("approval/resolve", {
    conversation: child.id,
    approval: approval.approval,
    author: "ada",
    allow: true,
  })
  await session.view.until(settled(1))
  await child.view.until(ended)

  expect(claude.permissionAnswers()).toEqual([
    {
      behavior: "allow",
      toolUseID: "toolu_014CZioACz8p6vaiRZxtSoto",
      updatedInput: { command: "touch made.txt", description: "Create made.txt" },
    },
  ])
  expect(bodies(session.view.deliveries).some((body) => body._tag === "approval")).toBe(false)
  expect(bodies(child.view.deliveries).at(-1)).toEqual({ _tag: "run_end", outcome: "answered" })
})

test("stopping a Claude subagent stops only it, and its parent's run carries on", async () => {
  using claude = new FakeClaude("subagent_stopped")
  await using session = await conversationWith(claude)
  await session.submit("go")
  const child = await subagentOf(session)
  await child.view.until((deliveries) => bodies(deliveries).some((body) => body._tag === "tool_result"))

  await session.client.call("conversation/interrupt", { conversation: child.id })
  await session.view.until(settled(1))
  await child.view.until(ended)

  expect(bodies(child.view.deliveries).at(-1)).toEqual({ _tag: "run_end", outcome: "interrupted" })
  expect(said(session.view.deliveries).slice(-2)).toEqual([
    { _tag: "message", text: "The subagent was stopped." },
    { _tag: "run_end", outcome: "answered" },
  ])
  expect(claude.log().some((entry) => entry.received?.request?.subtype === "stop_task")).toBe(true)
})

test("stopping a run ends the Claude subagents working under it", async () => {
  using claude = new FakeClaude("subagent_working")
  await using session = await conversationWith(claude)
  await session.submit("go")
  const child = await subagentOf(session)
  await child.view.until((deliveries) => bodies(deliveries).some((body) => body._tag === "tool_result"))

  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await child.view.until(ended)

  expect(bodies(session.view.deliveries).at(-1)).toEqual({ _tag: "run_end", outcome: "interrupted" })
  expect(bodies(child.view.deliveries).at(-1)).toEqual({ _tag: "run_end", outcome: "interrupted" })
})

test("Claude Code says once how it is signed in and which models it offers, without asking Claude anything", async () => {
  using claude = new FakeClaude("models")
  await using server = await runningServer([], { claude: claude.options })
  const client = await RawClient.connect(server.home.socket)

  const providers = (await client.call("providers/list", {})).result as Array<ProviderSnapshot>
  const models = (await client.call("models/list", {})).result as Array<ProviderModels>
  client.close()

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

test("signing in to Claude runs Claude Code's own sign-in in a terminal with the provider's environment, then names the account", async () => {
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

test("the conversation's model and effort reach Claude Code", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude, { model: "opus", effort: "high" })
  await session.submit("Reply with exactly: fixture text ok")
  await session.view.until(settled(1))
  expect(claude.spawns()[0]).toMatchObject({ "--model": "opus", "--effort": "high" })
})

test("switching to Claude from another provider retells the conversation to a new Claude Code session", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude, { provider: "script" })
  await session.submit("first words")
  await session.view.until(settled(1))
  await session.client.call("conversation/select_model", {
    conversation: session.conversation,
    author: "ada",
    selection: { provider: "claude" },
  })
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
  expect(bodies(session.view.deliveries).find((body) => body._tag === "model")).toEqual({
    _tag: "model",
    selection: { provider: "claude" },
  })
})

test("retelling a long conversation to Claude keeps its first prompt and the one being answered", async () => {
  using claude = new FakeClaude("text")
  await using session = await conversationWith(claude, { provider: "script" })
  const long = (word: string) => `${word} ${"x".repeat(20_000)} `
  for (const [index, word] of ["first", "second", "third"].entries()) {
    await session.submit(long(word))
    await session.view.until(settled(index + 1))
  }
  await session.client.call("conversation/select_model", {
    conversation: session.conversation,
    author: "ada",
    selection: { provider: "claude" },
  })
  const asked = `${"y".repeat(50_000)} Reply with exactly: fixture text ok`
  await session.submit(asked)
  await session.view.until(settled(4))

  const told = claude.userTexts(0)[0]!
  expect(told[1]).toBe(long("first"))
  expect(told).toContain("(5 entries left out here)")
  expect(told.at(-1)).toBe(asked)
}, 20_000)
