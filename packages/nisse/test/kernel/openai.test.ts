// ChatGPT on the kernel wire (NISSE_KERNEL=1): a real server in process, driven as a raw JSON-RPC client over its
// socket, with ChatGPT played by the fake OpenAI server replaying the recorded exchanges in `fixtures/openai`.
import { expect, test } from "bun:test"
import type { EntryRecord } from "@nisse/wire"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { accessToken, ACCOUNT, FakeOpenAi, matches, signIn } from "../support/openai.ts"
import { deadline, RawClient } from "../support/raw.ts"
import { runningKernelServer, settled, submit, transcript, type ViewWatch, watchView } from "../support/kernel.ts"

// The kernel's tools are named in lower case; the recordings call nisse's shipping tools.
const KERNEL_TOOLS = { Bash: "bash" }

const conversationWith = async (
  fake: FakeOpenAi,
  options: { approvals?: "ask" | "auto"; signedIn?: boolean; model?: string; effort?: string } = {},
) => {
  const server = await runningKernelServer([], { openai: fake.options() })
  if (options.signedIn ?? true) await signIn(server.home)
  const client = await RawClient.connect(server.home.socket)
  const started = await client.call("conversation/start", {
    cwd: server.home.dir,
    provider: "openai",
    approvals: options.approvals ?? "auto",
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
  })
  const conversation = started.result.conversation as string
  const view = watchView(client, conversation)
  await view.until(() => true)
  return {
    server,
    client,
    conversation,
    view,
    submit: (text: string) => submit(client, conversation, text),
    said: () => transcript(view.seen()),
    [Symbol.asyncDispose]: async () => {
      client.close()
      await server[Symbol.asyncDispose]()
    },
  }
}

const expectRequests = (fake: FakeOpenAi, expected: ReadonlyArray<unknown>) => {
  const sent = fake.responses().map((request) => JSON.parse(request.body))
  expect(sent).toHaveLength(expected.length)
  sent.forEach((body, i) => {
    if (!matches(body, expected[i])) expect(body).toEqual(expected[i])
  })
}

type Approvals = { requests: Record<string, { tool: string }> }
const approvalsOf = (watch: ViewWatch) => watch.view().docs["nisse.approvals"] as Approvals | undefined
const pending = (watch: ViewWatch) => Object.keys(approvalsOf(watch)?.requests ?? {})

const calls = (entries: ReadonlyArray<EntryRecord>) =>
  entries.flatMap((entry) =>
    entry.kind === "pi.assistant"
      ? ((entry.model?.[0] as { content: Array<any> }).content ?? []).filter((block) => block.type === "toolCall")
      : [],
  )

test("openai-answer, telemetry-identity: a ChatGPT answer is committed, asked for with the sign-in's headers and nisse as the originator", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("text_answer")
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(session.said()).toEqual(["user: hello", "assistant: Hello there", "run_end: answered"])
  expectRequests(fake, expected)
  const [request] = fake.responses()
  expect(request!.headers.get("authorization")).toBe(`Bearer ${accessToken("first")}`)
  expect(request!.headers.get("chatgpt-account-id")).toBe(ACCOUNT)
  expect(request!.headers.get("originator")).toBe("nisse")
  const body = JSON.parse(request!.body)
  // One id keys the conversation at ChatGPT: its prompt cache and its session.
  expect(request!.headers.get("session-id")).toBe(body.prompt_cache_key)
  expect(body.instructions).toStartWith("You are a test.")
})

test("openai-answer: a recorded ChatGPT exchange replays into the same answer", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("recorded_text_answer")
  await using session = await conversationWith(fake)
  await session.submit("what does `echo hi` print?")
  await session.view.until(settled(1))
  expect(session.said()).toEqual([
    "user: what does `echo hi` print?",
    "assistant: `echo hi` prints:\n\n```text\nhi\n```",
    "run_end: answered",
  ])
  expectRequests(fake, expected)
})

test("openai-tools: nisse offers its tools, runs the call the model asks for and sends back the result", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("tool_call", KERNEL_TOOLS)
  await using session = await conversationWith(fake)
  await session.submit("what does echo say?")
  await session.view.until(settled(1))
  expect(session.said()).toEqual([
    "user: what does echo say?",
    "assistant: Let me look.",
    "assistant: It printed hi.",
    "run_end: answered",
  ])
  expect(calls(session.view.seen())).toEqual([
    expect.objectContaining({ id: "call_1", name: "bash", arguments: { command: "echo hi" } }),
  ])
  expectRequests(fake, expected)
  const tools = JSON.parse(fake.responses()[0]!.body).tools
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual(
    expect.arrayContaining(["read", "write", "edit", "bash", "grep", "glob", "spawn_agent", "wait_agent"]),
  )
  expect(tools.find((tool: { name: string }) => tool.name === "bash")).toMatchObject({
    type: "function",
    strict: false,
    parameters: { type: "object", required: ["command"] },
  })
})

test("openai-tools, telemetry-identity: a call the person denies reaches the model as denied, and the answer names who gave it", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("tool_denied", KERNEL_TOOLS)
  await using session = await conversationWith(fake, { approvals: "ask" })
  await session.submit("what does echo say?")
  await session.view.until((watch) => pending(watch).length > 0)
  const [approval] = pending(session.view)
  await session.client.call("approval/resolve", {
    conversation: session.conversation,
    approval,
    author: "ada",
    allow: false,
  })
  await session.view.until(settled(1))
  expect(session.said().at(-2)).toBe("assistant: I was not allowed to run it.")
  const answer = session.view.seen().find((entry) => entry.kind === "nisse.approval")
  expect(answer?.data).toMatchObject({ approval, author: "ada", allow: false })
  // The recording's result is the shipping server's wording; the kernel's harness words a denial its own way.
  const denied = (expected[1] as { input: Array<{ output?: string }> }).input[3]!
  denied.output = "<harness>\n[error] denied by ada: the person did not allow this call\n</harness>"
  expectRequests(fake, expected)
})

test("openai-refresh: a turned-down token is refreshed once, saved, and used from then on", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("refresh")
  fake.issueTokens("second", 3600)
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  await session.submit("again")
  await session.view.until(settled(2))
  expectRequests(fake, expected)
  const refreshes = fake.received.filter((request) => request.path === "/oauth/token")
  expect(refreshes).toHaveLength(1)
  expect(new URLSearchParams(refreshes[0]!.body).get("refresh_token")).toBe("first-refresh")
  expect(fake.responses().map((request) => request.headers.get("authorization"))).toEqual([
    `Bearer ${accessToken("first")}`,
    `Bearer ${accessToken("second")}`,
    `Bearer ${accessToken("second")}`,
  ])
  const saved = JSON.parse(readFileSync(join(session.server.home.dir, "auth", "openai.json"), "utf8"))
  expect(saved).toMatchObject({ access_token: accessToken("second"), refresh_token: "second-refresh" })
})

test("openai-failed: a cut stream and a reached usage limit each end the run with the reason", async () => {
  for (const [fixture, message, kept] of [
    ["stream_cut", "the response stream ended before the response finished", "Hel"],
    ["usage_limit", "You have hit your ChatGPT usage limit (plus plan).", ""],
  ] as const) {
    await using fake = new FakeOpenAi()
    fake.play(fixture)
    await using session = await conversationWith(fake)
    await session.submit("hello")
    await session.view.until(settled(1))
    expect(session.said()).toEqual(["user: hello", `assistant: ${kept} [error]`, `run_end: failed (${message})`])
    expect(fake.responses()).toHaveLength(1)
  }
})

test("openai-failed, run-error-classes: a response that failed on ChatGPT's side is tried again, and the next answer is the run's", async () => {
  await using fake = new FakeOpenAi()
  fake.play("response_failed")
  fake.play("text_answer")
  await using session = await conversationWith(fake)
  await session.submit("hello")
  // The harness waits its first backoff, 2 s, before trying again.
  await session.view.until(settled(1), 10_000)
  expect(session.said()).toEqual(["user: hello", "assistant:  [error]", "assistant: Hello there", "run_end: answered"])
  const failed = session.view.seen().find((entry) => entry.kind === "pi.assistant")!.model![0] as {
    errorMessage: string
  }
  expect(failed.errorMessage).toBe("the response failed (server_error): The model crashed.")
  expect(fake.responses()).toHaveLength(2)
})

test("openai-signed-out: a conversation with ChatGPT before signing in says how to fix it", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake, { signedIn: false })
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(session.said().at(-1)).toContain("not signed in to ChatGPT")
  expect(fake.responses()).toHaveLength(0)
})

test("interrupt-wire: a ChatGPT answer streams live, and interrupting it closes the request and keeps what was said", async () => {
  await using fake = new FakeOpenAi()
  fake.reply({
    events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Thinking about" },
    ],
    hold: true,
  })
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until((watch) => JSON.stringify(watch.view().docs["pi.live"] ?? {}).includes("Thinking about"))
  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await deadline(fake.heldStreamAbandoned, 5000, "the request closed")
  expect(session.said()).toEqual([
    "user: hello",
    "assistant: Thinking about [aborted]",
    "run_end: interrupted (aborted)",
  ])
})

test("openai-answer: an answer whose CRLF event separators arrive split across reads is read whole", async () => {
  await using fake = new FakeOpenAi()
  fake.reply({
    events: [
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Split but whole" }] },
      },
      { type: "response.completed", response: { id: "resp_1" } },
    ],
    crlfSplit: true,
  })
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(session.said()).toEqual(["user: hello", "assistant: Split but whole", "run_end: answered"])
})

test("openai-model: the conversation's model and effort reach ChatGPT", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake, { model: "gpt-6-luna", effort: "high" })
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(JSON.parse(fake.responses()[0]!.body)).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "high" } })
})

test("subagent-fork: a spawned agent's requests carry its own conversation, and its last answer reaches the parent", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("subagent")
  await using session = await conversationWith(fake)
  await session.submit("Ask a scout where the gnome lives.")
  await session.view.until(settled(1), 20_000)
  expectRequests(fake, expected)
  const [parent, child, parentAgain] = fake.responses().map((request) => JSON.parse(request.body))
  expect(child.prompt_cache_key).not.toBe(parent.prompt_cache_key)
  expect(parentAgain.prompt_cache_key).toBe(parent.prompt_cache_key)
  expect(JSON.stringify(parentAgain.input)).toContain("Under the floor.")
  expect(session.said().at(-2)).toBe("assistant: The scout says: under the floor.")
})

test("compaction-overflow, models-overflow: ChatGPT's context-window error compacts the conversation, and the request goes again", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("context_overflow")
  await using session = await conversationWith(fake, { model: "gpt-6-luna" })
  await session.submit("hello")
  await session.view.until(settled(1))
  // Past the 20,000 tokens a compaction keeps, so the first exchange is what a summary replaces.
  const long = "the quick brown fox jumps over the lazy dog\n".repeat(2500)
  await session.submit(long)
  await session.view.until(settled(2))
  await session.submit("again")
  await session.view.until(settled(3))
  expectRequests(fake, expected)

  const said = session.said()
  expect(said.slice(-3)).toEqual(["assistant:  [error]", "assistant: Again, hello.", "run_end: answered"])
  const failed = session.view
    .seen()
    .flatMap((entry) => (entry.kind === "pi.assistant" ? [entry.model![0] as { errorMessage?: string }] : []))
    .find((message) => message.errorMessage !== undefined)
  expect(failed?.errorMessage).toBe(
    "the response failed (context_length_exceeded): Your input exceeds the context window of this model. Please adjust your input and try again.",
  )
  const [, , , summary, retried] = fake.responses().map((request) => JSON.parse(request.body))
  expect(JSON.stringify(summary.input)).toContain("hello")
  const retriedText = JSON.stringify(retried.input)
  expect(retriedText).toContain("The person said hello and was greeted.")
  expect(retriedText).not.toContain("Hello there")
  expect(retried.input.at(-1)).toEqual({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "again" }],
  })
})
