// A home's providers on the kernel wire (NISSE_KERNEL=1): a real server in process, driven as a raw JSON-RPC client
// over its socket, with ChatGPT and Claude Code played by their fakes.
import { expect, test } from "bun:test"
import type { AuthState, ProviderModels, ProviderSnapshot } from "@nisse/wire"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { FakeClaude } from "../support/claude.ts"
import { EMAIL, FakeOpenAi, signIn } from "../support/openai.ts"
import { errorTag, RawClient } from "../support/raw.ts"
import { runningKernelServer, watchView } from "../support/kernel.ts"
import { tempHome } from "../support/server.ts"

const startWith = async (client: RawClient, ask: Record<string, string> = {}) => {
  const reply = await client.call("conversation/start", { cwd: "/work", ...ask })
  return reply.result as { conversation: string; model: unknown }
}

const modelOf = async (client: RawClient, ask: Record<string, string> = {}) => (await startWith(client, ask)).model

/** The model the conversation's agent runs, as every client's view shows it. */
const agentOf = async (client: RawClient, conversation: string) => {
  const view = watchView(client, conversation)
  await view.until(() => true)
  const { model, thinkingLevel } = view.view().docs["pi.agent"] as { model: unknown; thinkingLevel: unknown }
  return { model, thinkingLevel }
}

const listed = async (client: RawClient) =>
  (await client.call("providers/list", {})).result as ReadonlyArray<ProviderSnapshot>

test("provider-config, signin-status, model-list: two instances of one provider each list, report their health and their models", async () => {
  using claude = new FakeClaude("models")
  // Its own fake, through the instance's env: each Claude provider probes its own Claude Code.
  using alt = new FakeClaude("models")
  await using fake = new FakeOpenAi()
  await using server = await runningKernelServer([], {
    openai: fake.options(),
    claude: claude.options,
    config: {
      default_model: { provider: "openai-work", model: "gpt-5.5", effort: "high" },
      providers: { "openai-work": { driver: "openai" }, "claude-alt": { driver: "claude", env: alt.options.env! } },
    },
  })
  await signIn(server.home)
  const client = await RawClient.connect(server.home.socket)

  const providers = await listed(client)
  expect(providers.map(({ id, driver, signIn, health }) => ({ id, driver, signIn, status: health.status }))).toEqual([
    { id: "script", driver: "script", signIn: [], status: "ready" },
    { id: "claude", driver: "claude", signIn: ["terminal"], status: "ready" },
    { id: "openai", driver: "openai", signIn: ["browser", "device_code"], status: "ready" },
    { id: "openai-work", driver: "openai", signIn: ["browser", "device_code"], status: "signed_out" },
    { id: "claude-alt", driver: "claude", signIn: ["terminal"], status: "ready" },
  ])
  const health = (id: string) => providers.find((provider) => provider.id === id)!.health
  expect(health("openai").account).toBe(`${EMAIL} · ChatGPT Plus`)
  expect(health("openai-work").message).toBe("not signed in to ChatGPT")
  expect([health("claude").account, health("claude-alt").account]).toEqual([
    "person@example.com · Claude Max",
    "person@example.com · Claude Max",
  ])

  const models = (await client.call("models/list", {})).result as ReadonlyArray<ProviderModels>
  expect(models.map((list) => [list.provider, list.defaultModel])).toEqual([
    ["script", "script"],
    ["claude", undefined],
    ["openai", "gpt-5.5"],
    ["openai-work", "gpt-5.5"],
    ["claude-alt", undefined],
  ])
  const modelIds = (provider: string) => models.find((list) => list.provider === provider)!.models.map((m) => m.id)
  expect(modelIds("openai-work")).toEqual(modelIds("openai"))
  expect(modelIds("openai")).toContain("gpt-5.5")
  expect(modelIds("claude-alt")).toEqual(modelIds("claude"))
  expect(modelIds("claude")).toEqual(["sonnet", "fable", "opus", "haiku"])

  // A conversation that names no provider takes the home's default_model, on the instance it names.
  const started = await startWith(client)
  expect(started.model).toEqual({ provider: "openai-work", model: "gpt-5.5", effort: "high" })
  expect(await agentOf(client, started.conversation)).toEqual({
    model: { provider: "openai-work", modelId: "gpt-5.5" },
    thinkingLevel: "high",
  })
  client.close()
}, 20_000)

test("model-default: a new conversation takes the project's default model, else the home's, else the one chosen last, across a restart", async () => {
  const project = mkdtempSync("/tmp/nisse-work-")
  const inside = `${project}/src`
  await Bun.write(`${project}/.nisse/config.toml`, 'default_model = { provider = "script", effort = "low" }\n')
  await Bun.write(`${inside}/keep`, "")
  const home = tempHome()
  try {
    {
      await using server = await runningKernelServer([], {
        home,
        config: { default_model: { provider: "openai", model: "gpt-test" } },
      })
      const client = await RawClient.connect(server.home.socket)
      expect(await modelOf(client, { cwd: inside })).toEqual({ provider: "script", model: "script", effort: "low" })
      expect(await modelOf(client)).toEqual({ provider: "openai", model: "gpt-test" })
      expect(await modelOf(client, { model: "gpt-other" })).toEqual({ provider: "openai", model: "gpt-other" })
      client.close()
    }
    {
      await using server = await runningKernelServer([], { home })
      const client = await RawClient.connect(server.home.socket)
      await startWith(client, { provider: "claude", model: "opus" })
      expect(await modelOf(client)).toEqual({ provider: "claude", model: "opus" })
      client.close()
    }
    await using server = await runningKernelServer([], { home })
    const client = await RawClient.connect(server.home.socket)
    expect(await modelOf(client)).toEqual({ provider: "claude", model: "opus" })
    client.close()
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test("provider-unknown, model-flags: a conversation starts on the model and effort it names, and nisse refuses a provider or effort it does not have", async () => {
  await using server = await runningKernelServer()
  const client = await RawClient.connect(server.home.socket)

  const started = await startWith(client, { provider: "script", effort: "low" })
  expect(started.model).toEqual({ provider: "script", model: "script", effort: "low" })
  expect(await agentOf(client, started.conversation)).toEqual({
    model: { provider: "script", modelId: "script" },
    thinkingLevel: "low",
  })

  expect(errorTag(await client.call("conversation/start", { cwd: "/work", provider: "nope" }))).toBe("UnknownProvider")
  const loud = await client.call("conversation/start", { cwd: "/work", effort: "loud" })
  expect(errorTag(loud)).toBe("UnknownEffort")
  expect(loud.error?.data[0]?.error).toMatchObject({
    effort: "loud",
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  })
  client.close()
})

test("signin-device-code, signout: one instance signs in and out on its own, and every connection sees it", async () => {
  await using fake = new FakeOpenAi()
  fake.issueTokens("work", 3600)
  await using server = await runningKernelServer([], {
    openai: fake.options(),
    config: { providers: { "openai-work": { driver: "openai" } } },
  })
  const client = await RawClient.connect(server.home.socket)
  const auth = client.watch<AuthState>("auth/watch")
  const status = async (id: string) => (await listed(client)).find((provider) => provider.id === id)!.health.status

  await client.call("auth/start", { provider: "openai-work", method: "device_code" })
  await auth.until((states) => states.some((state) => state.phase === "succeeded"))
  expect(auth.items.find((state) => state.phase === "waiting")!.interaction).toEqual({
    _tag: "device_code",
    url: `${fake.base}/codex/device`,
    code: "ABCD-1234",
  })
  expect(auth.items.at(-1)).toMatchObject({ provider: "openai-work", message: `${EMAIL} · ChatGPT Plus` })
  expect(existsSync(`${server.home.dir}/auth/openai-work.json`)).toBe(true)
  expect(existsSync(`${server.home.dir}/auth/openai.json`)).toBe(false)
  expect([await status("openai-work"), await status("openai")]).toEqual(["ready", "signed_out"])

  const other = await RawClient.connect(server.home.socket)
  const after = (await other.call("auth/logout", { provider: "openai-work" })).result as ProviderSnapshot
  other.close()
  await auth.until((states) => states.at(-1)?.phase === "signed_out")
  expect(after.health.status).toBe("signed_out")
  expect(auth.items.at(-1)).toMatchObject({ provider: "openai-work", phase: "signed_out" })
  expect(existsSync(`${server.home.dir}/auth/openai-work.json`)).toBe(false)

  expect(
    errorTag(await client.call("auth/start", { provider: "script" })),
    "a provider with nothing to sign in to",
  ).toBe("CannotSignIn")
  client.close()
}, 20_000)

test("provider-binary: a Claude provider whose binary is missing is unavailable, saying where it looked", async () => {
  const missing = "/tmp/nisse-no-claude-here"
  await using server = await runningKernelServer([], {
    config: { providers: { "claude-gone": { driver: "claude", binary: missing } } },
  })
  const client = await RawClient.connect(server.home.socket)
  const gone = (await listed(client)).find((provider) => provider.id === "claude-gone")!.health
  client.close()
  expect(gone.status).toBe("unavailable")
  expect(gone.message).toContain(missing)
  expect(gone.message).toEndWith("; install Claude Code or set its binary")
})

test("signin-shared: a sign-in the server stopped during is failed for every connection of the next server", async () => {
  await using fake = new FakeOpenAi()
  const home = tempHome()
  let flow: string
  {
    await using server = await runningKernelServer([], { home, openai: fake.options() })
    const client = await RawClient.connect(server.home.socket)
    const auth = client.watch<AuthState>("auth/watch")
    flow = ((await client.call("auth/start", { provider: "openai" })).result as AuthState).flow
    await auth.until((states) => states.some((state) => state.phase === "waiting"))
    client.close()
  }
  await using server = await runningKernelServer([], { home, openai: fake.options() })
  const client = await RawClient.connect(server.home.socket)
  const auth = client.watch<AuthState>("auth/watch")
  await auth.until((states) => states.length > 0)
  expect(auth.items).toEqual([
    { provider: "openai", flow, phase: "failed", message: "the server stopped before this sign-in finished" },
  ])
  const late = await client.call("auth/respond", {
    provider: "openai",
    flow,
    response: { _tag: "callback", url: "http://localhost:1455/auth/callback?code=x" },
  })
  expect(late.result).toEqual({ accepted: false })
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

const browserCallback = (state: AuthState) => {
  if (state.interaction?._tag !== "browser") throw new Error(`not a browser sign-in: ${JSON.stringify(state)}`)
  const asked = new URL(state.interaction.url)
  const answer = new URL(asked.searchParams.get("redirect_uri")!)
  answer.hostname = "127.0.0.1"
  return { answer, state: asked.searchParams.get("state")! }
}

test("signin-refused: an answer for another sign-in is turned away, and a sign-in the browser refused fails saying why", async () => {
  await using fake = new FakeOpenAi()
  await using server = await runningKernelServer([], { openai: fake.options() })
  const client = await RawClient.connect(server.home.socket)
  const auth = client.watch<AuthState>("auth/watch")
  await client.call("auth/start", { provider: "openai" })
  await auth.until((states) => states.some((state) => state.phase === "waiting"))
  const { answer, state } = browserCallback(auth.items.find((item) => item.phase === "waiting")!)
  const stranger = new URL(answer)
  stranger.search = new URLSearchParams({ code: "forged", state: "not-the-state" }).toString()
  expect((await fetch(stranger)).status).toBe(400)
  const refused = new URL(answer)
  refused.search = new URLSearchParams({ state, error: "access_denied", error_description: "no thanks" }).toString()
  expect((await fetch(refused)).status).toBe(400)
  await auth.until((states) => states.at(-1)?.phase === "failed")
  expect(auth.items.at(-1)).toMatchObject({ provider: "openai", message: "ChatGPT refused the sign-in: no thanks" })
  expect(fake.received.filter((request) => request.path === "/oauth/token")).toHaveLength(0)
  client.close()
})

test("signin-cannot: nisse refuses to sign in to a provider it does not have, one with nothing to sign in to, and a way the provider does not offer", async () => {
  await using fake = new FakeOpenAi()
  await using server = await runningKernelServer([], { openai: fake.options() })
  const client = await RawClient.connect(server.home.socket)
  const unknown = await client.call("auth/start", { provider: "nowhere" })
  expect(errorTag(unknown)).toBe("UnknownProvider")
  const script = await client.call("auth/start", { provider: "script" })
  expect(errorTag(script)).toBe("CannotSignIn")
  const terminal = await client.call("auth/start", { provider: "openai", method: "terminal" })
  expect(errorTag(terminal)).toBe("CannotSignIn")
  expect(terminal.error?.data[0]?.error).toMatchObject({
    provider: "openai",
    message: expect.stringContaining("terminal"),
  })
  client.close()
})
