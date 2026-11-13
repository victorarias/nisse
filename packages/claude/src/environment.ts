// How every Claude Code process nisse starts is set up: a run's, the account probe's and `claude auth`'s. Each gets the
// server's environment without what a Claude Code session sets for the commands it runs, so a server started in a shell
// inside Claude Code does not hand that session's identity to its own Claude Code; the provider instance's `env` goes
// on top. `CLAUDE_CODE_ENTRYPOINT` is left unset, so the SDK names its sessions `sdk-ts`.
import { resolveSettings, type SettingSource, type Settings } from "@anthropic-ai/claude-agent-sdk"
import { join } from "node:path"
import { Effect } from "effect"

/**
 * What a Claude Code session sets for its commands. Measured: Claude Code 2.1.312 under the Agent SDK showed these to
 * its Bash tool, and its 2.1.323 TUI also sets `CLAUDE_CODE_BRIDGE_SESSION_ID`.
 */
const HOST_SESSION = new Set([
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
])

/** The environment a Claude Code process starts with: the server's, less a host session's, then the instance's `own`. */
export const claudeEnvironment = (own: Readonly<Record<string, string>> | undefined): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !HOST_SESSION.has(name)) env[name] = value
  }
  return { ...env, ...own }
}

const TOOL_SEARCH = "ENABLE_TOOL_SEARCH"
const AUTO = /^auto(?::(\d+))?$/

/**
 * The `env` of the Claude Code settings a process started with `env` reads in `cwd`. `resolveSettings` takes the user
 * settings from the server's own `CLAUDE_CONFIG_DIR`, so an instance with a directory of its own has its
 * `settings.json` put in their place, at the same precedence.
 */
const settingsEnv = (cwd: string | undefined, sources: SettingSource[], env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const resolved = yield* Effect.tryPromise(() =>
      resolveSettings({ ...(cwd === undefined ? {} : { cwd }), settingSources: sources }),
    )
    const own = env.CLAUDE_CONFIG_DIR
    if (own === undefined || own === process.env.CLAUDE_CONFIG_DIR) return resolved.effective.env ?? {}
    const user = yield* Effect.tryPromise(() => Bun.file(join(own, "settings.json")).json() as Promise<Settings>).pipe(
      Effect.orElseSucceed((): Settings => ({})),
    )
    const layers = resolved.sources.map((layer) => layer.settings)
    const at = resolved.sources.findIndex((layer) => layer.source === "user")
    if (at >= 0) layers[at] = user
    else if (sources.includes("user")) layers.unshift(user)
    // Sources run from lowest precedence to highest, and Claude Code merges `env` name by name.
    return Object.assign({}, ...layers.map((layer) => layer.env ?? {})) as Record<string, string>
  }).pipe(
    // Settings Claude Code cannot read fail its own start, which says why; nisse then has nothing to override.
    Effect.orElseSucceed(() => undefined),
  )

/**
 * Settings that turn Claude Code's tool search on where the person's effective value is `auto` or `auto:N` with N from 0
 * to 100. In `auto`, Claude Code sends every MCP tool's schema in full while they fit, and a server that connects late
 * changes the tool list and misses the cache. A settings file's `env` beats the process's, so the value goes in the
 * `settings` option, which beats both. Any other value, or none, is left alone.
 */
export const toolSearchSettings = (
  cwd: string | undefined,
  sources: SettingSource[],
  env: Readonly<Record<string, string>>,
) =>
  Effect.map(settingsEnv(cwd, sources, env), (settings) => {
    const value = (settings?.[TOOL_SEARCH] ?? env[TOOL_SEARCH])?.trim()
    const auto = value === undefined ? null : AUTO.exec(value)
    if (auto === null) return undefined
    if (auto[1] !== undefined && Number(auto[1]) > 100) return undefined
    return { env: { [TOOL_SEARCH]: "true" } }
  })
