// The live Claude Code processes of a server, one per conversation at most (D1). A run leases its conversation's
// process; when the run ends well, the process stays live for the next run until it has served no run for the idle
// period (D2). A live process is a cache of `claude.session`: losing one costs a cold start and nothing else. A live
// process with a long context compacts shortly before the prompt cache of its last request expires, then closes (D7).
import type { ConversationId } from "@sigma/kernel"
import { Clock, Duration, Effect, Exit, Fiber, Scope } from "effect"
import type { ClaudeProcess, Selection, Start } from "./process.ts"
import type { Said } from "./retell.ts"

/** How long a live process waits for its conversation's next run; Victor chose it, and t3code uses the same (D2). */
export const IDLE_RELEASE: Duration.Input = "30 minutes"

/**
 * How long a stopped run waits for Claude Code to end its turn before closing the process (D5). A real Claude Code ends
 * it 3 to 18 ms after the interrupt, during text, a call, a call waiting for approval and a subagent (F14); this is past
 * any of those, so only a process that ignores the interrupt reaches it.
 */
export const STOP_TIMEOUT: Duration.Input = "5 seconds"

/**
 * How long before the cache expires an idle conversation starts its compaction. Claude Code sends the summary request
 * about 10 ms after it is sent `/compact`, on a context of 242,713 tokens, and a request's time is taken when its
 * response starts, which trails the request by seconds on an uncached context (s-ze9kas, `compact-lead.ts`).
 */
export const IDLE_COMPACTION_LEAD: Duration.Input = "2 minutes"

/** The smallest context an idle conversation compacts; Claude Code's own idle compaction and t3code use it (F10). */
export const IDLE_COMPACTION_THRESHOLD = 200_000

export interface ClaudeProcessesOptions {
  /** Default `IDLE_RELEASE`; 0 closes each process when its run ends. */
  readonly idle?: Duration.Input
  /** Default `STOP_TIMEOUT`. */
  readonly stop?: Duration.Input
  /** Held from each process's open to its close, so the server outlives its live processes (D3). */
  readonly hold?: Effect.Effect<void, never, Scope.Scope>
  /**
   * Starts the conversation's compaction, whose run leases its live process. Without it no conversation compacts
   * while idle.
   */
  readonly compact?: (conversation: ConversationId) => Effect.Effect<void, unknown>
  /** What the live processes keep time by: the time of each request and the idle waits. Default the fiber's. */
  readonly clock?: Clock.Clock
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
   * The conversation's live process when its key is `key`, it can switch to `selection`, and `openings.live` says it
   * can go on; otherwise a new one `open` starts where `openings.cold` says, after closing the live one. The lease ends
   * with the scope.
   */
  readonly lease: <E>(
    conversation: ConversationId,
    key: string,
    selection: Selection,
    openings: Openings<E>,
    open: (start: Start) => Effect.Effect<ClaudeProcess, never, Scope.Scope>,
  ) => Effect.Effect<Lease, E, Scope.Scope>
  /** How long a stopped run waits for its process to end the turn. */
  readonly stopWithin: Duration.Input
}

type Live = {
  readonly key: string
  readonly process: ClaudeProcess
  readonly scope: Scope.Closeable
  seen: number
  idle?: Fiber.Fiber<void>
  /** Its idle compaction started: the next lease ends the idle spell, and the process with it. */
  compacting?: true
}

const TTL_MILLIS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const

/** The server's live processes; closing the scope closes every one, as a server stop does (D3). */
export const makeClaudeProcesses = (options: ClaudeProcessesOptions = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const clock = options.clock ?? (yield* Clock.Clock)
    const idle = options.idle ?? IDLE_RELEASE
    const lead = Duration.toMillis(Duration.fromInputUnsafe(IDLE_COMPACTION_LEAD))
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

    /** How long until `one` compacts: its last request's cache expiry less the lead, when its context is long (D7). */
    const compactsIn = (one: Live) => {
      const last = one.process.lastRequest
      if (options.compact === undefined || last?.ttl === undefined || last.context < IDLE_COMPACTION_THRESHOLD) {
        return undefined
      }
      return Math.max(0, last.at + TTL_MILLIS[last.ttl] - lead - clock.currentTimeMillisUnsafe())
    }

    /**
     * Makes `one` the conversation's live process until its next lease, its idle period, or its exit. A process with a
     * long context waits for its compaction instead, past the idle period, and its next lease is its last (D7).
     */
    const keep = (conversation: ConversationId, one: Live) =>
      Effect.gen(function* () {
        if (closed || one.compacting || Duration.isZero(Duration.fromInputUnsafe(idle))) {
          return yield* Scope.close(one.scope, Exit.void)
        }
        live.set(conversation, one)
        const due = compactsIn(one)
        const spell =
          due === undefined
            ? Effect.sleep(idle)
            : Effect.gen(function* () {
                yield* Effect.sleep(due)
                one.compacting = true
                const started = yield* options.compact!(conversation).pipe(
                  Effect.as(true),
                  Effect.catchCause(() => Effect.succeed(false)),
                )
                // The compaction's run has the idle period to lease the process; one that did not start ends the spell.
                if (started) yield* Effect.sleep(idle)
              })
        one.idle = yield* Effect.forkIn(
          Effect.andThen(Effect.raceFirst(spell, one.process.exited), close(conversation, one)).pipe(
            Effect.provideService(Clock.Clock, clock),
          ),
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

    const lease: ClaudeProcesses["lease"] = (conversation, key, selection, openings, open) =>
      Effect.map(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const found = yield* take(conversation)
            if (
              found !== undefined &&
              found.key === key &&
              found.process.canSelect(selection) &&
              openings.live !== undefined
            ) {
              const texts = yield* Effect.onError(openings.live(found.seen), () => Scope.close(found.scope, Exit.void))
              if (texts !== undefined) return { one: found, texts, live: true, kept: false }
            }
            if (found !== undefined) yield* Scope.close(found.scope, Exit.void)
            const { start, texts } = yield* openings.cold()
            const processScope = yield* Scope.make()
            if (options.hold !== undefined) yield* Scope.provide(options.hold, processScope)
            const process = yield* Scope.provide(open(start), processScope).pipe(
              Effect.provideService(Clock.Clock, clock),
            )
            const one: Live = { key, process, scope: processScope, seen: 0 }
            return { one, texts, live: false, kept: false }
          }),
          (leased, exit) => (leased.kept ? keep(conversation, leased.one) : Scope.close(leased.one.scope, exit)),
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

    return { lease, stopWithin: options.stop ?? STOP_TIMEOUT } satisfies ClaudeProcesses
  })
