import { query, type AccountInfo, type ModelInfo as ClaudeModel } from "@anthropic-ai/claude-agent-sdk"
import type { ModelInfo } from "@nisse/protocol"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import type { Health } from "../../provider.ts"
import { Inbox } from "./inbox.ts"

const PATIENCE = "25 seconds"

export interface Probed {
  readonly health: Health
  readonly models: ReadonlyArray<ModelInfo>
}

export interface ProbeOptions {
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

export const probe = (options: ProbeOptions): Effect.Effect<Probed> =>
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
    const initialized = yield* Effect.tryPromise(() => started.initializationResult()).pipe(
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
