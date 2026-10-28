import { expect, test } from "bun:test"
import type { Delivery } from "@nisse/protocol"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { accessToken, ACCOUNT, FakeOpenAi, matches, signIn } from "./support/openai.ts"
import { bodies, deadline, RawClient } from "./support/raw.ts"
import { runningServer } from "./support/server.ts"

const settled = (count: number) => (deliveries: ReadonlyArray<Delivery>) =>
  bodies(deliveries).filter((body) => body._tag === "run_end").length >= count && deliveries.at(-1)?.status === "idle"

const said = (deliveries: ReadonlyArray<Delivery>): Array<unknown> =>
  bodies(deliveries).filter(
    (body) => body._tag !== "user" && body._tag !== "approval" && body._tag !== "approval_answer",
  )

const conversationWith = async (fake: FakeOpenAi, options: { approvals?: string; signedIn?: boolean } = {}) => {
  const server = await runningServer([], { openai: fake.options() })
  if (options.signedIn ?? true) await signIn(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", {
      cwd: server.home.dir,
      provider: "openai",
      approvals: options.approvals ?? "auto",
    })
  ).result.id as string
  const view = client.subscribe({ conversation })
  await view.until((deliveries) => deliveries.length > 0)
  const submit = (text: string, steer = false) =>
    client.call("conversation/submit", { conversation, requestId: crypto.randomUUID(), author: "ada", text, steer })
  return {
    server,
    client,
    conversation,
    view,
    submit,
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

test("a ChatGPT answer is committed as nisse's message, asked for with the sign-in's headers", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("text_answer")
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "message", text: "Hello there" },
    { _tag: "run_end", outcome: "answered" },
  ])
  expectRequests(fake, expected)
  const headers = fake.responses()[0]!.headers
  expect(headers.get("authorization")).toBe(`Bearer ${accessToken("first")}`)
  expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT)
  expect(headers.get("originator")).toBe("nisse")
  expect(headers.get("session-id")).toBe(session.conversation)
  expect(JSON.parse(fake.responses()[0]!.body).instructions).toBe(
    `You are a test.\nThe working directory is ${session.server.home.dir}.\n`,
  )
})

test("a recorded ChatGPT exchange replays into the same answer", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("recorded_text_answer")
  await using session = await conversationWith(fake)
  await session.submit("what does `echo hi` print?")
  await session.view.until(settled(1))
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "message", text: "`echo hi` prints:\n\n```text\nhi\n```" },
    { _tag: "run_end", outcome: "answered" },
  ])
  expectRequests(fake, expected)
})

test("nisse offers its tools, runs the call the model asks for and sends back the result", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("tool_call")
  await using session = await conversationWith(fake)
  await session.submit("what does echo say?")
  await session.view.until(settled(1))
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "message", text: "Let me look." },
    { _tag: "tool_call", call: "call_1", tool: "Bash", input: { command: "echo hi" } },
    { _tag: "tool_result", call: "call_1", output: "hi\n", error: false },
    { _tag: "message", text: "It printed hi." },
    { _tag: "run_end", outcome: "answered" },
  ])
  expectRequests(fake, expected)
  const tools = JSON.parse(fake.responses()[0]!.body).tools.map((tool: { name: string }) => tool.name)
  expect(tools).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob"])
})

test("a call the person denies reaches the model as denied", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("tool_denied")
  await using session = await conversationWith(fake, { approvals: "ask" })
  await session.submit("what does echo say?")
  await session.view.until((deliveries) => deliveries.at(-1)?.status === "waiting")
  const approval = bodies(session.view.deliveries).find((body) => body._tag === "approval") as { approval: string }
  await session.client.call("approval/resolve", {
    conversation: session.conversation,
    approval: approval.approval,
    author: "ada",
    allow: false,
  })
  await session.view.until(settled(1))
  expect(said(session.view.deliveries).at(-2)).toEqual({ _tag: "message", text: "I was not allowed to run it." })
  expectRequests(fake, expected)
})

test("a steer sent while calls run reaches the model after all of them, before its next answer", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("steer_after_parallel_calls")
  await using session = await conversationWith(fake, { approvals: "ask" })
  await session.submit("echo one and two")
  const answer = async (count: number) => {
    await session.view.until(
      (deliveries) =>
        deliveries.at(-1)?.status === "waiting" &&
        bodies(deliveries).filter((body) => body._tag === "approval").length === count,
    )
    const approval = bodies(session.view.deliveries).findLast((body) => body._tag === "approval") as {
      approval: string
    }
    await session.client.call("approval/resolve", {
      conversation: session.conversation,
      approval: approval.approval,
      author: "ada",
      allow: true,
    })
  }
  await answer(1)
  await session.submit("and three", true)
  await answer(2)
  await session.view.until(settled(1))
  expect(said(session.view.deliveries).at(-2)).toEqual({ _tag: "message", text: "One, two, and three." })
  expectRequests(fake, expected)
})

test("an expired token is refreshed once, saved, and used from then on", async () => {
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

test("a failed response, a cut stream and a reached usage limit each end the run with the reason", async () => {
  for (const [fixture, message, kept] of [
    ["response_failed", "the response failed (server_error): The model crashed.", []],
    ["stream_cut", "the response stream ended before the response finished", [{ _tag: "message", text: "Hel" }]],
    ["usage_limit", "You have hit your ChatGPT usage limit (plus plan).", []],
  ] as const) {
    await using fake = new FakeOpenAi()
    fake.play(fixture)
    await using session = await conversationWith(fake)
    await session.submit("hello")
    await session.view.until(settled(1))
    expect(said(session.view.deliveries)).toEqual([...kept, { _tag: "run_end", outcome: "failed", message }])
  }
})

test("a conversation with ChatGPT before signing in says how to fix it", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake, { signedIn: false })
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "run_end", outcome: "failed", message: expect.stringContaining("not signed in to ChatGPT") },
  ])
})

test("an answer streams live, and interrupting it closes the request and keeps what was said", async () => {
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
  await session.view.until((deliveries) =>
    deliveries.some((delivery) => delivery._tag === "commit" && delivery.live?.some((c) => c._tag === "text")),
  )
  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await deadline(fake.heldStreamAbandoned, 5000, "the request closed")
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "message", text: "Thinking about" },
    { _tag: "run_end", outcome: "interrupted" },
  ])
})
