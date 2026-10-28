import { mkdtempSync, rmSync } from "node:fs"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import { homeAt } from "../../src/home.ts"
import { scriptedProviders, type Script } from "../../src/drivers/script.ts"
import { Lifetime } from "../../src/lifetime.ts"
import { serverLayer } from "../../src/server.ts"

export const tempHome = () => homeAt(mkdtempSync("/tmp/nisse-"))

export const runningServer = async (steps: Script = []) => {
  const home = tempHome()
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    Layer.buildWithScope(
      serverLayer(home, { idleGrace: "1 hour" }).pipe(Layer.provide(scriptedProviders(steps))),
      scope,
    ),
  )
  return {
    home,
    [Symbol.asyncDispose]: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      rmSync(home.dir, { recursive: true, force: true })
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
    }).pipe(Effect.provide(serverLayer(home, { idleGrace }).pipe(Layer.provide(scriptedProviders([])))), Effect.scoped),
  )
  await Promise.race([listening.promise, exited])
  return { exited }
}
