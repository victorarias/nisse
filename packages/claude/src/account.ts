// A Claude Code instance's account: how it is signed in and which models it has, from a probe of Claude Code, and
// signing in and out with its own commands. Its conversations run as `claude.run` tasks (`./run.ts`).
import { query, type AccountInfo, type ModelInfo as ClaudeModel } from "@anthropic-ai/claude-agent-sdk"
import { type Health, type ModelInfo, type ProviderAccount, ProviderError } from "@nisse/models"
import { tmpdir } from "node:os"
import { Effect, Semaphore } from "effect"
import { Inbox } from "./inbox.ts"
import { bundledExecutable, type ClaudeProcessSettings } from "./process.ts"

const PATIENCE = "25 seconds"

interface Probed {
  readonly health: Health
  readonly models: ReadonlyArray<ModelInfo>
}

interface ProbeOptions {
  readonly executable: string
  readonly env: Readonly<Record<string, string>>
}
const SUBSCRIPTIONS: Record<string, string> = {
  max: "Claude Max",
  pro: "Claude Pro",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
}

const customEndpoint = (env: Readonly<Record<string, string | undefined>>) => {
  const url = env.ANTHROPIC_BASE_URL?.trim()
  if (!url) return false
  try {
    return new URL(url).hostname !== "api.anthropic.com"
  } catch {
    return false
  }
}

const filled = (value: string | undefined) => (value === undefined || value === "" ? undefined : value)

const healthOf = (account: AccountInfo, version: string | undefined, custom: boolean): Health => {
  const backend = filled(account.apiProvider === "firstParty" ? undefined : account.apiProvider)
  const apiKey = filled(account.apiKeySource === "none" ? undefined : account.apiKeySource)
  const email = filled(account.email)
  const subscription = filled(account.subscriptionType)
  const signedIn =
    custom ||
    backend !== undefined ||
    filled(account.tokenSource) !== "none" ||
    apiKey !== undefined ||
    email !== undefined ||
    subscription !== undefined
  const known = version ? { version } : {}
  if (!signedIn) return { status: "signed_out", message: "not signed in to Claude Code", ...known }
  const plan = apiKey
    ? `API key from ${apiKey}`
    : backend
      ? backend
      : subscription
        ? (SUBSCRIPTIONS[subscription.toLowerCase()] ?? subscription)
        : custom
          ? "a custom API endpoint"
          : undefined
  const parts = [email, plan].filter((part) => part !== undefined)
  return { status: "ready", ...known, ...(parts.length > 0 ? { account: parts.join(" · ") } : {}) }
}

const modelsOf = (models: ReadonlyArray<ClaudeModel>): ReadonlyArray<ModelInfo> =>
  models
    .filter((model) => model.value !== "default")
    .map((model) => ({
      id: model.value,
      name: model.displayName || model.value,
      ...(model.description ? { description: model.description } : {}),
      efforts: model.supportsEffort ? [...(model.supportedEffortLevels ?? [])] : [],
    }))

const probe = (options: ProbeOptions): Effect.Effect<Probed> =>
  Effect.gen(function* () {
    const inbox = new Inbox<never>()
    const abort = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (abort) =>
        Effect.sync(() => {
          inbox.close()
          abort.abort()
        }),
    )
    const env = { ...process.env, ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }
    const started = query({
      prompt: inbox,
      options: {
        cwd: tmpdir(),
        abortController: abort,
        pathToClaudeCodeExecutable: options.executable,
        settingSources: ["user"],
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        mcpServers: {},
        persistSession: false,
        env,
      },
    })
    const initialized = yield* Effect.tryPromise({
      try: () => started.initializationResult(),
      catch: (error) => error,
    }).pipe(
      Effect.timeoutOrElse({
        duration: PATIENCE,
        orElse: () => Effect.fail(new Error("claude did not answer within 25 seconds")),
      }),
    )
    const version = (initialized as { claude_code_version?: string }).claude_code_version
    return {
      health: healthOf(initialized.account ?? {}, version, customEndpoint(env)),
      models: modelsOf(initialized.models ?? []),
    }
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.succeed<Probed>({
        health: {
          status: "unavailable",
          message: `${error instanceof Error ? error.message : String(error)}; install Claude Code or set its binary`,
        },
        models: [],
      }),
    ),
  )

const failure = (message: string) => new ProviderError({ message })

/** The account of the Claude Code `settings` start; the probe's answer is kept until a refresh or a sign-in. */
export const claudeAccount = (settings: ClaudeProcessSettings): ProviderAccount => {
  const executable = settings.executable ?? bundledExecutable()
  const env = settings.env ?? {}
  const probing = Semaphore.makeUnsafe(1)
  let probed: Probed | undefined
  const probedNow = (refresh: boolean) =>
    probing.withPermits(1)(
      Effect.suspend(() =>
        probed && !refresh
          ? Effect.succeed(probed)
          : Effect.tap(probe({ executable, env }), (found) => Effect.sync(() => (probed = found))),
      ),
    )
  const command = (args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn([executable, ...args], {
          cwd: tmpdir(),
          env: { ...process.env, ...env },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        })
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`)
      },
      catch: (error) =>
        failure(`\`claude ${args.join(" ")}\` failed: ${error instanceof Error ? error.message : String(error)}`),
    })
  return {
    kind: "claude",
    health: (refresh) => Effect.map(probedNow(refresh), (found) => found.health),
    models: (refresh) => Effect.map(probedNow(refresh), (found) => found.models),
    signInMethods: ["terminal"],
    signIn: (_method, flow) =>
      Effect.gen(function* () {
        yield* flow.show({ _tag: "terminal", command: [executable, "auth", "login"], env })
        while (true) {
          const response = yield* flow.response
          if (response._tag !== "terminal_exited") continue
          if (!response.success) return yield* failure("`claude auth login` did not finish")
          probed = undefined
          return
        }
      }),
    signOut: Effect.tap(command(["auth", "logout"]), () => Effect.sync(() => (probed = undefined))),
  }
}
