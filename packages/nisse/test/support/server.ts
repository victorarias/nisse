import { mkdtempSync, rmSync } from "node:fs"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import { homeAt, type Home } from "../../src/home.ts"
import { openAiOptions, providersLayer } from "../../src/drivers/index.ts"
import type { ClaudeOptions } from "../../src/drivers/claude/index.ts"
import type { OpenAiOptions } from "../../src/drivers/openai/index.ts"
import type { Script } from "../../src/drivers/script.ts"
import type { HomeConfig } from "../../src/config.ts"
import { Lifetime } from "../../src/lifetime.ts"
import { serverLayer } from "../../src/server.ts"

export const tempHome = () => homeAt(mkdtempSync("/tmp/nisse-"))

export interface ServerOptions {
  readonly home?: Home
  readonly openai?: (home: Home) => (id: string) => OpenAiOptions
  readonly claude?: ClaudeOptions
  readonly config?: HomeConfig
}

export const runningServer = async (script: Script = [], options: ServerOptions = {}) => {
  const home = options.home ?? tempHome()
  const providers = providersLayer({
    script,
    openai: (options.openai ?? openAiOptions)(home),
    claude: options.claude ?? {},
    preferred: "script",
    config: options.config ?? {},
  })
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    Layer.buildWithScope(serverLayer(home, { idleGrace: "1 hour" }).pipe(Layer.provide(providers)), scope),
  )
  return {
    home,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    [Symbol.asyncDispose]: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      if (!options.home) rmSync(home.dir, { recursive: true, force: true })
    },
  }
}

export const servingUntilIdle = async (home: ReturnType<typeof tempHome>, idleGrace: Duration.Input) => {
  const listening = Promise.withResolvers<void>()
  const exited = Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* Lifetime
      listening.resolve()
      yield* lifetime.ended
    }).pipe(
      Effect.provide(
        serverLayer(home, { idleGrace }).pipe(
          Layer.provide(
            providersLayer({ script: [], openai: openAiOptions(home), claude: {}, preferred: "script", config: {} }),
          ),
        ),
      ),
      Effect.scoped,
    ),
  )
  await Promise.race([listening.promise, exited])
  return { exited }
}
