import { Context, Deferred, Duration, Effect, Layer, Scope, Stream, SubscriptionRef } from "effect"

export class Lifetime extends Context.Service<
  Lifetime,
  {
    readonly hold: Effect.Effect<void, never, Scope.Scope>
    readonly stop: Effect.Effect<void>
    readonly ended: Effect.Effect<void>
  }
>()("nisse/Lifetime") {
  static readonly layer = (idleGrace: Duration.Input) =>
    Layer.effect(
      Lifetime,
      Effect.gen(function* () {
        const holds = yield* SubscriptionRef.make(0)
        const stopped = yield* Deferred.make<void>()
        const idle = SubscriptionRef.changes(holds).pipe(
          Stream.switchMap((count) => (count === 0 ? Stream.fromEffect(Effect.sleep(idleGrace)) : Stream.empty)),
          Stream.runHead,
        )
        return Lifetime.of({
          hold: Effect.acquireRelease(
            SubscriptionRef.update(holds, (n) => n + 1),
            () => SubscriptionRef.update(holds, (n) => n - 1),
          ),
          stop: Deferred.succeed(stopped, undefined),
          ended: Effect.raceFirst(Effect.asVoid(idle), Deferred.await(stopped)),
        })
      }),
    )
}
