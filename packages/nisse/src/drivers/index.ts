import type { ModelSelection } from "@nisse/protocol"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { expandHome, type HomeConfig, type Instance } from "../config.ts"
import type { Home } from "../home.ts"
import instructions from "../instructions.md" with { type: "text" }
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
    authBase: AUTH_BASE,
    baseUrl: BASE_URL,
    callbackPort: CALLBACK_PORT,
    instructions,
    home: home.dir,
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

const instanceDriver = (options: ProviderOptions, id: string, instance: Instance): Effect.Effect<Driver> =>
  instance.driver === "claude"
    ? Effect.succeed(claudeDriver(claudeInstance(options.claude, instance)))
    : openAiDriver(options.openai(id))

export const providersLayer = (options: ProviderOptions) =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      const instances: Record<string, Instance> = {
        claude: { driver: "claude" },
        openai: { driver: "openai" },
        ...options.config.providers,
      }
      const drivers = new Map<string, Driver>()
      if (options.script) drivers.set("script", scriptDriver(options.script))
      for (const [id, instance] of Object.entries(instances))
        drivers.set(id, yield* instanceDriver(options, id, instance))
      const defaultModel: ModelSelection | undefined = options.config.default_model
      return Providers.of({
        drivers,
        preferred: options.preferred,
        ...(defaultModel ? { defaultModel } : {}),
      })
    }),
  )
