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
      // A state is recorded under the lock that changed it, so the log holds states in the order they happened.
      const recording = yield* Semaphore.make(1)

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

      const update = (provider: string, flow: string, change: Partial<AuthState>) =>
        recording.withPermits(1)(
          Effect.suspend(() => {
            const running = flows.get(provider)
            if (!running || running.state.flow !== flow || authEnded(running.state.phase)) return Effect.succeed(false)
            const { interaction: _, ...rest } = running.state
            running.state = { ...rest, ...change }
            return Effect.as(log.record(running.state), true)
          }),
        )

      /** Makes `flow` the provider's sign-in and records its state. */
      const begin = (flow: Flow) =>
        recording.withPermits(1)(
          Effect.suspend(() => {
            flows.set(flow.state.provider, flow)
            return log.record(flow.state)
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

      const cancel = (provider: string, flow: string) =>
        Effect.gen(function* () {
          const fiber = flows.get(provider)?.fiber
          const cancelled = yield* update(provider, flow, { phase: "cancelled" })
          if (cancelled && fiber) yield* Fiber.interrupt(fiber)
          return cancelled
        })

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
            const running = flows.get(provider)
            if (running && !authEnded(running.state.phase)) return running.state
            const flow: Flow = {
              state: { provider, flow: newId(), phase: "starting" },
              responses: yield* Queue.unbounded<AuthResponse>(),
            }
            yield* begin(flow)
            flow.fiber = yield* Effect.forkIn(signIn(provider, driver, chosen, flow), scope)
            return flow.state
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
            yield* Effect.mapError(driver.signOut, (error) => new CannotSignIn({ provider, message: error.message }))
            const signedOut = yield* snapshot(provider, driver, true)
            const state: AuthState = { provider, flow: newId(), phase: "signed_out" }
            yield* begin({ state, responses: yield* Queue.unbounded<AuthResponse>() })
            return signedOut
          }),
        watch: log.watch,
      })
    })

  static readonly layer = Layer.effect(
    Setup,
    Effect.flatMap(Effect.zip(Providers, memorySignIns), ([{ drivers }, log]) => Setup.make(drivers, log)),
  )
}
