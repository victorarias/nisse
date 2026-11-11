import {
  authEnded,
  CannotSignIn,
  UnknownProvider,
  type AuthMethod,
  type AuthResponse,
  type AuthState,
  type ProviderModels,
  type ProviderSnapshot,
} from "@nisse/protocol"
import type { ProviderAccount } from "@nisse/models"
import { Cause, Context, Effect, Fiber, Layer, Queue, Semaphore, Stream } from "effect"
import { newId } from "./ids.ts"
import { Providers } from "./provider.ts"

const WATCHER_QUEUE = 256

/** Where every connection sees sign-ins: the last state of each provider's, then every change. */
export interface SignInLog {
  /** Records a provider's sign-in state; watchers see it once it is recorded. */
  readonly record: (state: AuthState) => Effect.Effect<void>
  readonly watch: Stream.Stream<AuthState>
}

/** A log held in memory: a watcher that falls behind by `WATCHER_QUEUE` states is dropped. */
export const memorySignIns = Effect.sync((): SignInLog => {
  const last = new Map<string, AuthState>()
  const watchers = new Set<Queue.Queue<AuthState>>()
  return {
    record: (state) =>
      Effect.sync(() => {
        last.set(state.provider, state)
        for (const watcher of watchers) {
          if (!Queue.offerUnsafe(watcher, state)) {
            watchers.delete(watcher)
            Queue.failCauseUnsafe(watcher, Cause.interrupt())
          }
        }
      }),
    watch: Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<AuthState>(WATCHER_QUEUE)
        const current = [...last.values()]
        watchers.add(queue)
        yield* Effect.addFinalizer(() => Effect.sync(() => watchers.delete(queue)))
        return Stream.concat(Stream.fromIterable(current), Stream.fromQueue(queue))
      }),
    ),
  }
})

interface Flow {
  state: AuthState
  readonly responses: Queue.Queue<AuthResponse>
  fiber?: Fiber.Fiber<void>
}

export class Setup extends Context.Service<
  Setup,
  {
    readonly providers: (refresh: boolean) => Effect.Effect<ReadonlyArray<ProviderSnapshot>>
    readonly models: (refresh: boolean) => Effect.Effect<ReadonlyArray<ProviderModels>>
    readonly start: (
      provider: string,
      method: AuthMethod | undefined,
    ) => Effect.Effect<AuthState, UnknownProvider | CannotSignIn>
    readonly respond: (provider: string, flow: string, response: AuthResponse) => Effect.Effect<boolean>
    readonly cancel: (provider: string, flow: string) => Effect.Effect<boolean>
    readonly logout: (provider: string) => Effect.Effect<ProviderSnapshot, UnknownProvider | CannotSignIn>
    readonly watch: Stream.Stream<AuthState>
  }
>()("nisse/Setup") {
  /**
   * Sign-ins, health and model lists over a home's providers, by id, with sign-in states recorded in `log`; sign-ins
   * end with the scope.
   */
  static readonly make = (drivers: ReadonlyMap<string, ProviderAccount>, log: SignInLog) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const flows = new Map<string, Flow>()
      // Every change to `flows` happens under this lock and only after the log recorded it: what any connection reads
      // from memory is recorded, and the log holds states in the order they happened. Once the lock is held the change
      // runs to its end: a recorded state is always installed, even when the caller that asked for it goes away.
      const lock = yield* Semaphore.make(1)
      const recording = <A, E, R>(change: Effect.Effect<A, E, R>) => lock.withPermits(1)(Effect.uninterruptible(change))

      const driverOf = (provider: string) =>
        Effect.suspend(() => {
          const driver = drivers.get(provider)
          return driver ? Effect.succeed(driver) : Effect.fail(new UnknownProvider({ provider }))
        })

      const snapshot = (id: string, driver: ProviderAccount, refresh: boolean) =>
        Effect.map(
          driver.health(refresh),
          (health): ProviderSnapshot => ({
            id,
            driver: driver.kind,
            signIn: driver.signInMethods,
            health: { ...health, checkedAt: Date.now() },
          }),
        )

      /** Changes the provider's sign-in when `flow` is it and still runs; the flow it changed, if any. */
      const update = (provider: string, flow: string, change: Partial<AuthState>) =>
        recording(
          Effect.suspend((): Effect.Effect<Flow | undefined> => {
            const running = flows.get(provider)
            if (!running || running.state.flow !== flow || authEnded(running.state.phase)) {
              return Effect.succeed(undefined)
            }
            const { interaction: _, ...rest } = running.state
            const next: AuthState = { ...rest, ...change }
            return Effect.as(
              Effect.tap(log.record(next), () => Effect.sync(() => (running.state = next))),
              running,
            )
          }),
        )

      /** Records `state` as the provider's sign-in, with no flow of its own to run, and stops a sign-in it displaces. */
      const settle = (state: AuthState) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const displaced = yield* recording(
              Effect.gen(function* () {
                const responses = yield* Queue.unbounded<AuthResponse>()
                const before = flows.get(state.provider)
                yield* log.record(state)
                flows.set(state.provider, { state, responses })
                return before !== undefined && !authEnded(before.state.phase) ? before : undefined
              }),
            )
            // A sign-in that started since the caller looked is over too: nothing can reach it any more.
            if (displaced?.fiber) yield* Fiber.interrupt(displaced.fiber)
          }),
        )

      const signIn = (provider: string, driver: ProviderAccount, method: AuthMethod, flow: Flow) =>
        Effect.gen(function* () {
          const id = flow.state.flow
          const outcome = yield* Effect.result(
            driver.signIn(method, {
              show: (interaction) => Effect.asVoid(update(provider, id, { phase: "waiting", interaction })),
              response: Queue.take(flow.responses),
            }),
          )
          if (outcome._tag === "Failure") {
            yield* update(provider, id, { phase: "failed", message: outcome.failure.message })
            return
          }
          yield* update(provider, id, { phase: "verifying" })
          const health = yield* driver.health(true)
          yield* update(
            provider,
            id,
            health.status === "ready"
              ? { phase: "succeeded", ...(health.account ? { message: health.account } : {}) }
              : { phase: "failed", message: health.message ?? "still signed out" },
          )
        })

      // A committed `cancelled` always stops the sign-in it ended, even when the caller goes away. `start` forks a
      // flow's fiber under the lock, so the flow `update` changed has it; it is stopped outside the lock, so its own
      // last change can finish.
      const cancel = (provider: string, flow: string) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const cancelled = yield* update(provider, flow, { phase: "cancelled" })
            if (cancelled?.fiber) yield* Fiber.interrupt(cancelled.fiber)
            return cancelled !== undefined
          }),
        )

      return Setup.of({
        providers: (refresh) =>
          Effect.forEach([...drivers], ([id, driver]) => snapshot(id, driver, refresh), { concurrency: "unbounded" }),
        models: (refresh) =>
          Effect.forEach(
            [...drivers],
            ([id, driver]) =>
              Effect.map(
                driver.models(refresh),
                (models): ProviderModels => ({
                  provider: id,
                  ...(driver.defaultModel ? { defaultModel: driver.defaultModel } : {}),
                  models,
                }),
              ),
            { concurrency: "unbounded" },
          ),
        start: (provider, method) =>
          Effect.gen(function* () {
            const driver = yield* driverOf(provider)
            const chosen = method ?? driver.signInMethods[0]
            if (chosen === undefined || !driver.signInMethods.includes(chosen)) {
              return yield* new CannotSignIn({
                provider,
                message:
                  chosen === undefined
                    ? `${provider} has nothing to sign in to`
                    : `${provider} can't sign in by ${chosen}`,
              })
            }
            // A second start while one runs gets that one: the check and the install share the lock.
            return yield* recording(
              Effect.gen(function* () {
                const running = flows.get(provider)
                if (running && !authEnded(running.state.phase)) return running.state
                const flow: Flow = {
                  state: { provider, flow: newId(), phase: "starting" },
                  responses: yield* Queue.unbounded<AuthResponse>(),
                }
                yield* log.record(flow.state)
                flows.set(provider, flow)
                // Forked under the lock, so a cancel always finds its fiber; its first update waits for the lock.
                flow.fiber = yield* Effect.forkIn(signIn(provider, driver, chosen, flow), scope)
                return flow.state
              }),
            )
          }),
        respond: (provider, flow, response) =>
          Effect.sync(() => {
            const running = flows.get(provider)
            if (!running || running.state.flow !== flow || running.state.phase !== "waiting") return false
            return Queue.offerUnsafe(running.responses, response)
          }),
        cancel,
        logout: (provider) =>
          Effect.gen(function* () {
            const driver = yield* driverOf(provider)
            const running = flows.get(provider)
            if (running && !authEnded(running.state.phase)) yield* cancel(provider, running.state.flow)
            // Once signing out begins, every connection hears of it, even when the caller goes away.
            yield* Effect.uninterruptible(
              Effect.andThen(
                Effect.mapError(driver.signOut, (error) => new CannotSignIn({ provider, message: error.message })),
                settle({ provider, flow: newId(), phase: "signed_out" }),
              ),
            )
            return yield* snapshot(provider, driver, true)
          }),
        watch: log.watch,
      })
    })

  static readonly layer = Layer.effect(
    Setup,
    Effect.flatMap(Effect.zip(Providers, memorySignIns), ([{ drivers }, log]) => Setup.make(drivers, log)),
  )
}
