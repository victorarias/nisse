import { type ProviderInstance, type ProviderKind, scriptInstance } from "@nisse/models"
import type { ModelSelection } from "@nisse/protocol"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, type Scope } from "effect"
import { expandHome, type HomeConfig, type Instance } from "../config.ts"
import type { Home } from "../home.ts"
import instructions from "../instructions.md" with { type: "text" }
import { defaultLimits } from "../agents.ts"
import { Providers, type Driver } from "../provider.ts"
import { claudeDriver, type ClaudeOptions } from "./claude/index.ts"
import { AUTH_BASE, BASE_URL, CALLBACK_PORT, openAiDriver, type OpenAiOptions } from "./openai/index.ts"
import { scriptDriver, type Script } from "./script.ts"

export interface ProviderOptions {
  readonly script?: Script
  readonly openai: (id: string) => OpenAiOptions
  readonly claude: ClaudeOptions
  readonly preferred: string
  readonly config: HomeConfig
}

export const openAiOptions =
  (home: Home) =>
  (id: string): OpenAiOptions => ({
    authPath: join(home.dir, "auth", `${id}.json`),
    modelsPath: join(home.dir, "cache", `${id}-models.json`),
    authBase: process.env.NISSE_OPENAI_URL ?? AUTH_BASE,
    baseUrl: process.env.NISSE_OPENAI_URL ?? BASE_URL,
    callbackPort: CALLBACK_PORT,
    instructions,
    home: home.dir,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    ...(process.env.NISSE_CODE_MODE_HOST ? { codeModeHost: process.env.NISSE_CODE_MODE_HOST } : {}),
  })

const claudeInstance = (base: ClaudeOptions, instance: Instance): ClaudeOptions => {
  const executable = instance.binary === undefined ? base.executable : expandHome(instance.binary)
  const args = instance.args ?? base.args
  return {
    ...(executable === undefined ? {} : { executable }),
    env: {
      ...base.env,
      ...instance.env,
      ...(instance.config_dir === undefined ? {} : { CLAUDE_CONFIG_DIR: expandHome(instance.config_dir) }),
    },
    ...(args === undefined ? {} : { args }),
  }
}

/** The instances a home has: the built-in `claude` and `openai`, then those its `config.toml` names. */
const configured = (config: HomeConfig): Record<string, Instance> => ({
  claude: { driver: "claude" },
  openai: { driver: "openai" },
  ...config.providers,
})

/** A driver's account, as an instance the kernel runs nothing on until its kind brings its run. */
const accountOf = (id: string, driver: Driver): ProviderInstance => {
  const { run: _run, skills: _skills, agentTypes: _agentTypes, tools: _tools, ...account } = driver
  return { ...account, id }
}

export const claudeKind = (base: ClaudeOptions): ProviderKind<Instance> => ({
  kind: "claude",
  open: (id, settings) => Effect.succeed(accountOf(id, claudeDriver(claudeInstance(base, settings)))),
})

export const openAiKind = (options: (id: string) => OpenAiOptions): ProviderKind<Instance> => ({
  kind: "openai",
  open: (id) => Effect.map(openAiDriver(options(id)), (driver) => accountOf(id, driver)),
})

/** Every provider instance of a home, by id: `script` when there is a script, then each one configured. */
export const openInstances = (options: ProviderOptions) =>
  Effect.gen(function* () {
    const kinds = { claude: claudeKind(options.claude), openai: openAiKind(options.openai) }
    const instances = new Map<string, ProviderInstance>()
    if (options.script) instances.set("script", scriptInstance(options.script))
    for (const [id, settings] of Object.entries(configured(options.config)))
      instances.set(id, yield* kinds[settings.driver].open(id, settings))
    return instances as ReadonlyMap<string, ProviderInstance>
  })

const instanceDriver = (
  options: ProviderOptions,
  id: string,
  instance: Instance,
): Effect.Effect<Driver, never, Scope.Scope> =>
  instance.driver === "claude"
    ? Effect.succeed(claudeDriver(claudeInstance(options.claude, instance)))
    : openAiDriver(options.openai(id))

export const providersLayer = (options: ProviderOptions) =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      const drivers = new Map<string, Driver>()
      if (options.script) drivers.set("script", scriptDriver(options.script))
      for (const [id, instance] of Object.entries(configured(options.config)))
        drivers.set(id, yield* instanceDriver(options, id, instance))
      const defaultModel: ModelSelection | undefined = options.config.default_model
      const agents = options.config.agents
      return Providers.of({
        drivers,
        preferred: options.preferred,
        agents: {
          maxDepth: agents?.max_depth ?? defaultLimits.maxDepth,
          maxThreads: agents?.max_threads ?? defaultLimits.maxThreads,
        },
        ...(defaultModel ? { defaultModel } : {}),
      })
    }),
  )
