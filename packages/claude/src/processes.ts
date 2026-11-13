// The live Claude Code processes of a server, one per conversation at most (D1). A run leases its conversation's
// process; when the run ends well, the process stays live for the next run until it has served no run for the idle
// period (D2). A live process is a cache of `claude.session`: losing one costs a cold start and nothing else.
import type { ConversationId } from "@nisse/kernel"
import { Duration, Effect, Exit, Fiber, Scope } from "effect"
import type { ClaudeProcess, Start } from "./process.ts"
import type { Said } from "./retell.ts"

/** How long a live process waits for its conversation's next run; Victor chose it, and t3code uses the same (D2). */
export const IDLE_RELEASE: Duration.Input = "30 minutes"

export interface ClaudeProcessesOptions {
  /** Default `IDLE_RELEASE`; 0 closes each process when its run ends. */
  readonly idle?: Duration.Input
  /** Held from each process's open to its close, so the server outlives its live processes (D3). */
  readonly hold?: Effect.Effect<void, never, Scope.Scope>
}

/** What a run tells its process first, whether it found one live or starts one. */
export interface Openings<E> {
  /** What came after the newest entry the live process has seen, or `undefined` when it cannot go on from there. */
  readonly live?: (seen: number) => Effect.Effect<ReadonlyArray<Said> | undefined, E>
  /** Where a new process starts, and what it is told. */
  readonly cold: () => Effect.Effect<{ readonly start: Start; readonly texts: ReadonlyArray<Said> }, E>
}

export interface Lease {
  readonly process: ClaudeProcess
  readonly texts: ReadonlyArray<Said>
  /** The process was live before this run: it served an earlier one. */
  readonly live: boolean
  /** Keeps the process live after the lease, having seen the entries through `seen`; otherwise it closes. */
  readonly keep: (seen: number) => void
}

export interface ClaudeProcesses {
  /**
   * The conversation's live process when its key is `key` and `openings.live` says it can go on; otherwise a new one
   * `open` starts where `openings.cold` says, after closing the live one. The lease ends with the scope.
   */
  readonly lease: <E>(
    conversation: ConversationId,
    key: string,
    openings: Openings<E>,
    open: (start: Start) => Effect.Effect<ClaudeProcess, never, Scope.Scope>,
  ) => Effect.Effect<Lease, E, Scope.Scope>
}

type Live = {
  readonly key: string
  readonly process: ClaudeProcess
  readonly scope: Scope.Closeable
  seen: number
  idle?: Fiber.Fiber<void>
}

/** The server's live processes; closing the scope closes every one, as a server stop does (D3). */
export const makeClaudeProcesses = (options: ClaudeProcessesOptions = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const idle = options.idle ?? IDLE_RELEASE
    const live = new Map<ConversationId, Live>()
    let closed = false
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true
        const all = [...live.values()]
        live.clear()
        yield* Effect.forEach(all, (one) => Scope.close(one.scope, Exit.void), { discard: true })
      }),
    )

    const close = (conversation: ConversationId, one: Live) =>
      Effect.suspend(() => {
        if (live.get(conversation) === one) live.delete(conversation)
        return Scope.close(one.scope, Exit.void)
      })

    /** Makes `one` the conversation's live process until its next lease, its idle period, or its exit. */
    const keep = (conversation: ConversationId, one: Live) =>
      Effect.gen(function* () {
        if (closed || Duration.isZero(Duration.fromInputUnsafe(idle))) return yield* Scope.close(one.scope, Exit.void)
        live.set(conversation, one)
        one.idle = yield* Effect.forkIn(
          Effect.andThen(Effect.raceFirst(Effect.sleep(idle), one.process.exited), close(conversation, one)),
          scope,
        )
      })

    /** The conversation's live process, taken out of the map with its idle wait stopped. */
    const take = (conversation: ConversationId) =>
      Effect.gen(function* () {
        const one = live.get(conversation)
        if (one === undefined) return undefined
        live.delete(conversation)
        if (one.idle !== undefined) yield* Fiber.interrupt(one.idle)
        delete one.idle
        return one
      })

    const lease: ClaudeProcesses["lease"] = (conversation, key, openings, open) =>
      Effect.map(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const found = yield* take(conversation)
            if (found !== undefined && found.key === key && openings.live !== undefined) {
              const texts = yield* Effect.onError(openings.live(found.seen), () => Scope.close(found.scope, Exit.void))
              if (texts !== undefined) return { one: found, texts, live: true, kept: false }
            }
            if (found !== undefined) yield* Scope.close(found.scope, Exit.void)
            const { start, texts } = yield* openings.cold()
            const processScope = yield* Scope.make()
            if (options.hold !== undefined) yield* Scope.provide(options.hold, processScope)
            const process = yield* Scope.provide(open(start), processScope)
            const one: Live = { key, process, scope: processScope, seen: 0 }
            return { one, texts, live: false, kept: false }
          }),
          (leased, exit) =>
            leased.kept && Exit.isSuccess(exit) ? keep(conversation, leased.one) : Scope.close(leased.one.scope, exit),
        ),
        (leased): Lease => ({
          process: leased.one.process,
          texts: leased.texts,
          live: leased.live,
          keep: (seen) => {
            leased.one.seen = seen
            leased.kept = true
          },
        }),
      )

    return { lease } satisfies ClaudeProcesses
  })
