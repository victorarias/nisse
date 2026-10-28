import { expect, test } from "bun:test"
import type { AuthState, Delivery, ProviderModels, ProviderSnapshot } from "@nisse/protocol"
import { readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { accessToken, ACCOUNT, EMAIL, FakeOpenAi, matches, signIn } from "./support/openai.ts"
import { bodies, deadline, RawClient } from "./support/raw.ts"
import { runningServer, tempHome } from "./support/server.ts"

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

test("an answer whose CRLF event separators arrive split across reads is read whole", async () => {
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
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "message", text: "Split but whole" },
    { _tag: "run_end", outcome: "answered" },
  ])
})

const setupWith = async (fake: FakeOpenAi) => {
  const server = await runningServer([], { openai: fake.options() })
  const client = await RawClient.connect(server.home.socket)
  const auth = client.watch<AuthState>("auth/watch")
  const openai = async () =>
    ((await client.call("providers/list", {})).result as Array<ProviderSnapshot>).find((p) => p.id === "openai")!
  const settledSignIn = async () => {
    await auth.until((states) => states.some((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)))
    return auth.items.at(-1)!
  }
  const waiting = async () => {
    await auth.until((states) => states.some((state) => state.phase === "waiting"))
    return auth.items.find((state) => state.phase === "waiting")!
  }
  return {
    server,
    client,
    auth,
    openai,
    waiting,
    settledSignIn,
    [Symbol.asyncDispose]: async () => {
      client.close()
      await server[Symbol.asyncDispose]()
    },
  }
}

const browserUrl = (state: AuthState) => {
  if (state.interaction?._tag !== "browser") throw new Error(`not a browser sign-in: ${JSON.stringify(state)}`)
  return new URL(state.interaction.url)
}

const redirectOf = (asked: URL) => {
  const redirect = new URL(asked.searchParams.get("redirect_uri")!)
  redirect.hostname = "127.0.0.1"
  return redirect
}

const callbackFor = (state: AuthState, code: string) => {
  const asked = browserUrl(state)
  const answer = redirectOf(asked)
  answer.searchParams.set("code", code)
  answer.searchParams.set("state", asked.searchParams.get("state")!)
  return answer
}

test("signing in through a browser saves the tokens for this user only and names the account", async () => {
  await using fake = new FakeOpenAi()
  fake.issueTokens("first", 3600)
  await using setup = await setupWith(fake)
  const before = await setup.openai()

  await setup.client.call("auth/start", { provider: "openai" })
  const waiting = await setup.waiting()
  const asked = browserUrl(waiting)
  const stranger = await fetch(`${redirectOf(asked)}?code=forged&state=not-the-state`)
  const browser = await fetch(callbackFor(waiting, "the-code"))
  const settled = await setup.settledSignIn()

  expect(before.health.status).toBe("signed_out")
  expect(before.signIn).toEqual(["browser", "device_code"])
  expect(asked.searchParams.get("code_challenge_method")).toBe("S256")
  expect(asked.searchParams.get("originator")).toBe("nisse")
  expect(stranger.status).toBe(400)
  expect(browser.status).toBe(200)
  expect(settled).toMatchObject({ phase: "succeeded", message: `${EMAIL} · ChatGPT Plus` })
  const exchange = new URLSearchParams(fake.received.find((request) => request.path === "/oauth/token")!.body)
  expect(exchange.get("code")).toBe("the-code")
  expect(new Bun.CryptoHasher("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(
    asked.searchParams.get("code_challenge")!,
  )
  expect(statSync(join(setup.server.home.dir, "auth", "openai.json")).mode & 0o777).toBe(0o600)
  expect((await setup.openai()).health).toMatchObject({ status: "ready", account: `${EMAIL} · ChatGPT Plus` })
})

test("the address a browser on another machine ends on, pasted back, finishes the sign-in", async () => {
  await using fake = new FakeOpenAi()
  fake.issueTokens("first", 3600)
  await using setup = await setupWith(fake)
  const started = (await setup.client.call("auth/start", { provider: "openai", method: "browser" })).result as AuthState
  const waiting = await setup.waiting()

  const answered = await setup.client.call("auth/respond", {
    provider: "openai",
    flow: started.flow,
    response: { _tag: "callback", url: callbackFor(waiting, "pasted-code").toString() },
  })

  expect(answered.result).toEqual({ accepted: true })
  expect(await setup.settledSignIn()).toMatchObject({ phase: "succeeded" })
  const exchange = new URLSearchParams(fake.received.find((request) => request.path === "/oauth/token")!.body)
  expect(exchange.get("code")).toBe("pasted-code")
})

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

test("a device code sign-in shows the code to enter, then finishes once someone enters it", async () => {
  await using fake = new FakeOpenAi()
  fake.issueTokens("first", 3600)
  await using setup = await setupWith(fake)
  await setup.client.call("auth/start", { provider: "openai", method: "device_code" })

  const waiting = await setup.waiting()
  const settled = await setup.settledSignIn()

  expect(waiting.interaction).toEqual({ _tag: "device_code", url: `${fake.base}/codex/device`, code: "ABCD-1234" })
  expect(settled).toMatchObject({ phase: "succeeded", message: `${EMAIL} · ChatGPT Plus` })
  const sent = (path: string) => fake.received.filter((request) => request.path === path).map((request) => request.body)
  expect(sent("/api/accounts/deviceauth/usercode").map((body) => JSON.parse(body))).toEqual([
    { client_id: CODEX_CLIENT_ID },
  ])
  expect(new Set(sent("/api/accounts/deviceauth/token"))).toEqual(
    new Set([JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-1234" })]),
  )
  const exchange = new URLSearchParams(sent("/oauth/token")[0])
  expect(exchange.get("client_id")).toBe(CODEX_CLIENT_ID)
  expect(exchange.get("redirect_uri")).toBe(`${fake.base}/deviceauth/callback`)
  expect(exchange.get("code")).toBe("device-code")
  expect(exchange.get("code_verifier")).toBe("device-verifier")
}, 10_000)

test("a cancelled sign-in ends for every connection and frees the callback port", async () => {
  await using fake = new FakeOpenAi()
  await using setup = await setupWith(fake)
  const started = (await setup.client.call("auth/start", { provider: "openai" })).result as AuthState
  const waiting = await setup.waiting()

  const cancelled = await setup.client.call("auth/cancel", { provider: "openai", flow: started.flow })
  const settled = await setup.settledSignIn()

  expect(cancelled.result).toEqual({ accepted: true })
  expect(settled).toMatchObject({ phase: "cancelled" })
  expect(await fetch(callbackFor(waiting, "late")).catch(() => "refused")).toBe("refused")
})

test("a connection that starts watching after a sign-in ended still learns how it ended", async () => {
  await using fake = new FakeOpenAi()
  await using setup = await setupWith(fake)
  const started = (await setup.client.call("auth/start", { provider: "openai", method: "device_code" }))
    .result as AuthState
  expect(await setup.settledSignIn()).toMatchObject({ phase: "failed" })

  const late = await RawClient.connect(setup.server.home.socket)
  const auth = late.watch<AuthState>("auth/watch")
  await auth.until((states) => states.length > 0)
  late.close()

  expect(auth.items[0]).toMatchObject({ provider: "openai", flow: started.flow, phase: "failed" })
})

test("signing out leaves the provider signed out", async () => {
  await using fake = new FakeOpenAi()
  await using setup = await setupWith(fake)
  await signIn(setup.server.home)
  expect((await setup.openai()).health.status).toBe("ready")

  const after = (await setup.client.call("auth/logout", { provider: "openai" })).result as ProviderSnapshot

  expect(after.health.status).toBe("signed_out")
  expect((await setup.openai()).health.status).toBe("signed_out")
})

const modelList = (slug: string) => ({
  models: [
    {
      slug,
      display_name: slug.toUpperCase(),
      visibility: "list",
      priority: 1,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      context_window: 272000,
    },
    { slug: "hidden", visibility: "hide", priority: 0 },
    { slug: "code-mode-only", visibility: "list", priority: 2, tool_mode: "code_mode_only" },
  ],
})

const openAiModels = async (client: RawClient) =>
  ((await client.call("models/list", {})).result as Array<ProviderModels>).find((list) => list.provider === "openai")!

test("OpenAI's models come from ChatGPT, leave out those nisse can't run, and the saved list answers when ChatGPT can't", async () => {
  await using fake = new FakeOpenAi()
  fake.modelList = modelList("gpt-test")
  const home = tempHome()
  try {
    {
      await using server = await runningServer([], { home, openai: fake.options() })
      await signIn(server.home)
      const client = await RawClient.connect(server.home.socket)
      const listed = await openAiModels(client)
      client.close()
      expect(listed).toEqual({
        provider: "openai",
        defaultModel: "gpt-5.5",
        models: [
          {
            id: "gpt-test",
            name: "GPT-TEST",
            efforts: ["low", "medium", "high"],
            defaultEffort: "medium",
            contextWindow: 272000,
          },
        ],
      })
    }
    fake.modelList = undefined
    await using server = await runningServer([], { home, openai: fake.options() })
    const client = await RawClient.connect(server.home.socket)
    expect((await openAiModels(client)).models.map((model) => model.id)).toEqual(["gpt-test"])
    client.close()
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test("a switched model and effort reach ChatGPT from the next run on", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  fake.play("text_answer")
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))

  const switched = await session.client.call("conversation/select_model", {
    conversation: session.conversation,
    author: "ada",
    selection: { provider: "openai", model: "gpt-test", effort: "high" },
  })
  await session.submit("again")
  await session.view.until(settled(2))

  expect(switched.error).toBeUndefined()
  const [first, second] = fake.responses().map((request) => JSON.parse(request.body))
  expect(first.model).toBe("gpt-5.5")
  expect(first.reasoning).toBeUndefined()
  expect(second).toMatchObject({ model: "gpt-test", reasoning: { effort: "high" } })
})
