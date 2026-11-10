// The task scheduler (spec sections 5.1 to 5.6): reservation, invocations, steps, abort and its cascade, held
// outcomes, waits, sleeps and restart accounting, over one Session. It knows nothing of runs, tools or hooks: the
// harness adds those through the options (the per-phase services, the cleanup of outcomes the scheduler writes, the
// withdrawal of queued inputs).
//
// Derived from pi-durable's `src/harness/scheduler.ts` at 7d073328e (MIT, see LICENSE). Two departures. Upstream's
// group commit made decisions wait for unpublished commits (decision regions and membership keys); the kernel's line
// waits for each storage call to settle, so a decision taken inside a commit callback reads exactly the committed
// state in `#live` and needs none of that. And each live task keeps its ownership chain, which never changes, as a list
// it shares with the work above it, instead of nodes that sweeps forget: memory stays bounded by live work, and a task
// costs the same at any depth.
//
// Every decision about a task is one callback serialized on the Session line: open, reservation, the step before each
// phase, a runtime commit, an abort mark, and the reconcile pass that marks cascades, `failFast` waits and finalizes
// held outcomes. Handlers run off the line, one invocation per task. Nothing is woken from the line (F6): publications
// signal through queues and microtasks.
import { type Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Tracer } from "effect"
import { DurableMetrics, spanTime, TracePropagation, updateMetric } from "../telemetry.ts"
import type { AnyDocToken, DocAddressArgs } from "../documents/definition.ts"
import { errorMessage, InvocationEnded, SessionClosed, SessionFailed, type StorageError } from "../errors.ts"
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryQuery,
  JsonValue,
  TaskId,
  TaskOutcome,
  TaskRecord,
  TaskState,
} from "../records.ts"
import type { ReadError } from "../storage.ts"
import {
  type CommitError,
  type CommitPublication,
  internals,
  type ReadFailure,
  type Session,
  type SessionInternals,
} from "../session/session.ts"
import type { Transaction } from "../session/transaction.ts"
import type {
  AnyTask,
  NextTaskState,
  RunningTask,
  SettledTask,
  TaskDefinition,
  TaskRegistry,
  TaskRuntime,
  TaskSnapshot,
} from "./task.ts"

/** Why a task cannot be reserved: no registered definition can take it. Derived from the registry, never stored. */
export type BlockedReason = "missing_task" | "task_too_old" | "migration_failed"

/** Terminal outcomes the scheduler writes without running task code. */
export type SchedulerOutcome = Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" | "orphaned" }>

/** The task a report is about. */
export type ReportTask = { readonly id: TaskId; readonly kind: string; readonly conversationId: ConversationId }

/** A non-fatal failure the scheduler forwards to its host. */
export type TaskReport =
  /** A phase or abort handler failed outside its outcome, or the task reported through its runtime. */
  | { readonly kind: "task_error"; readonly task: ReportTask }
  /** The scheduler ended a task `faulted`: its handler threw or made no progress, or crashes cut it off too often. */
  | { readonly kind: "task_faulted"; readonly task: ReportTask; readonly reason: "threw" | "restart_limit" }
  /**
   * A task ended because crashes cut it off: a failed outcome whose detail's `reason` is `restart_limit` or
   * `interrupted`, or a state marked with `endedByCrashes`. `restarts` is how often it was cut off in a row.
   */
  | {
      readonly kind: "task_interrupted"
      readonly task: ReportTask
      readonly reason: "restart_limit" | "interrupted"
      readonly restarts: number
    }
  /** A definition's `migrate` threw; the task waits, blocked, for another definition. */
  | { readonly kind: "migration_failed"; readonly task: ReportTask }
  /** A running task keeps its old definition because the registered one cannot take it. */
  | { readonly kind: "task_outdated"; readonly task: ReportTask; readonly reason: BlockedReason }
  /** A host callback threw: the registry, or the per-phase services. */
  | { readonly kind: "host_error"; readonly callback: "registry" | "services" | "settle" | "telemetry" }

/** What one phase or abort handler runs with; the per-phase services are built from it. */
export type PhaseInfo<Svc> = {
  readonly mode: "run" | "abort"
  readonly task: AnyTask<Svc>
  readonly record: TaskRecord
  /** The registry snapshot of the phase. */
  readonly snapshot: TaskSnapshot<Svc>
  /** The runtime the handler gets, for services that act for the same invocation. */
  readonly runtime: TaskRuntime<JsonValue, never, JsonValue>
}

export type TaskSchedulerOptions<Svc> = {
  readonly session: Session
  readonly registry: TaskRegistry<Svc>
  /** The services a phase or abort handler needs, built once per handler. Required when `Svc` is not `never`. */
  readonly services?: (phase: PhaseInfo<Svc>) => Layer.Layer<Svc>
  /** `settings.restartLimit`, read only for a task with a restart count. Default 5; `Infinity` never ends a task. */
  readonly restartLimit?: () => number
  /**
   * Kinds whose run phases end the task themselves once cut off `restartLimit` times, from `TaskRecord.restarts`; the
   * scheduler ends a task of any other kind `faulted` instead. Default: none.
   */
  readonly limitsRestarts?: (kind: string) => boolean
  /** Cleanup staged in the commit that makes an outcome the scheduler wrote terminal (spec 5.4). */
  readonly settleOutcome?: (
    tx: Transaction,
    record: TaskRecord,
    outcome: SchedulerOutcome,
  ) => Effect.Effect<void, unknown>
  /** Withdraws a conversation's queued inputs, for conversation abort and abort cascades. */
  readonly withdrawInputs?: (tx: Transaction, conversationId: ConversationId) => Effect.Effect<void, unknown>
  /** Conversations with queued inputs, read on the line; `withdrawInputs` is called for those a cascade reaches. */
  readonly queuedInputs?: (reads: SessionInternals["lineReads"]) => Effect.Effect<readonly ConversationId[], unknown>
  /**
   * `snapshot`, for a report from a running invocation, is the registry snapshot its current handler runs under, so the
   * host can name the definition that ran after the registry moved on.
   */
  readonly report?: (error: unknown, report: TaskReport, snapshot?: TaskSnapshot<Svc>, span?: Tracer.Span) => void
  /** Open only loads live tasks: nothing is written or run, and no wakeup is needed. */
  readonly readOnly?: boolean
}

/** When the Session next needs a running process (spec 5.6): `active` while work can run, `at` for the next sleep. */
export type Wake = { readonly active: boolean; readonly at?: number }

/** A live task and what it waits for, as `inspect` derives it. */
export type TaskInspection = {
  readonly record: TaskRecord
  readonly state:
    | { readonly kind: "running" }
    | { readonly kind: "completing" }
    | { readonly kind: "waiting"; readonly on: readonly TaskId[] }
    | { readonly kind: "sleeping"; readonly until: number }
    | { readonly kind: "blocked"; readonly reason: BlockedReason; readonly error?: unknown }
    | { readonly kind: "ready"; readonly migrates: boolean }
}

/** What a scheduler failure-free call fails with when the Session is not open. */
export type SchedulerClosed = SessionClosed | SessionFailed

export interface TaskScheduler {
  /** Starts scheduling, and makes due sleeps runnable. A host calls it once its definitions are registered (A16). */
  readonly resume: Effect.Effect<void>
  /**
   * Commits an abort mark on the task, or settles a task no definition can take as `orphaned` when nothing it owns is
   * live; then joins its run invocation. A `completing` task is only marked; a terminal one is left (`terminal`).
   */
  abortTask(id: TaskId): Effect.Effect<"marked" | "terminal", ReadFailure | CommitError>
  /** The terminal receipt of a task, once it has one. A missing task is a defect. */
  waitForTask<R>(id: TaskId<R>): Effect.Effect<SettledTask<R>, ReadFailure>
  /**
   * Succeeds once ordinary traversal from the conversation, or from every ownerless conversation, reaches no live
   * non-background task.
   */
  waitForIdle(conversationId?: ConversationId): Effect.Effect<void, ReadFailure>
  /**
   * Marks every live non-background task ordinary traversal from the conversation reaches and withdraws its queued
   * inputs in one commit; succeeds once the conversation is idle. With `background`, traversal crosses background
   * tasks and every task it reached is awaited too.
   */
  abortConversation(
    conversationId: ConversationId,
    options?: { readonly background?: boolean },
  ): Effect.Effect<void, ReadFailure | CommitError>
  /** Why a live task cannot run, if it cannot. A running, abort-requested or `completing` task is never blocked. */
  blockedReason(record: TaskRecord): BlockedReason | undefined
  /** From memory, synchronously. */
  wake(): Wake
  /** Scheduling state and every live task with its derived state, read on the line. Runs no task code. */
  readonly inspect: Effect.Effect<
    { readonly scheduling: "paused" | "running" | "closing"; readonly tasks: readonly TaskInspection[] },
    ReadFailure
  >
  /** For tests that bound memory: what the scheduler indexes hold. */
  readonly indexSizes: {
    readonly live: number
    readonly below: number
    readonly conversations: number
    readonly waiters: number
  }
}

/**
 * Opens the scheduler of a Session: loads the live tasks and, unless read-only, writes every task a crash left
 * `running` back as `pending` with one more restart (spec 5.4). Scheduling waits for `resume`. The Session's close
 * stops it: invocations are signalled and joined, the tasks they ran are written back `pending` without a count, and
 * only then does Storage close.
 */
export const openTaskScheduler = <Svc = never>(
  options: TaskSchedulerOptions<Svc>,
): Effect.Effect<TaskScheduler, CommitError | ReadError> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const telemetry = { context: yield* Effect.context<never>(), propagation: yield* TracePropagation }
    const scheduler = new Scheduler(options, clock, yield* Queue.dropping<void, Cause.Done>(1), telemetry)
    yield* scheduler.open()
    return scheduler
  })

// Internals

type Erased = TaskDefinition<JsonValue, { readonly phase: string }, JsonValue, unknown>
type Checkpoint = { readonly phase: string }

/** A step of an ownership chain: an owner task, or a conversation. */
type Step = { readonly task: TaskId; readonly background: boolean } | { readonly conversation: ConversationId }

/** An ownership chain, nearest step first: a list each task shares with the work below it. */
type Chain = { readonly step: Step; readonly up: Chain | undefined }

/** A live task: its committed record, the chain above it once known, and the chain it starts for work below it. */
type Live = { record: TaskRecord; chain: Chain | undefined; own?: Chain }

/** One in-memory execution of a task, in run or abort mode. */
type Invocation = {
  readonly taskId: TaskId
  readonly kind: string
  readonly conversationId: ConversationId
  readonly mode: "run" | "abort"
  readonly controller: AbortController
  /** The handler running now, interrupted by the signal. */
  handler: Fiber.Fiber<void, unknown> | undefined
  ended: boolean
  /** The registry snapshot of the handler that ran last, for reports about it. */
  snapshot: TaskSnapshot<unknown> | undefined
  /** Completed off the line once the invocation is over, its last handler included. */
  readonly done: Deferred.Deferred<void>
  /** Completed in a microtask after the invocation ended, for runtime waits to give up. */
  readonly endedSignal: Deferred.Deferred<void>
}

/** The span of a phase invocation and its decision commit, and the task's record as of its latest publication. */
type PhaseSpan = { readonly span: Tracer.Span; record: TaskRecord }

type Reservation = { readonly invocation: Invocation; readonly task: AnyTask<unknown>; snapshot: TaskSnapshot<unknown> }

type StepPlan =
  | { readonly kind: "continue" | "progress" | "end" | "cascade" }
  | { readonly kind: "fault"; readonly error: unknown }

type Fit =
  | { readonly task: AnyTask<unknown>; readonly migrates: boolean }
  /** `error` is a failed migration's. */
  | { readonly reason: BlockedReason; readonly error?: unknown }

type Waiter<A> = Queue.Queue<Exit.Exit<A, SessionFailed | SessionClosed>>

const DEFAULT_RESTART_LIMIT = 5
/** No outdated definition reported yet; `undefined` is a definition outcome too (none registered). */
const UNREPORTED = Symbol("unreported")
const SCAN_PAGE_SIZE = 256
const LIVE_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const
const ALL = "all"

const taskKey = (id: TaskId): string => `t${id}`
const conversationKey = (id: ConversationId): string => `c${id}`
const stepKey = (step: Step): string => ("task" in step ? taskKey(step.task) : conversationKey(step.conversation))

class Scheduler<Svc> implements TaskScheduler {
  readonly #session: Session
  readonly #internals: SessionInternals
  readonly #registry: TaskRegistry<unknown>
  readonly #services: (phase: PhaseInfo<unknown>) => Layer.Layer<unknown>
  readonly #restartLimit: () => number
  readonly #limitsRestarts: (kind: string) => boolean
  readonly #settleOutcome: SettleOutcome
  readonly #withdrawInputs: TaskSchedulerOptions<unknown>["withdrawInputs"]
  readonly #queuedInputs: TaskSchedulerOptions<unknown>["queuedInputs"]
  readonly #report: (error: unknown, report: TaskReport, snapshot?: TaskSnapshot<unknown>, span?: Tracer.Span) => void
  /** The context the scheduler opened in, whose metric registry it records to, and the host's trace propagation. */
  readonly #telemetry: {
    readonly context: Context.Context<never>
    readonly propagation: TracePropagation | undefined
  }
  /** Tasks loaded at open whose first phase in this process has not started yet. */
  readonly #resumed = new Set<TaskId>()
  /** The phase span of each task in a phase invocation now. */
  readonly #phases = new Map<TaskId, PhaseSpan>()
  readonly #readOnly: boolean
  readonly #clock: Clock.Clock
  /** Wakes the driver fiber, which runs reconcile and reservation passes. */
  readonly #wakeup: Queue.Queue<void, Cause.Done>

  /** Every committed non-terminal task. */
  readonly #live = new Map<TaskId, Live>()
  /**
   * The ownership tree around live work, downward: under each task or conversation (`t<id>`, `c<id>`), the steps just
   * below it that are live tasks with a known chain, or have steps listed below them. Each step is listed once, under
   * its parent, so what lies below a node is a walk down from it.
   */
  readonly #below = new Map<string, Map<string, Step>>()
  /** The chain from each conversation with steps listed below it. */
  readonly #conversations = new Map<ConversationId, Chain>()
  /** Live tasks whose chain is not known yet; the next pass loads it from Storage. */
  readonly #unloaded = new Set<TaskId>()
  /** Live tasks with cancellation intent: an abort mark, or a held outcome other than `completed`. */
  readonly #intent = new Set<TaskId>()
  /** Candidates of the next reservation pass. */
  readonly #runnable = new Set<TaskId>()
  /** `completing` tasks the next reconcile checks for finalization. */
  readonly #finalizeChecks = new Set<TaskId>()
  /** `failFast` waiters the next reconcile checks for a failed task in their `on`. */
  readonly #failFastChecks = new Set<TaskId>()
  /** Waiting tasks by each task in their `on`. */
  readonly #waiters = new Map<TaskId, Set<TaskId>>()
  /** Fails with the Session's failure once it fails, so a join of a run that ignores its signal ends with it. */
  readonly #failed = Deferred.makeUnsafe<never, SessionFailed>()
  /** Sleeping live tasks, due or not. */
  readonly #sleeping = new Set<TaskId>()
  /** Live `abandonOnRestart` tasks of an earlier process; the first reservation pass marks them. */
  readonly #abandoned = new Set<TaskId>()
  readonly #invocations = new Map<TaskId, Invocation>()
  /** Definitions whose `migrate` threw, per task: retried only once the registry resolves another. */
  readonly #failedMigrations = new Map<TaskId, { readonly task: AnyTask<unknown>; readonly error: unknown }>()
  readonly #taskWaiters = new Map<TaskId, Set<Waiter<TaskRecord>>>()
  /** Idle waiters by conversation, or `all` for every ownerless conversation. */
  readonly #idleWaiters = new Map<ConversationId | typeof ALL, Set<Waiter<void>>>()
  /** The fiber armed for the earliest sleep, and when it fires. */
  #timer: { readonly at: number; readonly fiber: Fiber.Fiber<void> } | undefined
  #unsubscribeRegistry: () => void = () => {}
  #cascadePending = false
  /** When `#wakeDue` last made due sleeps candidates. */
  #wokenAt = -Infinity
  #reconciling = false
  #dirty = false
  #enabled = false
  #closing = false

  constructor(
    options: TaskSchedulerOptions<Svc>,
    clock: Clock.Clock,
    wakeup: Queue.Queue<void, Cause.Done>,
    telemetry: { readonly context: Context.Context<never>; readonly propagation: TracePropagation | undefined },
  ) {
    this.#telemetry = telemetry
    this.#session = options.session
    this.#internals = internals(options.session)
    this.#registry = options.registry as TaskRegistry<unknown>
    const services = options.services as ((phase: PhaseInfo<unknown>) => Layer.Layer<unknown>) | undefined
    this.#services = services ?? (() => Layer.empty as Layer.Layer<unknown>)
    this.#restartLimit = options.restartLimit ?? (() => DEFAULT_RESTART_LIMIT)
    this.#limitsRestarts = options.limitsRestarts ?? (() => false)
    this.#settleOutcome = (options.settleOutcome as SettleOutcome | undefined) ?? (() => Effect.void)
    this.#withdrawInputs = options.withdrawInputs as TaskSchedulerOptions<unknown>["withdrawInputs"]
    this.#queuedInputs = options.queuedInputs
    const report = options.report ?? (() => {})
    this.#report = (error, info, snapshot, span) => {
      try {
        // The scheduler erases its services' type; a snapshot it holds is one `options.registry` made.
        report(error, info, snapshot as TaskSnapshot<Svc> | undefined, span)
      } catch {
        // A report handler that throws loses that report; it never fails what reported.
      }
    }
    this.#readOnly = options.readOnly === true
    this.#clock = clock
    this.#wakeup = wakeup
  }

  // Open and close

  open(): Effect.Effect<void, CommitError | ReadError> {
    return Effect.gen({ self: this }, function* () {
      this.#session.observeCommits({
        advance: (publication) => this.#observe(publication),
        end: () => {},
      })
      this.#session.subscribeClose(() => this.#seal())
      // A read-only scheduler runs nothing, so a close has nothing to join or write back.
      if (!this.#readOnly) this.#internals.onClosing((store) => this.#join(store))
      if (this.#registry.subscribe !== undefined) {
        try {
          this.#unsubscribeRegistry = this.#registry.subscribe(() => {
            for (const id of this.#live.keys()) this.#runnable.add(id)
            this.#kick()
          })
        } catch (error) {
          this.#report(error, { kind: "host_error", callback: "registry" })
        }
      }
      yield* this.#internals.commitIn({}, (tx) =>
        Effect.gen({ self: this }, function* () {
          // Every table read before the first write.
          const loaded: TaskRecord[] = []
          for (const status of LIVE_STATUSES) {
            let cursor: Cursor | undefined
            do {
              const page = yield* tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)
              loaded.push(...page.items)
              cursor = page.next
            } while (cursor !== undefined)
          }
          // Their chains load later, off open's path: until then each counts as inside every scope.
          for (const record of loaded) {
            this.#track(undefined, record, undefined)
            this.#resumed.add(record.id)
          }
          if (this.#readOnly) return
          for (const record of loaded) {
            if (record.abandonOnRestart === true) this.#abandoned.add(record.id)
            if (record.state.status === "running") {
              const restarts = (record.restarts ?? 0) + 1
              tx.setTask({ ...withState(record, { status: "pending", checkpoint: record.state.checkpoint }), restarts })
            }
            if (record.state.status === "waiting" && record.state.policy === "failFast") {
              this.#failFastChecks.add(record.id)
            }
            if (record.state.status === "completing") this.#finalizeChecks.add(record.id)
          }
        }),
      )
      if (this.#readOnly) return
      // Derive the marks a crash left unapplied below cancelled owners, and finalize held outcomes.
      this.#cascadePending = true
      yield* Effect.forkDetach(this.#drive())
      this.#signal()
    })
  }

  /** Close listener: runs synchronously once admission is sealed, or when the Session fails. */
  #seal(): void {
    if (this.#closing) return
    for (const live of this.#live.values()) this.#countActive(-1, live.record.kind)
    this.#resumed.clear()
    this.#closing = true
    try {
      this.#unsubscribeRegistry()
    } catch (error) {
      this.#report(error, { kind: "host_error", callback: "registry" })
    }
    Queue.endUnsafe(this.#wakeup)
    if (this.#timer !== undefined) Effect.runFork(Fiber.interrupt(this.#timer.fiber))
    this.#timer = undefined
    const closed = this.#closedError()
    const failure = this.#session.failure
    if (failure !== undefined) Deferred.doneUnsafe(this.#failed, Exit.fail(SessionFailed.of(failure.error)))
    for (const waiters of this.#taskWaiters.values()) for (const waiter of waiters) Queue.offerUnsafe(waiter, closed)
    this.#taskWaiters.clear()
    for (const waiters of this.#idleWaiters.values()) for (const waiter of waiters) Queue.offerUnsafe(waiter, closed)
    this.#idleWaiters.clear()
    // Signalled after the listeners: a close is not an abort, so what a handler holds ends with the Session's reason.
    const stopped = [...this.#invocations.values()]
    queueMicrotask(() => {
      for (const invocation of stopped) this.#signalInvocation(invocation)
    })
  }

  /**
   * A closing step, after the line drained: waits for every invocation, then writes every task still `running` back as
   * `pending`, straight to Storage, as a close is not a crash (spec 5.4). That includes tasks whose invocation already
   * ended, such as an abort-marked owner waiting for its owned work to drain.
   */
  #join(store: (writes: readonly import("../records.ts").StorageWrite[]) => Effect.Effect<void>): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const stopped = [...this.#invocations.values()]
      for (const invocation of stopped) this.#signalInvocation(invocation)
      for (const invocation of stopped) yield* Deferred.await(invocation.done)
      const writes = []
      // The line has drained, so `#live` is final.
      for (const { record } of this.#live.values()) {
        if (record.state.status !== "running") continue
        writes.push({
          type: "task" as const,
          value: withState(record, { status: "pending", checkpoint: record.state.checkpoint }),
        })
      }
      yield* store(writes)
    })
  }

  #closedError(): Exit.Exit<never, SessionFailed | SessionClosed> {
    const failure = this.#session.failure
    return Exit.fail(failure === undefined ? SessionClosed.instance : SessionFailed.of(failure.error))
  }

  // Public surface

  get resume(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.#readOnly) throw new Error("A read-only scheduler runs no tasks")
      this.#enabled = true
      this.#wakeDue()
      this.#kick()
    })
  }

  abortTask(id: TaskId): Effect.Effect<"marked" | "terminal", ReadFailure | CommitError> {
    return this.#abort(id, false)
  }

  /**
   * The abort protocol (spec 5.4). A request replaces a `restart` mark, so an abandoned task waiting for its definition
   * is orphaned; with `keepRestart`, as for an owner's own cleanup, such a task keeps its mark.
   */
  #abort(id: TaskId, keepRestart: boolean): Effect.Effect<"marked" | "terminal", ReadFailure | CommitError> {
    return Effect.gen({ self: this }, function* () {
      const marked = yield* this.#internals.commitIn({}, (tx) =>
        Effect.gen({ self: this }, function* () {
          const current = yield* tx.task(id)
          if (current === undefined) return yield* Effect.die(new Error(`Task ${id} does not exist`))
          if (current.state.status === "terminal") return { result: "terminal" as const, run: undefined }
          const invocation = this.#invocations.get(id)
          if (keepRestart && current.abortReason === "restart") return { result: "marked" as const, run: undefined }
          if (invocation === undefined && current.state.status !== "completing") {
            yield* this.#loadChains()
            if (!this.#hasOwnedLive(id, undefined)) {
              const fit = this.#resolve(current as Runnable, this.#snapshot())
              if ("reason" in fit) {
                yield* this.#terminate(tx, current, { status: "orphaned", reason: fit.reason })
                return { result: "marked" as const, run: undefined }
              }
            }
          }
          if (!current.abortRequested || current.abortReason !== undefined) tx.setTask(withAbortMark(current))
          return { result: "marked" as const, run: invocation?.mode === "run" ? invocation : undefined }
        }),
      )
      // The publication signalled the run; join it, unless the Session fails first: a run that ignores its signal
      // may never end, and a clean close joins it anyway.
      if (marked.run !== undefined)
        yield* Effect.raceFirst(Deferred.await(marked.run.done), Deferred.await(this.#failed))
      return marked.result
    })
  }

  waitForTask<R>(id: TaskId<R>): Effect.Effect<SettledTask<R>, ReadFailure> {
    return Effect.gen({ self: this }, function* () {
      // An interrupted read does not wait for its body, so the body registers only a wait not yet interrupted, and
      // the interruption unregisters one the body already registered.
      const waiter: Waiter<TaskRecord> = yield* Queue.bounded<Exit.Exit<TaskRecord, SessionFailed | SessionClosed>>(1)
      let interrupted = false
      const exit = yield* this.#session
        .read((storage) =>
          // Checked and registered on the line, so no terminal publication falls between them.
          Effect.gen({ self: this }, function* () {
            if (this.#closing) return this.#closedError()
            if (this.#live.has(id)) {
              if (!interrupted) addTo(this.#taskWaiters, id, waiter)
              return undefined
            }
            const record = yield* storage.task(id)
            if (record === undefined) return yield* Effect.die(new Error(`Task ${id} does not exist`))
            return Exit.succeed(record)
          }),
        )
        .pipe(
          Effect.flatMap((settled) => (settled === undefined ? Queue.take(waiter) : Effect.succeed(settled))),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
              deleteFrom(this.#taskWaiters, id, waiter)
            }),
          ),
        )
      return (yield* exit) as SettledTask<R>
    })
  }

  waitForIdle(conversationId?: ConversationId): Effect.Effect<void, ReadFailure> {
    return Effect.gen({ self: this }, function* () {
      const key = conversationId ?? ALL
      // Registered as waitForTask registers its waiter.
      const waiter: Waiter<void> = yield* Queue.bounded<Exit.Exit<void, SessionFailed | SessionClosed>>(1)
      let interrupted = false
      const exit = yield* this.#session
        .read(() =>
          Effect.gen({ self: this }, function* () {
            if (this.#closing) return this.#closedError()
            yield* this.#loadChains()
            if (this.#idle(conversationId)) return Exit.void
            if (!interrupted) addTo(this.#idleWaiters, key, waiter)
            return undefined
          }),
        )
        .pipe(
          Effect.flatMap((settled) => (settled === undefined ? Queue.take(waiter) : Effect.succeed(settled))),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
              deleteFrom(this.#idleWaiters, key, waiter)
            }),
          ),
        )
      return yield* exit
    })
  }

  abortConversation(
    conversationId: ConversationId,
    options: { readonly background?: boolean } = {},
  ): Effect.Effect<void, ReadFailure | CommitError> {
    const background = options.background === true
    return Effect.gen({ self: this }, function* () {
      const reached = yield* this.#internals.commitIn({}, (tx) =>
        Effect.gen({ self: this }, function* () {
          yield* this.#loadChains()
          const queued = yield* this.#queued()
          const top = conversationKey(conversationId)
          const reached: TaskId[] = []
          this.#reach(top, background, (record) => {
            reached.push(record.id)
            if (!record.abortRequested || record.abortReason !== undefined) tx.setTask(withAbortMark(record))
          })
          for (const id of queued) {
            if (id === conversationId || (yield* this.#conversationReaches(id, top, background, tx))) {
              yield* this.#withdraw(tx, id)
            }
          }
          return reached
        }),
      )
      if (background) for (const id of reached) yield* this.waitForTask(id)
      yield* this.waitForIdle(conversationId)
    })
  }

  blockedReason(record: TaskRecord): BlockedReason | undefined {
    const status = record.state.status
    if (status === "running" || status === "completing" || status === "terminal") return undefined
    // An abort request runs its handler or orphans the task; a `restart` mark waits for the definition, blocked.
    if (record.abortRequested && record.abortReason === undefined) return undefined
    const snapshot = this.#snapshotOrUndefined()
    if (snapshot === undefined) return undefined
    const fit = this.#fit(record, snapshot.task(record.kind))
    if ("reason" in fit) return fit.reason
    return fit.migrates && fit.task.definition.migrate === undefined ? "migration_failed" : undefined
  }

  wake(): Wake {
    if (this.#readOnly) return { active: false }
    const now = this.#now()
    const active = this.#invocations.size > 0 || this.#reconcileWork() || this.#reconciling || this.#runsNow(now)
    let at: number | undefined
    for (const id of this.#sleeping) {
      const record = this.#live.get(id)?.record
      const state = record?.state
      if (state?.status === "sleeping" && !record!.abortRequested && state.until > now) {
        at = at === undefined ? state.until : Math.min(at, state.until)
      }
    }
    return at === undefined ? { active } : { active, at }
  }

  get inspect() {
    return this.#session.read(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.#loadChains()
        const snapshot = this.#snapshotOrUndefined()
        const tasks: TaskInspection[] = []
        for (const { record } of this.#live.values()) tasks.push({ record, state: this.#inspectTask(record, snapshot) })
        const scheduling = this.#closing
          ? ("closing" as const)
          : this.#enabled
            ? ("running" as const)
            : ("paused" as const)
        return { scheduling, tasks }
      }),
    )
  }

  get indexSizes() {
    let below = 0
    for (const steps of this.#below.values()) below += steps.size
    let waiters = 0
    for (const set of this.#taskWaiters.values()) waiters += set.size
    for (const set of this.#idleWaiters.values()) waiters += set.size
    return { live: this.#live.size, below, conversations: this.#conversations.size, waiters }
  }

  #inspectTask(record: TaskRecord, snapshot: TaskSnapshot<unknown> | undefined): TaskInspection["state"] {
    if (this.#invocations.has(record.id)) return { kind: "running" }
    if (record.state.status === "completing") return { kind: "completing" }
    const on = this.#waitingOn(record, false)
    if (on.length > 0) return { kind: "waiting", on }
    if (this.#notDue(record)) return { kind: "sleeping", until: (record.state as { until: number }).until }
    const fit = snapshot === undefined ? undefined : this.#fit(record, snapshot.task(record.kind))
    if (fit !== undefined && "reason" in fit) {
      return { kind: "blocked", reason: fit.reason, ...("error" in fit ? { error: fit.error } : {}) }
    }
    if (fit?.migrates === true && fit.task.definition.migrate === undefined) {
      return { kind: "blocked", reason: "migration_failed", error: missingMigration(record, fit.task) }
    }
    return { kind: "ready", migrates: fit?.migrates === true }
  }

  // Publications

  /** On the line, at each stored commit: keeps `#live` and its indexes equal to the committed records. */
  #observe(publication: CommitPublication): void {
    const created = new Map<ConversationId, ConversationRecord>()
    let changed = false
    for (const change of publication.changes) {
      if (change.type === "conversation") created.set(change.value.id, change.value)
      // An input queued below a cancelled owner, even after its cascade, is withdrawn too.
      else if (
        change.type === "submission" &&
        change.value.type === "input" &&
        change.value.status === "queued" &&
        this.#intent.size > 0
      ) {
        this.#cascadePending = true
        changed = true
      }
    }
    for (const change of publication.changes) {
      if (change.type !== "task") continue
      changed = true
      const record = change.value
      const previous = this.#live.get(record.id)?.record
      this.#track(previous, record, created)
      if (record.state.status === "terminal") continue
      if (record.abortRequested && previous?.abortRequested !== true) {
        this.#cascadePending = true
        // Task code never runs inside a publication: the signal follows in a microtask, after what observers queued.
        const invocation = this.#invocations.get(record.id)
        if (invocation?.mode === "run") {
          this.#internals.afterPublication(() => queueMicrotask(() => this.#signalInvocation(invocation)))
        }
      }
      // A request replacing a `restart` mark upgrades the marks below.
      if (previous?.abortReason !== undefined && record.abortReason === undefined) this.#cascadePending = true
      if (record.state.status === "completing" && previous?.state.status !== "completing") {
        this.#finalizeChecks.add(record.id)
        if (cancellationIntent(record)) this.#cascadePending = true
      }
      if (
        record.state.status === "waiting" &&
        record.state.policy === "failFast" &&
        previous?.state.status !== "waiting"
      ) {
        this.#failFastChecks.add(record.id)
      }
      // Work created below a cancelled owner, even after its cascade, is aborted too.
      if (previous === undefined && !record.background && !record.abortRequested) {
        const live = this.#live.get(record.id)!
        if (live.chain === undefined || this.#cancellingOwner(live.chain) !== undefined) this.#cascadePending = true
      }
    }
    if (!changed) return
    this.#resolveIdleWaiters()
    this.#kick()
  }

  /**
   * Replaces `previous` (absent: a task that just became live) with `record` in every index. A terminal record leaves
   * them: its waiters get it, and what it held or blocked is checked again.
   */
  #track(
    previous: TaskRecord | undefined,
    record: TaskRecord,
    created: ReadonlyMap<ConversationId, ConversationRecord> | undefined,
  ): void {
    const id = record.id
    const phase = this.#phases.get(id)
    if (phase !== undefined) phase.record = record
    if (!this.#closing) {
      if (record.state.status === "terminal") {
        if (previous !== undefined) this.#countActive(-1, record.kind)
        this.#resumed.delete(id)
      } else if (previous === undefined) this.#countActive(1, record.kind)
    }
    if (previous?.state.status === "waiting") for (const on of previous.state.on) deleteFrom(this.#waiters, on, id)
    this.#sleeping.delete(id)
    this.#intent.delete(id)
    if (record.state.status === "terminal") {
      const live = this.#live.get(id)
      if (live !== undefined) this.#untrack(id, live)
      this.#failedMigrations.delete(id)
      this.#failFastChecks.delete(id)
      this.#finalizeChecks.delete(id)
      this.#runnable.delete(id)
      this.#abandoned.delete(id)
      const waiters = this.#taskWaiters.get(id)
      this.#taskWaiters.delete(id)
      for (const waiter of waiters ?? []) Queue.offerUnsafe(waiter, Exit.succeed(record))
      // Waiters on it may resume, and a `failFast` waiter may need marks.
      for (const waiter of this.#waiters.get(id) ?? []) {
        this.#runnable.add(waiter)
        if (failedOutcome(record)) this.#failFastChecks.add(waiter)
      }
      this.#waiters.delete(id)
      // What it held may finalize, and an abort-marked task above may start its abort handler.
      if (live?.chain !== undefined) {
        const above = this.#nearestLiveAbove(record, live.chain)
        if (above?.state.status === "completing") this.#finalizeChecks.add(above.id)
        else if (above?.abortRequested === true) this.#runnable.add(above.id)
      }
      return
    }
    let live = this.#live.get(id)
    if (live === undefined) {
      live = { record, chain: this.#chainNow(record, created) }
      this.#live.set(id, live)
      if (live.chain === undefined) this.#unloaded.add(id)
      else this.#install(record, live.chain)
    } else {
      live.record = record
    }
    if (record.state.status === "waiting") for (const on of record.state.on) addTo(this.#waiters, on, id)
    if (record.state.status === "sleeping") this.#sleeping.add(id)
    if (cancellationIntent(record)) this.#intent.add(id)
    if (record.state.status !== "completing") this.#runnable.add(id)
    if (failedOutcome(record)) for (const waiter of this.#waiters.get(id) ?? []) this.#failFastChecks.add(waiter)
  }

  /** Lists a live task whose chain is now known under its parent, and each step above it not listed yet. */
  #install(record: TaskRecord, chain: Chain): void {
    let key = taskKey(record.id)
    let step: Step = { task: record.id, background: record.background }
    for (let at: Chain | undefined = chain; at !== undefined; at = at.up) {
      const parent = stepKey(at.step)
      const listed = this.#below.get(parent)
      if (listed !== undefined) {
        listed.set(key, step)
        return
      }
      this.#below.set(parent, new Map([[key, step]]))
      if ("conversation" in at.step) this.#conversations.set(at.step.conversation, at)
      // A live task with a known chain is listed already.
      else if (this.#live.get(at.step.task)?.chain !== undefined) return
      key = parent
      step = at.step
    }
  }

  #untrack(id: TaskId, live: Live): void {
    this.#live.delete(id)
    this.#unloaded.delete(id)
    this.#sleeping.delete(id)
    this.#intent.delete(id)
    // Unlists the ended task unless steps are listed below it, then each step above that has nothing left below it.
    let key = taskKey(id)
    for (let at = live.chain; at !== undefined && !this.#below.has(key); at = at.up) {
      const parent = stepKey(at.step)
      const listed = this.#below.get(parent)
      if (listed === undefined || !listed.delete(key) || listed.size > 0) return
      this.#below.delete(parent)
      if ("conversation" in at.step) this.#conversations.delete(at.step.conversation)
      // A live task with a known chain stays listed.
      else if (this.#live.get(at.step.task)?.chain !== undefined) return
      key = parent
    }
  }

  /** The chain a live task with a known chain starts for the work below it. */
  #own(id: TaskId, live: Live): Chain {
    live.own ??= { step: { task: id, background: live.record.background }, up: live.chain! }
    return live.own
  }

  /** The chain of a task from memory alone, when every step is known; otherwise a pass loads it. */
  #chainNow(
    record: TaskRecord,
    created: ReadonlyMap<ConversationId, ConversationRecord> | undefined,
  ): Chain | undefined {
    if (record.owner !== undefined) {
      const owner = this.#live.get(record.owner)
      return owner?.chain === undefined ? undefined : this.#own(record.owner, owner)
    }
    const known = this.#conversations.get(record.conversationId)
    if (known !== undefined) return known
    const conversation = created?.get(record.conversationId)
    if (conversation === undefined) return undefined
    const ownerId = conversation.owner?.taskId
    if (ownerId === undefined) return { step: { conversation: conversation.id }, up: undefined }
    const owner = this.#live.get(ownerId)
    if (owner?.chain === undefined) return undefined
    return { step: { conversation: conversation.id }, up: this.#own(ownerId, owner) }
  }

  /** On the line: loads the chains of the live tasks whose chain is not known, from Storage. */
  #loadChains(): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      for (const id of [...this.#unloaded]) {
        const live = this.#live.get(id)
        if (live === undefined || live.chain !== undefined) continue
        live.chain = yield* this.#resolveChain(live.record, undefined)
        this.#unloaded.delete(id)
        this.#install(live.record, live.chain)
      }
    })
  }

  /** The chain above a record, read from memory, the transaction's candidates, or Storage. */
  #resolveChain(record: TaskRecord, tx: Transaction | undefined): Effect.Effect<Chain, StorageError> {
    if (record.owner !== undefined) return this.#ownChain(record.owner, tx)
    return this.#conversationChain(record.conversationId, tx)
  }

  /** The chain task `id` starts for the work below it. */
  #ownChain(id: TaskId, tx: Transaction | undefined): Effect.Effect<Chain, StorageError> {
    const live = this.#live.get(id)
    if (live?.chain !== undefined) return Effect.succeed(this.#own(id, live))
    return Effect.gen({ self: this }, function* () {
      const record = yield* this.#taskRecord(id, tx)
      const up = yield* this.#resolveChain(record, tx)
      return { step: { task: id, background: record.background }, up }
    })
  }

  #conversationChain(id: ConversationId, tx: Transaction | undefined): Effect.Effect<Chain, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const known = this.#conversations.get(id)
      if (known !== undefined) return known
      const conversation =
        tx?.stagedConversations().find((record) => record.id === id) ??
        (yield* orDieRequest(this.#internals.lineReads.conversation(id)))
      if (conversation === undefined) return yield* Effect.die(new Error(`Conversation ${id} does not exist`))
      const ownerId = conversation.owner?.taskId
      if (ownerId === undefined) return { step: { conversation: id }, up: undefined }
      return { step: { conversation: id }, up: yield* this.#ownChain(ownerId, tx) }
    })
  }

  #taskRecord(id: TaskId, tx: Transaction | undefined): Effect.Effect<TaskRecord, StorageError> {
    return Effect.gen({ self: this }, function* () {
      const record =
        this.#live.get(id)?.record ??
        (tx === undefined ? undefined : yield* tx.currentTask(id)) ??
        (yield* orDieRequest(this.#internals.lineReads.task(id)))
      if (record === undefined) return yield* Effect.die(new Error(`Task ${id} does not exist`))
      return record
    })
  }

  // Ownership walks

  /**
   * Whether `owner` has live ordinary owned work (spec 5.5), judged on `tx`'s candidates when given, so work a commit
   * creates counts and work it ends does not. The walk does not enter the tasks in `done`, known to have none. Chains
   * must be loaded.
   */
  #hasOwnedLive(owner: TaskId, tx: Transaction | undefined, done?: ReadonlySet<TaskId>): boolean {
    return this.#ownedLive(owner, tx, true, done).length > 0
  }

  #ownedLive(owner: TaskId, tx: Transaction | undefined, first: boolean, done?: ReadonlySet<TaskId>): TaskId[] {
    const top = taskKey(owner)
    const found: TaskId[] = []
    const visit = (live: TaskRecord) => {
      const record = tx?.stagedTask(live.id) ?? live
      if (record.state.status === "terminal") return false
      found.push(record.id)
      return first
    }
    this.#reach(top, false, visit, done === undefined ? undefined : (id) => !done.has(id))
    return found
  }

  /**
   * Visits the live tasks with a known chain that ordinary traversal from `top` (a task or conversation key) reaches,
   * until `visit` returns true: a walk down `#below` that enters no background task unless `crossBackground`, nor a
   * task `enter` refuses. Returns whether a visit stopped it. A loop, as chains can be deeper than the call stack.
   */
  #reach(
    top: string,
    crossBackground: boolean,
    visit: (record: TaskRecord) => boolean | void,
    enter?: (id: TaskId) => boolean,
  ): boolean {
    const pending = [top]
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      const below = this.#below.get(at)
      if (below === undefined) continue
      for (const [key, step] of below) {
        if ("task" in step) {
          if (step.background && !crossBackground) continue
          const live = this.#live.get(step.task)
          if (live?.chain !== undefined && visit(live.record) === true) return true
          if (enter !== undefined && !enter(step.task)) continue
        }
        pending.push(key)
      }
    }
    return false
  }

  /** `#hasOwnedLive` that also counts the tasks the commit creates below `owner`, whose chains may need Storage. */
  #holds(owner: TaskId, tx: Transaction): Effect.Effect<boolean, StorageError> {
    return Effect.gen({ self: this }, function* () {
      if (this.#hasOwnedLive(owner, tx)) return true
      const top = taskKey(owner)
      for (const record of tx.stagedTasks()) {
        if (this.#live.has(record.id) || record.background || record.state.status === "terminal") continue
        const chain = yield* this.#resolveChain(record, tx)
        if (chainReaches(chain, top, false)) return true
      }
      return false
    })
  }

  /** Whether ordinary traversal from `top` reaches conversation `id`. */
  #conversationReaches(
    id: ConversationId,
    top: string,
    crossBackground: boolean,
    tx: Transaction | undefined,
  ): Effect.Effect<boolean, StorageError> {
    return Effect.map(this.#conversationChain(id, tx), (chain) => chainReaches(chain, top, crossBackground))
  }

  /**
   * The nearest live owner above a chain whose cancellation intent reaches it: walking up finds an owner with intent
   * before a background owner without it. Terminal owners never cascade (spec 5.4).
   */
  #cancellingOwner(chain: Chain): TaskRecord | undefined {
    if (this.#intent.size === 0) return undefined
    for (let at: Chain | undefined = chain; at !== undefined; at = at.up) {
      const step = at.step
      if (!("task" in step)) continue
      const live = this.#live.get(step.task)?.record
      if (live !== undefined && cancellationIntent(live)) return live
      if (step.background) return undefined
    }
    return undefined
  }

  /** The nearest live task above ended ordinary work: the one it held, if any. Work at a background task holds none. */
  #nearestLiveAbove(record: TaskRecord, chain: Chain): TaskRecord | undefined {
    if (record.background) return undefined
    for (let at: Chain | undefined = chain; at !== undefined; at = at.up) {
      const step = at.step
      if (!("task" in step)) continue
      const live = this.#live.get(step.task)?.record
      if (live !== undefined) return live
      if (step.background) return undefined
    }
    return undefined
  }

  /** No live non-background task in the scope; a task whose chain is not loaded counts as inside. */
  #idle(conversationId: ConversationId | undefined): boolean {
    if (conversationId !== undefined) {
      const top = conversationKey(conversationId)
      if (this.#reach(top, false, () => true)) return false
      for (const id of this.#unloaded) if (!this.#live.get(id)!.record.background) return false
      return true
    }
    for (const live of this.#live.values()) {
      if (live.record.background) continue
      if (live.chain === undefined) return false
      if (!belowBackground(live.chain)) return false
    }
    return true
  }

  #resolveIdleWaiters(): void {
    if (this.#idleWaiters.size === 0) return
    for (const [key, waiters] of [...this.#idleWaiters]) {
      if (!this.#idle(key === ALL ? undefined : key)) continue
      this.#idleWaiters.delete(key)
      for (const waiter of waiters) Queue.offerUnsafe(waiter, Exit.void)
    }
  }

  // The driver

  #kick(): void {
    this.#dirty = true
    this.#signal()
  }

  #signal(): void {
    if (this.#closing || this.#readOnly) return
    Queue.offerUnsafe(this.#wakeup, undefined)
  }

  #reconcileWork(): boolean {
    return (
      this.#cascadePending || this.#finalizeChecks.size > 0 || this.#failFastChecks.size > 0 || this.#unloaded.size > 0
    )
  }

  /** One fiber runs every reconcile and reservation pass, in turn, whenever something signals it. */
  #drive(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const next = yield* Effect.exit(Queue.take(this.#wakeup))
        if (Exit.isFailure(next)) return
        while (!this.#closing) {
          if (this.#reconcileWork() || (this.#enabled && this.#abandoned.size > 0)) {
            this.#reconciling = true
            yield* this.#schedulerCommit((tx) => this.#reconcile(tx))
            this.#reconciling = false
            this.#resolveIdleWaiters()
            continue
          }
          if (this.#enabled && this.#dirty) {
            this.#dirty = false
            const created: Invocation[] = []
            const reservations = yield* this.#schedulerCommit((tx) => this.#reserve(tx, created))
            if (reservations === undefined) this.#dropReservations(created)
            for (const reservation of reservations ?? []) yield* this.#start(reservation)
            continue
          }
          break
        }
        this.#armSleep()
      }
    })
  }

  /**
   * A commit of the scheduler's own: no task code runs in it, so a failure is a storage failure or a bug, and running
   * it again fixes neither. It fails the Session, unless the Session is closing anyway.
   */
  #schedulerCommit<A>(body: (tx: Transaction) => Effect.Effect<A, unknown>): Effect.Effect<A | undefined> {
    return Effect.catchCause(this.#internals.commitIn({}, body), (cause) =>
      Effect.sync(() => {
        if (!this.#closing) this.#internals.fail(causeError(cause))
        return undefined
      }),
    )
  }

  /**
   * One commit applying what committed records imply: abort marks below live owners with cancellation intent (spec
   * 5.4), marks of `abandonOnRestart` tasks of an earlier process, `failFast` marks (spec 5.5), queued inputs withdrawn
   * below cancelled owners, and the terminal record of each `completing` task whose ordinary owned work drained.
   */
  #reconcile(tx: Transaction): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      if (this.#closing) return
      yield* this.#loadChains()
      const cascade = this.#cascadePending
      this.#cascadePending = false
      const queued = cascade ? yield* this.#queued() : []
      const marks = new Map<TaskId, { readonly record: TaskRecord; readonly reason: "restart" | undefined }>()
      const mark = (record: TaskRecord, reason: "restart" | undefined): void => {
        const staged = marks.get(record.id)
        if (staged !== undefined && staged.reason === undefined) return
        if (record.abortRequested && (record.abortReason === undefined || reason !== undefined)) return
        marks.set(record.id, { record, reason })
      }
      // Pointless after a restart (spec 5.4): nothing of them or below them runs a phase again.
      if (this.#enabled) {
        for (const id of this.#abandoned) {
          const record = this.#live.get(id)?.record
          if (record !== undefined && !record.abortRequested) mark(record, "restart")
        }
        this.#abandoned.clear()
      }
      if (cascade) {
        for (const id of this.#intent) {
          const owner = this.#live.get(id)!.record
          // Only an owner abandoned after a restart, and nothing else, passes its reason on.
          const restart = owner.abortReason === "restart" && !failedOutcome(owner)
          // A nested owner with intent of its own covers what is below it.
          const enter = (below: TaskId) => !this.#intent.has(below)
          this.#reach(taskKey(id), false, (record) => mark(record, restart ? "restart" : undefined), enter)
        }
      }
      for (const id of [...this.#failFastChecks]) {
        this.#failFastChecks.delete(id)
        const waiter = this.#live.get(id)?.record
        if (waiter?.state.status !== "waiting" || waiter.state.policy !== "failFast") continue
        let failed = false
        for (const member of waiter.state.on) {
          const record = this.#live.get(member)?.record ?? (yield* orDieRequest(this.#internals.lineReads.task(member)))
          if (record !== undefined && failedOutcome(record)) failed = true
        }
        if (!failed) continue
        // Every other live task: the failed one keeps its own outcome.
        for (const member of waiter.state.on) {
          const record = this.#live.get(member)?.record
          if (record !== undefined && !failedOutcome(record)) mark(record, undefined)
        }
      }
      for (const { record, reason } of marks.values()) tx.setTask(withAbortMark(record, reason))
      for (const id of queued) {
        const chain = yield* this.#conversationChain(id, tx)
        if (this.#cancellingOwner(chain) !== undefined) yield* this.#withdraw(tx, id)
      }
      yield* this.#finalize(tx)
    })
  }

  /**
   * Writes the terminal record of every `completing` task without live ordinary owned work, judged on this commit's
   * candidates. Finalizing one can free its owner, so this repeats until nothing changes. A held scheduler outcome gets
   * its cleanup here (spec 5.5, rule 4).
   */
  #finalize(tx: Transaction): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      let round = [...this.#finalizeChecks]
      this.#finalizeChecks.clear()
      // Finalized here, so without live owned work: walks from the owners above need not enter them again.
      const done = new Set<TaskId>()
      while (round.length > 0) {
        const next = new Set<TaskId>()
        for (const id of round) {
          const record = yield* tx.currentTask(id)
          if (record?.state.status !== "completing" || this.#hasOwnedLive(id, tx, done)) continue
          const outcome = record.state.outcome
          tx.setTask(withState(record, { status: "terminal", outcome }))
          done.add(id)
          if (outcome.status === "faulted" || outcome.status === "orphaned") {
            yield* this.#settle(tx, record, outcome)
          }
          const chain = this.#live.get(id)?.chain
          const above = chain === undefined ? undefined : this.#nearestLiveAbove(record, chain)
          if (above?.state.status === "completing") next.add(above.id)
        }
        round = [...next]
      }
    })
  }

  #settle(tx: Transaction, record: TaskRecord, outcome: SchedulerOutcome): Effect.Effect<void> {
    return orDieHost(this.#settleOutcome(tx, record, outcome))
  }

  /** Conversations with queued inputs, when the host withdraws them. */
  #queued(): Effect.Effect<readonly ConversationId[]> {
    if (this.#queuedInputs === undefined || this.#withdrawInputs === undefined) return Effect.succeed([])
    return orDieHost(this.#queuedInputs(this.#internals.lineReads))
  }

  #withdraw(tx: Transaction, conversationId: ConversationId): Effect.Effect<void> {
    return this.#withdrawInputs === undefined ? Effect.void : orDieHost(this.#withdrawInputs(tx, conversationId))
  }

  /**
   * Writes an outcome the scheduler decided. While the task's ordinary owned work is live it holds as `completing`, its
   * cleanup waiting for the final commit; otherwise it is terminal with its cleanup.
   */
  #terminate(tx: Transaction, record: TaskRecord, outcome: SchedulerOutcome): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.#loadChains()
      if (yield* this.#holds(record.id, tx)) {
        tx.setTask(withState(record, { status: "completing", outcome }))
        return
      }
      tx.setTask(withState(record, { status: "terminal", outcome }))
      yield* this.#settle(tx, record, outcome)
    })
  }

  // Reservation

  /**
   * Reserves every eligible task in one commit, and orphans abort-marked tasks no definition can take unless they were
   * abandoned after a restart. Runs no task code but `migrate`.
   */
  #reserve(tx: Transaction, created: Invocation[]): Effect.Effect<Reservation[], unknown> {
    return Effect.gen({ self: this }, function* () {
      const reservations: Reservation[] = []
      if (!this.#enabled || this.#closing) return reservations
      yield* this.#loadChains()
      this.#wakeDue()
      let snapshot: TaskSnapshot<unknown> | undefined
      const faulted: { readonly record: TaskRecord; readonly message: string }[] = []
      for (const id of [...this.#runnable]) {
        const record = this.#live.get(id)?.record
        if (
          this.#invocations.has(id) ||
          record === undefined ||
          record.state.status === "completing" ||
          this.#waitingOn(record, true).length > 0 ||
          this.#notDue(record)
        ) {
          this.#runnable.delete(id)
          continue
        }
        // Work below an owner with cancellation intent waits for its cascade mark instead of running a phase.
        if (!record.abortRequested && !record.background && this.#cancellingOwner(this.#live.get(id)!.chain!)) {
          this.#cascadePending = true
          continue
        }
        const mode = record.abortRequested ? "abort" : "run"
        // Work cut off `restartLimit` times in a row would run forever: an abort handler, or a phase of a kind that
        // does not end itself at the limit, ends the task `faulted`. The setting is read only for a task with a count.
        if (
          record.restarts !== undefined &&
          record.restarts >= this.#restartLimit() &&
          (mode === "abort" || !this.#limitsRestarts(record.kind))
        ) {
          const message =
            mode === "abort"
              ? `Abort handler of task ${id} (${record.kind}) was cut off ${record.restarts} times`
              : `Task ${id} (${record.kind}) was cut off ${record.restarts} times without progress`
          yield* this.#terminate(tx, record, {
            status: "faulted",
            error: { message, detail: { reason: "restart_limit" } },
          })
          this.#runnable.delete(id)
          faulted.push({ record, message })
          continue
        }
        snapshot ??= this.#snapshot()
        const resolution = this.#resolve(record as Runnable, snapshot)
        if ("reason" in resolution) {
          // An abandoned task waits for its definition, so its abort handler can clean up.
          if (mode === "abort" && record.abortReason === undefined) {
            yield* this.#terminate(tx, record, { status: "orphaned", reason: resolution.reason })
            this.#runnable.delete(id)
          }
          continue
        }
        const reserved = resolution.record
        if (reserved !== record || record.state.status !== "running") {
          tx.setTask(withState(reserved, { status: "running", checkpoint: reserved.state.checkpoint }))
        }
        this.#runnable.delete(id)
        const invocation = this.#createInvocation(record, mode)
        created.push(invocation)
        reservations.push({ invocation, task: resolution.task, snapshot })
      }
      for (const { record, message } of faulted) {
        this.#report(new Error(message), { kind: "task_faulted", task: reportTask(record), reason: "restart_limit" })
      }
      return reservations
    })
  }

  /** A reservation commit failed: nothing was stored, so its invocations never start, and its tasks are candidates. */
  #dropReservations(created: readonly Invocation[]): void {
    for (const invocation of created) {
      this.#end(invocation)
      Deferred.doneUnsafe(invocation.done, Exit.void)
    }
  }

  /**
   * Live tasks a task waits for before its next invocation: its live ordinary owned work when abort-marked, since abort
   * runs bottom-up, otherwise the live part of a wait's `on`.
   */
  #waitingOn(record: TaskRecord, first: boolean): readonly TaskId[] {
    if (record.abortRequested) return this.#ownedLive(record.id, undefined, first)
    if (record.state.status !== "waiting") return []
    const live = record.state.on.filter((id) => this.#live.has(id))
    return first ? live.slice(0, 1) : live
  }

  /** A sleep whose `until` the clock has not reached; an abort mark ends a sleep. */
  #notDue(record: TaskRecord): boolean {
    const state = record.state
    return state.status === "sleeping" && !record.abortRequested && state.until > this.#now()
  }

  /** Makes every due sleep a reservation candidate. */
  #wakeDue(): void {
    this.#wokenAt = this.#now()
    for (const id of this.#sleeping) {
      const record = this.#live.get(id)?.record
      if (record !== undefined && !this.#notDue(record)) this.#runnable.add(id)
    }
  }

  /** Whether a live task can run now. */
  #runsNow(now: number): boolean {
    const snapshot = this.#snapshotOrUndefined()
    for (const { record } of this.#live.values()) {
      const state = record.state
      if (state.status === "completing") continue
      if (state.status === "waiting" && !record.abortRequested && state.on.some((id) => this.#live.has(id))) continue
      if (state.status === "sleeping" && !record.abortRequested && state.until > now) continue
      if (record.abortRequested && this.#waitingOn(record, true).length > 0) continue
      // A task no definition can take waits for a registry change, except an abort-requested one, which is orphaned.
      if (!record.abortRequested || record.abortReason !== undefined) {
        if (snapshot !== undefined && "reason" in this.#fit(record, snapshot.task(record.kind))) continue
      }
      return true
    }
    return false
  }

  #snapshot(): TaskSnapshot<unknown> {
    return this.#registry.snapshot()
  }

  #snapshotOrUndefined(): TaskSnapshot<unknown> | undefined {
    try {
      return this.#registry.snapshot()
    } catch (error) {
      this.#report(error, { kind: "host_error", callback: "registry" })
      return undefined
    }
  }

  /** The record's definition by kind, migrating an older stored version (spec 5.4). */
  #resolve(
    record: Runnable,
    snapshot: TaskSnapshot<unknown>,
  ): { readonly task: AnyTask<unknown>; readonly record: Runnable } | { readonly reason: BlockedReason } {
    const fit = this.#fit(record, snapshot.task(record.kind))
    if ("reason" in fit) return fit
    if (!fit.migrates) return { task: fit.task, record }
    const definition = erased(fit.task)
    try {
      if (definition.migrate === undefined) throw missingMigration(record, fit.task)
      const migrated = definition.migrate(record.input, record.state.checkpoint, record.version)
      const state = { ...record.state, checkpoint: structuredClone(migrated.checkpoint) }
      const input = structuredClone(migrated.input)
      return { task: fit.task, record: { ...record, version: definition.version, input, state } as Runnable }
    } catch (error) {
      this.#failedMigrations.set(record.id, { task: fit.task, error })
      this.#report(error, { kind: "migration_failed", task: reportTask(record) })
      return { reason: "migration_failed" }
    }
  }

  #fit(record: Pick<TaskRecord, "id" | "version">, task: AnyTask<unknown> | undefined): Fit {
    if (task === undefined) return { reason: "missing_task" }
    const version = task.definition.version
    if (version === record.version) return { task, migrates: false }
    if (version < record.version) return { reason: "task_too_old" }
    const failed = this.#failedMigrations.get(record.id)
    if (failed?.task === task) return { reason: "migration_failed", error: failed.error }
    return { task, migrates: true }
  }

  // Invocations

  #createInvocation(record: TaskRecord, mode: "run" | "abort"): Invocation {
    const invocation: Invocation = {
      taskId: record.id,
      kind: record.kind,
      conversationId: record.conversationId,
      mode,
      controller: new AbortController(),
      handler: undefined,
      ended: false,
      snapshot: undefined,
      done: Deferred.makeUnsafe<void>(),
      endedSignal: Deferred.makeUnsafe<void>(),
    }
    this.#invocations.set(record.id, invocation)
    return invocation
  }

  /** Starts an invocation on a fiber of its own. Its end makes the task a candidate again. */
  #start(reservation: Reservation): Effect.Effect<void> {
    const invocation = reservation.invocation
    const run = invocation.mode === "run" ? this.#run(reservation) : this.#runAbort(reservation)
    return Effect.asVoid(
      Effect.forkDetach(
        run.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              this.#report(
                causeError(cause),
                { kind: "task_error", task: reportTask(invocation) },
                invocation.snapshot,
              ),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              this.#end(invocation)
              this.#kick()
              return Deferred.done(invocation.done, Exit.void)
            }),
          ),
        ),
      ),
    )
  }

  /** Runs phase handlers, each after a step that decides on the line whether the invocation continues. */
  #run(reservation: Reservation): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const invocation = reservation.invocation
      const state = { task: reservation.task, snapshot: reservation.snapshot, reported: UNREPORTED as unknown }
      // The reservation just stored the task running and no phase has committed yet, so the first decision needs no
      // line round trip unless its chain must load: a phase that may start does so even while the line waits on Storage.
      const reserved = this.#live.get(invocation.taskId)?.record
      let current =
        reserved?.state.status === "running" &&
        !this.#closing &&
        !this.#unloaded.has(reserved.id) &&
        this.#rules(reserved, undefined).kind === "continue"
          ? reserved
          : yield* this.#step(invocation, (task) => this.#rules(task, undefined), state)
      while (current !== undefined && !this.#closing) {
        const task = current
        const checkpoint = task.state.checkpoint as Checkpoint
        const phase = erased(state.task).phases[checkpoint.phase]
        const runtime = this.#runtime(invocation, state)
        const handler =
          phase === undefined
            ? Effect.die(new Error(`Task ${task.kind} has no phase ${checkpoint.phase}`))
            : // Built inside the handler's fiber, so a handler that throws fails its phase instead of the invocation.
              Effect.suspend(() => phase(task as RunningTask<JsonValue, never, JsonValue>, runtime))
        current = yield* this.#phase(
          invocation,
          task,
          Effect.gen({ self: this }, function* () {
            const exit = yield* this.#handle(invocation, handler, {
              mode: "run",
              task: state.task,
              record: task,
              snapshot: state.snapshot,
              runtime,
            })
            // A phase can fail with any value, `undefined` included, so the exit says whether it failed.
            const previous = Exit.isFailure(exit)
              ? { checkpoint, failed: true, failure: causeError(exit.cause) }
              : { checkpoint, failed: false, failure: undefined }
            return yield* this.#step(invocation, (next) => this.#rules(next, previous), state)
          }),
        )
      }
    })
  }

  /** Runs the abort handler once; returning without an outcome faults the task. */
  #runAbort(reservation: Reservation): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const invocation = reservation.invocation
      const current = this.#live.get(invocation.taskId)?.record
      if (current === undefined || this.#closing) return
      const state = { task: reservation.task, snapshot: reservation.snapshot, reported: UNREPORTED as unknown }
      const runtime = this.#runtime(invocation, state)
      yield* this.#phase(
        invocation,
        current,
        Effect.gen({ self: this }, function* () {
          const exit = yield* this.#handle(
            invocation,
            Effect.suspend(() =>
              erased(reservation.task).abort(current as RunningTask<JsonValue, never, JsonValue>, runtime),
            ),
            { mode: "abort", task: reservation.task, record: current, snapshot: reservation.snapshot, runtime },
          )
          const message = `Abort handler of task ${invocation.taskId} returned without a terminal outcome`
          const error = Exit.isFailure(exit) ? causeError(exit.cause) : new Error(message)
          yield* this.#step(invocation, () => ({ kind: "fault", error }), state)
        }),
      )
    })
  }

  /**
   * Runs one handler on a fiber of its own, with its services, and waits for it to end. The invocation's signal
   * interrupts it; interruption waits for Promise work started through `fromPromise` (the join rule, F6).
   */
  #handle(
    invocation: Invocation,
    handler: Effect.Effect<void, unknown, unknown>,
    phase: PhaseInfo<unknown>,
  ): Effect.Effect<Exit.Exit<void, unknown>> {
    return Effect.gen({ self: this }, function* () {
      invocation.snapshot = phase.snapshot
      let layer: Layer.Layer<unknown>
      try {
        layer = this.#services(phase)
      } catch (error) {
        this.#report(error, { kind: "host_error", callback: "services" })
        return Exit.die(error)
      }
      const provided = (handler as Effect.Effect<void, unknown, never>).pipe(
        Effect.provide(layer as Layer.Layer<never>),
      )
      const fiber = yield* Effect.forkChild(provided, { startImmediately: true })
      invocation.handler = fiber
      if (invocation.controller.signal.aborted) yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      invocation.handler = undefined
      return exit
    })
  }

  /**
   * Runs `body`, a phase invocation and its decision commit, in a `pi.durable.phase` span (spec 5.1): a child of the
   * span the task's `trace` names, linked to its `links`, else a trace of its own. It ends with the phase's outcome and
   * an error status for a faulted, failed or orphaned task, and its duration is measured.
   */
  #phase<A>(invocation: Invocation, record: TaskRecord, body: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    return Effect.gen({ self: this }, function* () {
      const { propagation } = this.#telemetry
      const parent = record.trace === undefined ? undefined : propagation?.extract(record.trace)
      const links: Tracer.SpanLink[] = []
      for (const carrier of record.links ?? []) {
        const span = propagation?.extract(carrier)
        if (span !== undefined) links.push({ span, attributes: {} })
      }
      const checkpoint = (record.state as { readonly checkpoint?: Checkpoint & { readonly attempt?: unknown } })
        .checkpoint
      const phaseName = checkpoint?.phase ?? "abort"
      const attempt = checkpoint?.attempt
      const span = yield* Effect.makeSpan("pi.durable.phase", {
        ...(parent === undefined ? { root: true } : { parent }),
        links,
        attributes: {
          "task.id": record.id,
          "task.name": record.kind,
          phase: phaseName,
          kind: invocation.mode,
          resumed: this.#resumed.delete(record.id),
          ...(typeof attempt === "number" ? { attempt } : {}),
        },
      })
      const phase: PhaseSpan = { span, record }
      this.#phases.set(record.id, phase)
      const started = performance.now()
      const exit = yield* Effect.exit(Effect.withParentSpan(body, span))
      this.#phases.delete(record.id)
      const end = phaseEnd(phase.record, invocation.ended || this.#closing)
      try {
        span.attribute("outcome", end.outcome)
        span.end(spanTime(), end.error === undefined ? Exit.void : Exit.fail(end.error))
      } catch (error) {
        this.#report(error, { kind: "host_error", callback: "telemetry" })
      }
      const duration = performance.now() - started
      const attributes = { task: record.kind, phase: phaseName, outcome: end.outcome }
      // The phase span is the measurement's context, so an adapter can tie it to the trace.
      const context = Context.add(this.#telemetry.context, Tracer.ParentSpan, span)
      updateMetric(DurableMetrics.phaseDuration, duration, attributes, context, (error) =>
        this.#report(error, { kind: "host_error", callback: "telemetry" }),
      )
      return yield* exit
    })
  }

  /** The phase span a task's invocation runs in now, if any. */
  phaseSpan(taskId: TaskId): Tracer.Span | undefined {
    return this.#phases.get(taskId)?.span
  }

  /** Counts a task in or out of `pi.durable.tasks.active`; a throwing registry is reported, as publication goes on. */
  #countActive(delta: 1 | -1, kind: string): void {
    updateMetric(DurableMetrics.tasksActive, delta, { task: kind }, this.#telemetry.context, (error) =>
      this.#report(error, { kind: "host_error", callback: "telemetry" }),
    )
  }

  #signalInvocation(invocation: Invocation): void {
    invocation.controller.abort()
    const handler = invocation.handler
    if (handler !== undefined) Effect.runFork(Fiber.interrupt(handler))
  }

  /** The precedence rules of a run invocation's step (spec 5.1). Rules 1 and 2 are applied by `#step`. */
  #rules(
    current: TaskRecord,
    previous: { readonly checkpoint: Checkpoint; readonly failed: boolean; readonly failure: unknown } | undefined,
  ): StepPlan {
    // 3. An abort mark ends the run; the abort invocation starts once the owned work drained.
    if (current.abortRequested) return { kind: "end" }
    // An owner's cancellation intent ends it too, before its cascade marks it.
    const chain = this.#live.get(current.id)?.chain
    if (!current.background && chain !== undefined && this.#cancellingOwner(chain) !== undefined) {
      return { kind: "cascade" }
    }
    if (previous === undefined) return { kind: "continue" }
    // 4. An uncaught failure.
    if (previous.failed) return { kind: "fault", error: previous.failure }
    // 6. No durable progress.
    if (jsonEqual(current.state.checkpoint as JsonValue, previous.checkpoint as unknown as JsonValue)) {
      return {
        kind: "fault",
        error: new Error(`Task ${current.kind} phase ${previous.checkpoint.phase} returned without durable progress`),
      }
    }
    return { kind: "progress" }
  }

  /**
   * One decision on the line before a phase. A task no longer running (rule 1) or a closing scheduler (rule 2) ends the
   * invocation without a write; otherwise `plan` decides. The invocation ends inside the callback, so a runtime commit
   * it queued earlier lands before the decision or is refused after it.
   */
  #step(
    invocation: Invocation,
    plan: (current: TaskRecord) => StepPlan,
    state: { task: AnyTask<unknown>; snapshot: TaskSnapshot<unknown>; reported: unknown },
  ): Effect.Effect<TaskRecord | undefined> {
    return Effect.gen({ self: this }, function* () {
      let fault: { readonly error: unknown } | undefined
      const continued = yield* this.#schedulerCommit((tx) =>
        Effect.gen({ self: this }, function* () {
          const current = this.#live.get(invocation.taskId)?.record
          if (current?.state.status !== "running" || this.#closing) {
            this.#end(invocation)
            return undefined
          }
          if (this.#unloaded.has(current.id)) yield* this.#loadChains()
          const step = plan(current)
          if (step.kind === "continue") return current
          if (step.kind === "progress" && this.#progress(tx, current, state)) return current
          this.#end(invocation)
          if (step.kind === "cascade") this.#cascadePending = true
          if (step.kind === "fault") {
            fault = { error: step.error }
            yield* this.#terminate(tx, current, { status: "faulted", error: { message: errorMessage(step.error) } })
          }
          return undefined
        }),
      )
      if (continued === undefined) this.#end(invocation)
      // Reported once the fault is durable.
      if (fault !== undefined) {
        this.#report(
          fault.error,
          { kind: "task_faulted", task: reportTask(invocation), reason: "threw" },
          invocation.snapshot,
          this.phaseSpan(invocation.taskId),
        )
      }
      return continued
    })
  }

  /**
   * Rule 5: refresh the snapshot; hand over to a replacement definition that can take the task, writing it back as
   * `pending`, or keep running under the old one, reported once per resolved definition (spec 5.4).
   */
  #progress(
    tx: Transaction,
    current: TaskRecord,
    state: { task: AnyTask<unknown>; snapshot: TaskSnapshot<unknown>; reported: unknown },
  ): boolean {
    const snapshot = this.#snapshotOrUndefined()
    if (snapshot === undefined) return true
    state.snapshot = snapshot
    const next = snapshot.task(current.kind)
    if (next === state.task) return true
    if (next !== undefined && canReserve(next, current)) {
      tx.setTask(withState(current, { status: "pending", checkpoint: checkpointOf(current) }))
      return false
    }
    if (state.reported !== next) {
      state.reported = next
      this.#report(new Error(`Task ${current.id} keeps running under its old ${current.kind} definition`), {
        kind: "task_outdated",
        task: reportTask(current),
        reason:
          next === undefined
            ? "missing_task"
            : next.definition.version < current.version
              ? "task_too_old"
              : "migration_failed",
      })
    }
    return true
  }

  /** Ends an invocation: its runtime operations fail from now on, its signal aborts, and its task is free. */
  #end(invocation: Invocation): void {
    if (invocation.ended) return
    invocation.ended = true
    if (this.#invocations.get(invocation.taskId) === invocation) {
      this.#invocations.delete(invocation.taskId)
      if (this.#live.has(invocation.taskId)) this.#runnable.add(invocation.taskId)
    }
    // Listeners on the signal run off the line.
    queueMicrotask(() => {
      invocation.controller.abort()
      Deferred.doneUnsafe(invocation.endedSignal, Exit.void)
    })
  }

  // The runtime

  #runtime(
    invocation: Invocation,
    state: { task: AnyTask<unknown>; snapshot: TaskSnapshot<unknown> },
  ): TaskRuntime<JsonValue, never, JsonValue> {
    const ended = () => Effect.fail(new InvocationEnded({ message: `Task ${invocation.taskId} invocation has ended` }))
    const read = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | InvocationEnded, R> =>
      Effect.suspend((): Effect.Effect<A, E | InvocationEnded, R> => (invocation.ended ? ended() : effect))
    const runtime: TaskRuntime<JsonValue, never, JsonValue> = {
      taskId: invocation.taskId as TaskId<JsonValue>,
      conversationId: invocation.conversationId,
      signal: invocation.controller.signal,
      get registry() {
        return state.snapshot
      },
      guard: read,
      commit: (change) =>
        Effect.gen({ self: this }, function* () {
          let interrupted:
            | { readonly message: string; readonly reason: InterruptReason; readonly restarts: number }
            | undefined
          let checkpoint: string | undefined
          yield* this.#gated(invocation, (tx, current) =>
            Effect.gen({ self: this }, function* () {
              const next = yield* change(tx, current as RunningTask<JsonValue, never, JsonValue>)
              if (next === undefined) return
              yield* this.#commitState(tx, invocation, current, next as NextTaskState<JsonValue, JsonValue>)
              const phase = (next as { readonly checkpoint?: Checkpoint }).checkpoint?.phase
              if (next.status === "running" && (checkpointOf(current) as Checkpoint).phase !== phase) checkpoint = phase
              const ending = next.status === "terminal" ? endedForCrashes(next) : undefined
              if (ending !== undefined) interrupted = { ...ending, restarts: current.restarts ?? 0 }
            }),
          )
          const span = this.phaseSpan(invocation.taskId)
          // Reported once stored, so a host keeps a crash-loop signal.
          if (interrupted !== undefined) {
            const { message, reason, restarts } = interrupted
            this.#report(
              new Error(message),
              { kind: "task_interrupted", task: reportTask(invocation), reason, restarts },
              invocation.snapshot,
              span,
            )
          }
          if (checkpoint !== undefined && span !== undefined) {
            try {
              span.event("pi.durable.checkpoint", spanTime(), { phase: checkpoint })
            } catch (error) {
              this.#report(error, { kind: "host_error", callback: "telemetry" })
            }
          }
        }),
      memo: ((name: string, ...rest: readonly JsonValue[]) => {
        if (rest.length === 0) return read(Effect.sync(() => memoOf(this.#live.get(invocation.taskId)?.record, name)))
        const candidate = rest[0]!
        return this.#gated(invocation, (tx, current) =>
          Effect.sync(() => {
            const winner = memoOf(current, name)
            if (winner !== undefined) return winner
            tx.setTask({ ...current, memos: { ...current.memos, [name]: candidate } } as TaskRecord)
            return candidate
          }),
        )
      }) as TaskRuntime<JsonValue, never, JsonValue>["memo"],
      sleepUntil: (until, checkpoint) =>
        this.#gated(invocation, (tx, current) =>
          this.#commitState(tx, invocation, current, { status: "sleeping", checkpoint, until }),
        ),
      getTask: (id) => read(this.#session.read((storage) => storage.task(id))) as never,
      waitForTask: (id) =>
        read(Effect.raceFirst(this.waitForTask(id), Effect.andThen(Deferred.await(invocation.endedSignal), ended()))),
      abortOwned: (id) =>
        read(
          Effect.gen({ self: this }, function* () {
            const record = yield* this.#session.read((storage) => storage.task(id))
            if (record?.owner !== invocation.taskId) {
              return yield* Effect.die(new Error(`Task ${id} is not owned by task ${invocation.taskId}`))
            }
            if (record.state.status === "terminal") return
            yield* this.#abort(id, true)
            yield* this.waitForTask(id)
          }),
        ),
      ownedTasks: () =>
        read(
          this.#session.read(() =>
            Effect.sync(() => {
              const owned: TaskRecord[] = []
              for (const step of this.#below.get(taskKey(invocation.taskId))?.values() ?? []) {
                const record = "task" in step ? this.#live.get(step.task)?.record : undefined
                if (record !== undefined) owned.push(record)
              }
              return owned.sort((a, b) => a.id - b.id)
            }),
          ),
        ),
      outcomes: (ids) =>
        read(
          this.#session.read((storage) =>
            Effect.gen(function* () {
              const outcomes: TaskOutcome<never>[] = []
              for (const id of ids) {
                const state = (yield* storage.task(id))?.state
                if (state?.status !== "terminal") return yield* Effect.die(new Error(`Task ${id} is not terminal`))
                outcomes.push(state.outcome as TaskOutcome<never>)
              }
              return outcomes
            }),
          ),
        ),
      entry: (id: EntryId) =>
        read(
          this.#session.read((storage) =>
            Effect.map(storage.entry(invocation.conversationId, id), (stored) => stored?.entry),
          ),
        ),
      entries: (query: Omit<EntryQuery, "conversationId">, limit: number, cursor?: Cursor) =>
        read(
          this.#session.read((storage) =>
            storage.scanEntries({ ...query, conversationId: invocation.conversationId }, limit, cursor),
          ),
        ),
      snapshot: ((token: AnyDocToken, ...address: DocAddressArgs<AnyDocToken>) =>
        read(this.#session.snapshot(token, ...address))) as TaskRuntime<JsonValue, never, JsonValue>["snapshot"],
      now: () => {
        if (invocation.ended) throw new InvocationEnded({ message: `Task ${invocation.taskId} invocation has ended` })
        return this.#now()
      },
      report: (error) => {
        if (invocation.ended) throw new InvocationEnded({ message: `Task ${invocation.taskId} invocation has ended` })
        this.#report(
          error,
          { kind: "task_error", task: reportTask(invocation) },
          invocation.snapshot,
          this.phaseSpan(invocation.taskId),
        )
      },
    }
    return runtime
  }

  /** A commit after rereading the task on the line and checking the invocation may still commit (spec 5.1). */
  #gated<A, E>(
    invocation: Invocation,
    change: (tx: Transaction, current: TaskRecord) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | InvocationEnded | CommitError> {
    const refuse = (why: string) => Effect.fail(new InvocationEnded({ message: `Task ${invocation.taskId} ${why}` }))
    return Effect.suspend((): Effect.Effect<A, E | InvocationEnded | CommitError> => {
      if (invocation.ended) return refuse("invocation has ended")
      return this.#internals.commitIn({ conversationId: invocation.conversationId, taskId: invocation.taskId }, (tx) =>
        Effect.suspend((): Effect.Effect<A, E | InvocationEnded> => {
          if (invocation.ended) return refuse("invocation has ended")
          if (this.#closing) return refuse("cannot commit: the scheduler is closing")
          const found = this.#live.get(invocation.taskId)?.record
          if (found === undefined) return refuse("is terminal")
          if (found.state.status !== "running") return refuse(`is ${found.state.status}`)
          if (invocation.mode === "run" && found.abortRequested) return refuse("has a durable abort mark")
          return change(tx, found)
        }),
      )
    })
  }

  /**
   * Replaces a running task's state with what it committed. A terminal state holds as `completing` while ordinary owned
   * work is live, judged on the commit's candidates. A wait or sleep is validated first. A state that differs from the
   * current one is progress: the restart count starts over.
   */
  #commitState(
    tx: Transaction,
    invocation: Invocation,
    current: TaskRecord,
    next: NextTaskState<JsonValue, JsonValue>,
  ): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      if (next.status === "waiting") yield* this.#validateWait(tx, invocation, current, next.on, next.policy)
      if (next.status === "sleeping") {
        if (invocation.mode === "abort")
          return yield* Effect.die(new Error(`Abort handler of task ${current.id} cannot sleep`))
        const until = next.until
        if (typeof until !== "number" || !Number.isFinite(until) || until < 0) {
          return yield* Effect.die(
            new Error(`Task ${current.id} cannot sleep until ${until}: not a time in milliseconds`),
          )
        }
      }
      if (next.status === "terminal") {
        yield* this.#loadChains()
        if (yield* this.#holds(current.id, tx)) {
          tx.setTask(withState(progressed(current), { status: "completing", outcome: next.outcome }))
          return
        }
      }
      const same = jsonEqual(current.state as unknown as JsonValue, next as unknown as JsonValue)
      tx.setTask(withState(same ? current : progressed(current), next as TaskState<JsonValue, JsonValue>))
    })
  }

  /**
   * A wait names existing tasks, and `failFast` only tasks the waiter owns. It may not close a cycle in the wait-for
   * graph, whose edges run from each task to what it waits on and to its live ordinary owned work (spec 5.5).
   */
  #validateWait(
    tx: Transaction,
    invocation: Invocation,
    current: TaskRecord,
    on: readonly TaskId[],
    policy: string,
  ): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      if (invocation.mode === "abort")
        return yield* Effect.die(new Error(`Abort handler of task ${current.id} cannot wait`))
      yield* this.#loadChains()
      const targets: TaskId[] = []
      for (const id of on) {
        const member = (yield* tx.currentTask(id)) ?? this.#live.get(id)?.record
        if (member === undefined) return yield* Effect.die(new Error(`Task ${id} does not exist`))
        if (policy === "failFast" && member.owner !== current.id) {
          return yield* Effect.die(
            new Error(`Task ${current.id} can wait failFast only on tasks it owns; ${id} is not one`),
          )
        }
        // A live child already holds the waiter: waiting on it adds no edge. A terminal task has no edges.
        if (member.state.status !== "terminal" && member.owner !== current.id) targets.push(id)
      }
      if (targets.length === 0) return
      const cycle = this.#waitCycle(current.id, targets, tx)
      if (cycle !== undefined) {
        return yield* Effect.die(
          new Error(
            `Task ${current.id} cannot wait on ${cycle[0]}: ${[current.id, ...cycle].join(" -> ")} is a wait cycle`,
          ),
        )
      }
    })
  }

  /**
   * The path from a member of `on` back to `task` in the wait-for graph, if the wait would close a cycle. An edge X -> Y
   * means X cannot settle before Y: Y is in the `on` of waiting X that is not abort-marked, or Y is live ordinary owned
   * work of X. Each task is visited once.
   */
  #waitCycle(task: TaskId, on: readonly TaskId[], tx: Transaction): TaskId[] | undefined {
    const staged = new Map<TaskId, TaskRecord>(tx.stagedTasks().map((record) => [record.id, record]))
    const from = new Map<TaskId, TaskId | undefined>()
    const pending: TaskId[] = []
    const reach = (id: TaskId, via: TaskId | undefined): void => {
      if (from.has(id)) return
      from.set(id, via)
      pending.push(id)
    }
    for (const id of on) reach(id, undefined)
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (id === task) {
        const steps: TaskId[] = []
        for (let at: TaskId | undefined = id; at !== undefined; at = from.get(at)) steps.unshift(at)
        return steps
      }
      const record = staged.get(id) ?? this.#live.get(id)?.record
      if (record === undefined || record.state.status === "terminal") continue
      if (record.state.status === "waiting" && !record.abortRequested)
        for (const member of record.state.on) reach(member, id)
      for (const below of this.#ownedLive(id, tx, false)) reach(below, id)
    }
    return undefined
  }

  // Sleeps

  /** Keeps a fiber for the earliest sleep, on the scheduler's clock. It holds the process: a sleep is work left. */
  #armSleep(): void {
    if (this.#closing || !this.#enabled) return
    // A sleep due by the last reservation pass was a candidate there; one due since needs the timer, at once.
    let at: number | undefined
    for (const id of this.#sleeping) {
      const record = this.#live.get(id)?.record
      const state = record?.state
      if (state?.status === "sleeping" && !record!.abortRequested && state.until > this.#wokenAt) {
        at = at === undefined ? state.until : Math.min(at, state.until)
      }
    }
    if (this.#timer?.at === at) return
    if (this.#timer !== undefined) Effect.runFork(Fiber.interrupt(this.#timer.fiber))
    this.#timer = undefined
    if (at === undefined) return
    const fiber = Effect.runFork(
      Effect.andThen(
        this.#clock.sleep(Duration.millis(Math.max(0, at - this.#now()))),
        Effect.sync(() => {
          if (this.#timer?.fiber !== fiber) return
          this.#timer = undefined
          this.#wakeDue()
          this.#kick()
        }),
      ),
    )
    this.#timer = { at, fiber }
  }

  #now(): number {
    return this.#internals.now()
  }
}

type SettleOutcome = NonNullable<TaskSchedulerOptions<unknown>["settleOutcome"]>

/** A read the scheduler makes on the line; an invalid request is a bug of the scheduler, not a failure to handle. */
const orDieRequest = <A>(effect: Effect.Effect<A, ReadError>): Effect.Effect<A, StorageError> =>
  Effect.catchTag(effect, "StorageRequestError", (error) => Effect.die(error))

/** A host callback's failure inside a scheduler commit: a defect of the host, which fails the commit. */
const orDieHost = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
  Effect.catchCause(effect, (cause) => Effect.die(causeError(cause)))

/** The checkpoint of a live record that has one. */
function checkpointOf(record: TaskRecord): JsonValue {
  return (record.state as { readonly checkpoint: JsonValue }).checkpoint
}

type Runnable = TaskRecord & {
  readonly state: { readonly status: "pending" | "running" | "waiting" | "sleeping"; readonly checkpoint: JsonValue }
}

/**
 * Whether ordinary traversal from `top` (a task or conversation key) reaches the work below `chain`: `top` is on it and
 * no background task lies between, unless `crossBackground`.
 */
function chainReaches(chain: Chain, top: string, crossBackground: boolean): boolean {
  for (let at: Chain | undefined = chain; at !== undefined; at = at.up) {
    if (stepKey(at.step) === top) return true
    if ("task" in at.step && at.step.background && !crossBackground) return false
  }
  return false
}

/** Whether a background task is on `chain`. */
function belowBackground(chain: Chain): boolean {
  for (let at: Chain | undefined = chain; at !== undefined; at = at.up) {
    if ("task" in at.step && at.step.background) return true
  }
  return false
}

type InterruptReason = "restart_limit" | "interrupted"

/** Terminal states marked by `endedByCrashes`, with their message; keyed by the state, so nothing is stored. */
const endedByCrashesStates = new WeakMap<object, string>()

/**
 * `state`, a terminal state a task commits, marked as ending its task for crashes: the scheduler reports it
 * `task_interrupted` with `message`, whatever its outcome, as a run that answered and ends `completed` without its
 * after-run tasks.
 */
export function endedByCrashes<T extends object>(state: T, message: string): T {
  endedByCrashesStates.set(state, message)
  return state
}

/** Why a terminal state ends its task for crashes, if it does. */
function endedForCrashes(
  state: Extract<NextTaskState<JsonValue, JsonValue>, { readonly status: "terminal" }>,
): { readonly message: string; readonly reason: InterruptReason } | undefined {
  const outcome = state.outcome
  if (outcome.status === "failed") {
    const detail = outcome.error.detail
    const reason = typeof detail === "object" && detail !== null && "reason" in detail ? detail.reason : undefined
    if (reason === "restart_limit" || reason === "interrupted") return { message: outcome.error.message, reason }
  }
  const message = endedByCrashesStates.get(state)
  return message === undefined ? undefined : { message, reason: "restart_limit" }
}

function reportTask(
  task: { readonly kind: string; readonly conversationId: ConversationId } & (
    | { readonly id: TaskId }
    | { readonly taskId: TaskId }
  ),
): ReportTask {
  return { id: "id" in task ? task.id : task.taskId, kind: task.kind, conversationId: task.conversationId }
}

/** The record with an abort mark: `restart` for an abandonment; without a reason, a request. The count starts over. */
function withAbortMark(record: TaskRecord, reason?: "restart"): TaskRecord {
  const { abortReason: _reason, restarts: _restarts, ...rest } = record
  return { ...rest, abortRequested: true, ...(reason === undefined ? {} : { abortReason: reason }) } as TaskRecord
}

/** A live owner's durable cancellation intent: its abort mark, or a held outcome other than `completed`. */
function cancellationIntent(record: TaskRecord): boolean {
  return record.state.status !== "terminal" && (record.abortRequested || failedOutcome(record))
}

/** Whether the record holds or ends with an outcome other than `completed`. */
function failedOutcome(record: TaskRecord): boolean {
  const state = record.state
  return (state.status === "completing" || state.status === "terminal") && state.outcome.status !== "completed"
}

/** The record without its restart count, as after a state the task committed. */
function progressed(record: TaskRecord): TaskRecord {
  if (record.restarts === undefined) return record
  const { restarts: _restarts, ...rest } = record
  return rest as TaskRecord
}

/** Replaces a live record's state; memos and the restart count go once an outcome is decided. */
function withState(record: TaskRecord, state: TaskState<JsonValue, JsonValue>): TaskRecord {
  if (state.status !== "terminal" && state.status !== "completing") return { ...record, state } as TaskRecord
  const { memos: _memos, restarts: _restarts, ...rest } = record
  return { ...rest, state } as TaskRecord
}

function canReserve(task: AnyTask<unknown>, record: TaskRecord): boolean {
  const definition = task.definition
  return (
    definition.version === record.version || (definition.version > record.version && definition.migrate !== undefined)
  )
}

function missingMigration(record: TaskRecord, task: AnyTask<unknown>): Error {
  return new Error(`Task ${record.kind} version ${task.definition.version} has no migration from ${record.version}`)
}

/** Own memo entry only: names such as `toString` must not resolve to inherited properties. */
function memoOf(record: TaskRecord | undefined, name: string): JsonValue | undefined {
  const memos = record?.memos
  return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined
}

function erased(task: AnyTask<unknown>): Erased {
  return task.definition as unknown as Erased
}

/** The error a failed exit carries: its failure, its defect, or an interruption. */
function causeError(cause: Cause.Cause<unknown>): unknown {
  const reason = cause.reasons[0]
  if (reason?._tag === "Fail") return reason.error
  if (reason?._tag === "Die") return reason.defect
  return new Error("interrupted")
}

/** Structural equality of two JSON values; object key order is ignored. */
function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index]))
  }
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key)
  if (values === undefined) map.set(key, new Set([value]))
  else values.add(value)
}

function deleteFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key)
  if (values === undefined) return
  values.delete(value)
  if (values.size === 0) map.delete(key)
}

/**
 * How a phase ended, from its task's latest record (spec 5.1): `done`, `aborted` or `faulted` for a terminal or held
 * outcome, `waiting` or `sleeping`, `aborted` for an invocation that ended without a decision, else `next=<phase>`. A
 * faulted, failed or orphaned outcome is an error named `task_<status>`, its message cut to 500 characters.
 */
function phaseEnd(record: TaskRecord, ended: boolean): { readonly outcome: string; readonly error?: Error } {
  const state = record.state
  if (state.status === "terminal" || state.status === "completing") {
    const outcome = state.outcome
    if (outcome.status === "completed") return { outcome: "done" }
    if (outcome.status === "aborted") return { outcome: "aborted" }
    const error = new Error((outcome.status === "orphaned" ? outcome.reason : outcome.error.message).slice(0, 500))
    error.name = `task_${outcome.status}`
    return { outcome: "faulted", error }
  }
  if (state.status === "waiting" || state.status === "sleeping") return { outcome: state.status }
  if (ended || state.status !== "running") return { outcome: "aborted" }
  return { outcome: `next=${(state.checkpoint as Checkpoint).phase}` }
}
