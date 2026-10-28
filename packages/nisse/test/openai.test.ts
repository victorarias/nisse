import { expect, test } from "bun:test"
import type { AuthState, Delivery, ProviderModels, ProviderSnapshot } from "@nisse/protocol"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { installedCodeModeHost } from "./support/code-mode-host.ts"
import { accessToken, ACCOUNT, EMAIL, FakeOpenAi, matches, signIn } from "./support/openai.ts"
import { bodies, deadline, RawClient } from "./support/raw.ts"
import { runningServer, tempHome } from "./support/server.ts"

const settled = (count: number) => (deliveries: ReadonlyArray<Delivery>) =>
  bodies(deliveries).filter((body) => body._tag === "run_end").length >= count && deliveries.at(-1)?.status === "idle"

const said = (deliveries: ReadonlyArray<Delivery>): Array<unknown> =>
  bodies(deliveries).filter(
    (body) => body._tag !== "user" && body._tag !== "approval" && body._tag !== "approval_answer",
  )

const conversationWith = async (
  fake: FakeOpenAi,
  options: {
    approvals?: string
    signedIn?: boolean
    model?: string
    codeModeHost?: string
    cwd?: (home: string) => string
  } = {},
) => {
  const server = await runningServer([], { openai: fake.options(undefined, options.codeModeHost) })
  if (options.signedIn ?? true) await signIn(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", {
      cwd: options.cwd?.(server.home.dir) ?? server.home.dir,
      provider: "openai",
      ...(options.model === undefined ? {} : { model: options.model }),
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

test("signing out leaves the provider signed out and tells every connection", async () => {
  await using fake = new FakeOpenAi()
  await using setup = await setupWith(fake)
  await signIn(setup.server.home)
  expect((await setup.openai()).health.status).toBe("ready")

  const other = await RawClient.connect(setup.server.home.socket)
  const after = (await other.call("auth/logout", { provider: "openai" })).result as ProviderSnapshot
  other.close()
  await setup.auth.until((states) => states.some((state) => state.phase === "signed_out"))

  expect(after.health.status).toBe("signed_out")
  expect((await setup.openai()).health.status).toBe("signed_out")
  expect(setup.auth.items.at(-1)).toMatchObject({ provider: "openai", phase: "signed_out" })
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
  ],
})

const openAiModels = async (client: RawClient) =>
  ((await client.call("models/list", {})).result as Array<ProviderModels>).find((list) => list.provider === "openai")!

test("OpenAI's models come from ChatGPT, and the saved list answers when ChatGPT can't", async () => {
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

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

const project = (home: string) => {
  const repo = join(home, "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  write(join(home, "AGENTS.md"), "Home rules.")
  write(join(repo, "AGENTS.md"), "Repo rules.")
  write(join(repo, "app", "AGENTS.md"), "App rules.")
  write(join(repo, "app", "AGENTS.override.md"), "App override rules.")
  write(
    join(repo, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review a diff\n---\nLook hard.",
  )
  write(
    join(repo, "app", ".claude", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Nearer review\n---\nLook nearer.",
  )
  write(join(home, "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: >\n  Ship it\n  carefully\n---\nShip.")
  return join(repo, "app")
}

test("ChatGPT is told the AGENTS.md files from home to the working directory, and the skills it can use", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake, { cwd: project })
  await session.submit("hello")
  await session.view.until(settled(1))

  const app = join(session.server.home.dir, "repo", "app")
  const { instructions } = JSON.parse(fake.responses()[0]!.body)
  const order = ["Home rules.", "Repo rules.", "App override rules."].map((rule) => instructions.indexOf(rule))
  expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true)
  expect(instructions).not.toContain("App rules.")
  expect(instructions).toContain(
    `- review: Nearer review (file: ${join(app, ".claude", "skills", "review", "SKILL.md")})`,
  )
  expect(instructions).toContain("- ship: Ship it carefully")
})

test("a skill named in a message comes with it, for the model and for everyone watching", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake, { cwd: project })
  await session.submit("/review this, then $ship and $nothing")
  await session.view.until(settled(1))

  const user = bodies(session.view.deliveries).find((body) => body._tag === "user")
  expect(user).toMatchObject({
    skills: [{ name: "review", text: expect.stringContaining("Look nearer.") }, { name: "ship" }],
  })
  const { input } = JSON.parse(fake.responses()[0]!.body)
  const sent = JSON.stringify(input)
  expect(sent).toContain("<name>review</name>")
  expect(sent).toContain("Look nearer.")
  expect(sent).toContain("<name>ship</name>")
})

test("every client can list the skills a conversation's model can use", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake, { cwd: project })
  const listed = await session.client.call("skills/list", { conversation: session.conversation })
  expect(listed.result.map((skill: { name: string; description: string }) => [skill.name, skill.description])).toEqual([
    ["review", "Nearer review"],
    ["ship", "Ship it carefully"],
  ])
})

const CODE_MODE_MODEL = "gpt-6.1-sol"
const codeModeHost = installedCodeModeHost()
const withCodeModeHost = test.skipIf(codeModeHost === undefined)
const inCodeMode = { model: CODE_MODE_MODEL, codeModeHost: codeModeHost ?? "" }

const resultsOf = (deliveries: ReadonlyArray<Delivery>) =>
  bodies(deliveries).flatMap((body) => (body._tag === "tool_result" ? [body] : []))

const allowEach = async (session: Awaited<ReturnType<typeof conversationWith>>, count: number) => {
  for (let answered = 0; answered < count; answered++) {
    await session.view.until(
      (deliveries) => bodies(deliveries).filter((body) => body._tag === "approval").length > answered,
    )
    const approval = bodies(session.view.deliveries).filter((body) => body._tag === "approval")[answered] as {
      approval: string
    }
    await session.client.call("approval/resolve", {
      conversation: session.conversation,
      approval: approval.approval,
      author: "ada",
      allow: true,
    })
  }
}

withCodeModeHost("a code-mode model is offered exec and wait, with nisse's tools declared inside exec", async () => {
  await using fake = new FakeOpenAi()
  fake.play("code_mode_script")
  await using session = await conversationWith(fake, inCodeMode)
  await session.submit("what does echo say?")
  await session.view.until(settled(1))
  const tools = JSON.parse(fake.responses()[0]!.body).tools
  expect(tools.map((tool: { type: string; name: string }) => [tool.type, tool.name])).toEqual([
    ["custom", "exec"],
    ["function", "wait"],
  ])
  for (const declared of [
    "Read(args: {",
    "Write(args: {",
    "Edit(args: {",
    "Bash(args: {",
    "Grep(args: {",
    "Glob(args: {",
  ])
    expect(tools[0].description).toContain(declared)
  expect(tools[0].description).toContain("apply_patch(input: string)")
  expect(tools[0].description).toContain("  // The shell command to run.\n  command: string;")
})

withCodeModeHost(
  "a script's nested call is committed under its script and asks first, and the model sees only the script",
  async () => {
    await using fake = new FakeOpenAi()
    const expected = fake.play("code_mode_script")
    await using session = await conversationWith(fake, { ...inCodeMode, approvals: "ask" })
    await session.submit("what does echo say?")
    await allowEach(session, 1)
    await session.view.until(settled(1))
    const entries = bodies(session.view.deliveries)
    const calls = entries.flatMap((body) => (body._tag === "tool_call" ? [body] : []))
    expect(calls[0]).toMatchObject({ call: "call_1", tool: "exec" })
    expect(calls[1]).toMatchObject({ tool: "Bash", input: { command: "echo hi" }, parent: "call_1" })
    const approvals = entries.filter((body) => body._tag === "approval")
    expect(approvals).toEqual([expect.objectContaining({ call: calls[1]!.call, tool: "Bash" })])
    const [nested, script] = resultsOf(session.view.deliveries)
    expect(nested).toMatchObject({ call: calls[1]!.call, output: "hi\n", error: false })
    expect(script!.output).toStartWith("Script completed\n")
    expect(script!.output).toEndWith("Output:\nhi\n")
    expect(said(session.view.deliveries).at(-2)).toEqual({ _tag: "message", text: "It says hi." })
    expectRequests(fake, expected)
  },
)

withCodeModeHost("a script that yields is resumed by wait", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_wait")
  await using session = await conversationWith(fake, inCodeMode)
  await session.submit("count slowly")
  await session.view.until(settled(1))
  const [yielded, finished] = resultsOf(session.view.deliveries).map((result) => result.output)
  expect(yielded).toStartWith("Script running with cell ID 1\n")
  expect(yielded).toEndWith("started")
  expect(finished).toStartWith("Script completed\n")
  expect(finished).toEndWith("finished")
  expectRequests(fake, expected)
})

withCodeModeHost("terminating a script ends the call it was waiting on before the model hears it stopped", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_terminate")
  await using session = await conversationWith(fake, { ...inCodeMode, approvals: "ask" })
  await session.submit("run it, then stop it")
  await session.view.until(settled(1))
  const entries = bodies(session.view.deliveries)
  const bash = entries.find((body) => body._tag === "tool_call" && body.tool === "Bash") as { call: string }
  const ended = entries.findIndex((body) => body._tag === "tool_result" && body.call === bash.call)
  const waited = entries.findIndex((body) => body._tag === "tool_result" && body.call === "call_2")
  expect(entries[ended]).toMatchObject({ output: "interrupted; it may or may not have taken effect", error: true })
  expect(ended).toBeLessThan(waited)
  const approval = entries.find((body) => body._tag === "approval") as { approval: string }
  const late = await session.client.call("approval/resolve", {
    conversation: session.conversation,
    approval: approval.approval,
    author: "ada",
    allow: true,
  })
  expect(late.result).toEqual({ accepted: false })
  expect(existsSync(join(session.server.home.dir, "late.txt"))).toBe(false)
  expectRequests(fake, expected)
})

withCodeModeHost("a patch that moves a file to another spelling of its own path keeps the file", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_patch_same_path")
  await using session = await conversationWith(fake, { ...inCodeMode, approvals: "auto" })
  const notes = join(session.server.home.dir, "notes.txt")
  writeFileSync(notes, "draft\n")
  await session.submit("finalize the notes")
  await session.view.until(settled(1))
  const patched = resultsOf(session.view.deliveries).find((result) => result.call !== "call_1")!
  expect(patched).toMatchObject({ error: false })
  expect(readFileSync(notes, "utf8")).toBe("final\n")
  expectRequests(fake, expected)
})

withCodeModeHost("a host that dies mid-script interrupts the script with the nested results so far", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_host_dies")
  const launcher = mkdtempSync("/tmp/nisse-host-")
  const pidFile = join(launcher, "host.pid")
  const host = join(launcher, "host")
  writeFileSync(host, `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${codeModeHost}' "$@"\n`)
  chmodSync(host, 0o755)
  try {
    await using session = await conversationWith(fake, { model: CODE_MODE_MODEL, codeModeHost: host })
    writeFileSync(join(session.server.home.dir, "Cargo.toml"), '[package]\nname = "manifest"\n')
    await session.submit("read the manifest, then wait")
    await session.view.until((deliveries) => resultsOf(deliveries).length > 0)
    expect(resultsOf(session.view.deliveries)[0]!.output).toContain("[package]")
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL")
    await session.view.until(settled(1))
    const script = resultsOf(session.view.deliveries).find((result) => result.call === "call_1")!
    expect(script.output).toStartWith("interrupted: the code-mode host stopped")
    expect(script.output).toContain("The calls it made that finished:\n- Read (done):")
    expect(script.output).toContain("[package]")
    expectRequests(fake, expected)
  } finally {
    rmSync(launcher, { recursive: true, force: true })
  }
})

withCodeModeHost("a host that dies while the model waits tells the wait what the script finished", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_host_dies_in_wait")
  const launcher = mkdtempSync("/tmp/nisse-host-")
  const pidFile = join(launcher, "host.pid")
  const host = join(launcher, "host")
  writeFileSync(host, `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${codeModeHost}' "$@"\n`)
  chmodSync(host, 0o755)
  try {
    await using session = await conversationWith(fake, { model: CODE_MODE_MODEL, codeModeHost: host })
    writeFileSync(join(session.server.home.dir, "Cargo.toml"), '[package]\nname = "manifest"\n')
    await session.submit("read the manifest in the background")
    await session.view.until((deliveries) =>
      bodies(deliveries).some((body) => body._tag === "tool_call" && body.call === "call_2"),
    )
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL")
    await session.view.until(settled(1))
    const waited = resultsOf(session.view.deliveries).find((result) => result.call === "call_2")!
    expect(waited.output).toStartWith("interrupted: the code-mode host stopped")
    expect(waited.output).toContain("The calls it made that finished:\n- Read (done):")
    expect(waited.output).toContain("[package]")
    expectRequests(fake, expected)
  } finally {
    rmSync(launcher, { recursive: true, force: true })
  }
})

withCodeModeHost("a script stopped mid-run still tells the model what its calls finished", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_interrupted")
  await using session = await conversationWith(fake, inCodeMode)
  writeFileSync(join(session.server.home.dir, "Cargo.toml"), '[package]\nname = "manifest"\n')
  await session.submit("read the manifest slowly")
  await session.view.until((deliveries) => resultsOf(deliveries).length > 0)
  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await session.submit("what did it read?")
  await session.view.until(settled(2))
  const script = JSON.parse(fake.responses()[1]!.body).input.find(
    (item: { type: string }) => item.type === "custom_tool_call_output",
  )
  expect(script.output).toStartWith("interrupted; it may or may not have taken effect")
  expect(script.output).toContain("The calls it made that finished:\n- Read (done):")
  expect(script.output).toContain("[package]")
  expectRequests(fake, expected)
})

withCodeModeHost("a host that dies ends the calls its script was waiting on", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_host_dies_asking")
  const launcher = mkdtempSync("/tmp/nisse-host-")
  const pidFile = join(launcher, "host.pid")
  const host = join(launcher, "host")
  writeFileSync(host, `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${codeModeHost}' "$@"\n`)
  chmodSync(host, 0o755)
  try {
    await using session = await conversationWith(fake, {
      model: CODE_MODE_MODEL,
      codeModeHost: host,
      approvals: "ask",
    })
    await session.submit("write it late")
    await session.view.until((deliveries) => bodies(deliveries).some((body) => body._tag === "approval"))
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL")
    await session.view.until(settled(1))
    const entries = bodies(session.view.deliveries)
    const bash = entries.find((body) => body._tag === "tool_call" && body.tool === "Bash") as { call: string }
    const ended = entries.findIndex((body) => body._tag === "tool_result" && body.call === bash.call)
    const script = entries.findIndex((body) => body._tag === "tool_result" && body.call === "call_1")
    expect(entries[ended]).toMatchObject({ output: "interrupted; it may or may not have taken effect", error: true })
    expect(ended).toBeLessThan(script)
    const approval = entries.find((body) => body._tag === "approval") as { approval: string }
    const late = await session.client.call("approval/resolve", {
      conversation: session.conversation,
      approval: approval.approval,
      author: "ada",
      allow: true,
    })
    expect(late.result).toEqual({ accepted: false })
    expect(existsSync(join(session.server.home.dir, "late.txt"))).toBe(false)
    expectRequests(fake, expected)
  } finally {
    rmSync(launcher, { recursive: true, force: true })
  }
})

withCodeModeHost(
  "a waited script stopped after another script finished still tells what its calls finished",
  async () => {
    await using fake = new FakeOpenAi()
    const expected = fake.play("code_mode_two_scripts_interrupted")
    await using session = await conversationWith(fake, inCodeMode)
    writeFileSync(join(session.server.home.dir, "Cargo.toml"), '[package]\nname = "manifest"\n')
    await session.submit("read slowly while doing something else")
    await session.view.until((deliveries) =>
      bodies(deliveries).some((body) => body._tag === "tool_call" && body.call === "call_3"),
    )
    await session.client.call("conversation/interrupt", { conversation: session.conversation })
    await session.view.until(settled(1))
    await session.submit("what did the first script read?")
    await session.view.until(settled(2))
    const waited = JSON.parse(fake.responses()[3]!.body).input.find(
      (item: { type: string; call_id: string }) => item.type === "function_call_output" && item.call_id === "call_3",
    )
    expect(waited.output).toStartWith("interrupted; it may or may not have taken effect")
    expect(waited.output).toContain("The calls it made that finished:\n- Read (done):")
    expect(waited.output).toContain("[package]")
    expectRequests(fake, expected)
  },
)

withCodeModeHost("a host that dies ends the calls of every script it ran", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("code_mode_host_dies_two_scripts")
  const launcher = mkdtempSync("/tmp/nisse-host-")
  const pidFile = join(launcher, "host.pid")
  const host = join(launcher, "host")
  writeFileSync(host, `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${codeModeHost}' "$@"\n`)
  chmodSync(host, 0o755)
  try {
    await using session = await conversationWith(fake, {
      model: CODE_MODE_MODEL,
      codeModeHost: host,
      approvals: "ask",
    })
    await session.submit("start two scripts")
    await session.view.until((deliveries) =>
      bodies(deliveries).some((body) => body._tag === "tool_call" && body.call === "call_3"),
    )
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL")
    await session.view.until(settled(1))
    const entries = bodies(session.view.deliveries)
    const bash = entries.find((body) => body._tag === "tool_call" && body.tool === "Bash") as { call: string }
    const ended = entries.findIndex((body) => body._tag === "tool_result" && body.call === bash.call)
    const waited = entries.findIndex((body) => body._tag === "tool_result" && body.call === "call_3")
    expect(entries[ended]).toMatchObject({ output: "interrupted; it may or may not have taken effect", error: true })
    expect(ended).toBeLessThan(waited)
    const approval = entries.find((body) => body._tag === "approval") as { approval: string }
    const late = await session.client.call("approval/resolve", {
      conversation: session.conversation,
      approval: approval.approval,
      author: "ada",
      allow: true,
    })
    expect(late.result).toEqual({ accepted: false })
    expect(existsSync(join(session.server.home.dir, "late.txt"))).toBe(false)
    expectRequests(fake, expected)
  } finally {
    rmSync(launcher, { recursive: true, force: true })
  }
})

test("a code-mode model without the code-mode host says how to install it", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake, {
    model: CODE_MODE_MODEL,
    codeModeHost: "/nowhere/codex-code-mode-host",
  })
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(said(session.view.deliveries)).toEqual([
    { _tag: "run_end", outcome: "failed", message: expect.stringContaining("scripts/code-mode-host.sh") },
  ])
  expect(fake.responses()).toHaveLength(0)
})
