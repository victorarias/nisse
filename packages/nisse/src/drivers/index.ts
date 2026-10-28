import { join } from "node:path"
import { Effect, Layer } from "effect"
import type { Home } from "../home.ts"
import instructions from "../instructions.md" with { type: "text" }
import { Providers } from "../provider.ts"
import { AUTH_BASE, BASE_URL, openAiDriver, type OpenAiOptions } from "./openai/index.ts"
import { scriptDriver, type Script } from "./script.ts"

export interface ProviderOptions {
  readonly script: Script
  readonly openai: OpenAiOptions
}

export const openAiOptions = (home: Home): OpenAiOptions => ({
  authPath: join(home.dir, "auth", "openai.json"),
  authBase: AUTH_BASE,
  baseUrl: BASE_URL,
  instructions,
})

export const providersLayer = (options: ProviderOptions) =>
  Layer.effect(
    Providers,
    Effect.map(openAiDriver(options.openai), (openai) =>
      Providers.of({
        drivers: new Map([
          ["script", scriptDriver(options.script)],
          ["openai", openai],
        ]),
        preferred: "script",
      }),
    ),
  )
