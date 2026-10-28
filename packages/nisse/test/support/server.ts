import { mkdtempSync, rmSync } from "node:fs"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import { homeAt } from "../../src/home.ts"
import { scriptedModel } from "../../src/model.ts"
import { Lifetime } from "../../src/lifetime.ts"
import { serverLayer } from "../../src/server.ts"

type Steps = Parameters<typeof scriptedModel>[0]

export const tempHome = () => homeAt(mkdtempSync("/tmp/nisse-"))

export const runningServer = async (steps: Steps = []) => {
  const home = tempHome()
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    Layer.buildWithScope(serverLayer(home, { idleGrace: "1 hour" }).pipe(Layer.provide(scriptedModel(steps))), scope),
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
    }).pipe(Effect.provide(serverLayer(home, { idleGrace }).pipe(Layer.provide(scriptedModel([])))), Effect.scoped),
  )
  await Promise.race([listening.promise, exited])
  return { exited }
}
