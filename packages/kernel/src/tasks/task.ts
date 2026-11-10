// Task definitions and the runtime a phase handler gets (spec 5.1), as Effects.
import type { Effect } from "effect"
import type { AnyDocToken, DocAddressArgs, DocValue } from "../documents/definition.ts"
import type { InvocationEnded } from "../errors.ts"
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  JoinPolicy,
  JsonValue,
  Page,
  SubmissionId,
  TaskId,
  TaskOutcome,
  TaskRecord,
  TaskState,
  TelemetryCarrier,
} from "../records.ts"
import type { CommitError, ReadFailure } from "../session/session.ts"
import type { Tx } from "../session/transaction.ts"

/** Who owns a task: its conversation (a top-level task) or another task of the same conversation (spec 5.5). */
export type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId }

export type TaskOptions = {
  /** Required: a task always names its owner. */
  readonly ownership: TaskOwnership
  /** Default: the owner task's conversation, or the commit's bound conversation. */
  readonly conversationId?: ConversationId
  /** Conversation-owned tasks only: left out of conversation abort and idle, and of cascades. */
  readonly background?: boolean
  /** Its creator awaits it only in memory and does not resume after a restart (spec 5.4). */
  readonly abandonOnRestart?: boolean
  /**
   * The span its phases continue, as a carrier of the host's propagation. Omitted: the span the commit was made in.
   * `"root"`: none, so each phase starts a trace of its own.
   */
  readonly trace?: TelemetryCarrier | "root"
  /** Spans its phases link to, such as the other inputs of a run. */
  readonly links?: readonly TelemetryCarrier[]
  /** A run's inputs: the trace of the first submission's span, links to the others'. Replaces `trace` and `links`. */
  readonly traceFrom?: readonly SubmissionId[]
}

/** A task record whose state is `running`. */
export type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
  readonly state: Extract<TaskState<S, R>, { readonly status: "running" }>
}

/**
 * The state a task commits for itself: a new checkpoint, a wait, a sleep, or its outcome. A `terminal` state holds as
 * `completing` while ordinary owned work below the task is live (spec 5.5).
 */
export type NextTaskState<S, R> = Extract<
  TaskState<S, R>,
  { readonly status: "running" | "waiting" | "sleeping" | "terminal" }
>

/** A terminal task record: the durable result receipt (spec 5.3). */
export type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
  readonly state: { readonly status: "terminal"; readonly outcome: TaskOutcome<R> }
}

/**
 * What a phase or abort handler can do. Every operation fails with `InvocationEnded` once the invocation has ended, and
 * the invocation's `signal` aborts then.
 */
export interface TaskRuntime<I, S, R> {
  readonly taskId: TaskId<R>
  readonly conversationId: ConversationId
  /** Aborts when the invocation ends, for whatever reason. */
  readonly signal: AbortSignal
  /** The registry snapshot of the current phase; refreshed at every phase boundary. */
  readonly registry: TaskSnapshot<unknown>
  /** Runs `effect` unless the invocation has ended; for services that act for this invocation. */
  guard<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | InvocationEnded, R>

  /**
   * One commit on the Session line, after rereading the task: it fails with `InvocationEnded` when the invocation ended,
   * the Session is closing, the task is not running, or a run invocation's task carries an abort mark. A returned state
   * replaces the task's state in the same commit; returning nothing leaves it. `tx.createTask()` defaults to the task's
   * conversation, and entries it appends record the task as `byTaskId`.
   */
  commit<E = never>(
    change: (tx: Tx, current: RunningTask<I, S, R>) => Effect.Effect<NextTaskState<S, R> | undefined, E>,
  ): Effect.Effect<void, E | InvocationEnded | CommitError>
  /** The committed memo `name`. */
  memo<T extends JsonValue>(name: string): Effect.Effect<T | undefined, InvocationEnded>
  /** The memo `name`: `candidate` if none is stored, in one gated commit; the first writer wins (spec 5.2). */
  memo<T extends JsonValue>(name: string, candidate: T): Effect.Effect<T, InvocationEnded | CommitError>
  /** Commits `{ status: "sleeping", until, checkpoint }`; succeeds once stored (spec 5.6). The phase returns after. */
  sleepUntil(until: number, checkpoint: S): Effect.Effect<void, InvocationEnded | CommitError>

  /** The committed task record. */
  getTask<T>(
    id: TaskId<T>,
  ): Effect.Effect<TaskRecord<JsonValue, JsonValue, T> | undefined, InvocationEnded | ReadFailure>
  /** The terminal receipt; fails when the invocation ends first. */
  waitForTask<T>(id: TaskId<T>): Effect.Effect<SettledTask<T>, InvocationEnded | ReadFailure>
  /** `abortTask()` of a task this task owns, succeeding once it is terminal; a defect for a task another owns. */
  abortOwned(id: TaskId): Effect.Effect<void, InvocationEnded | ReadFailure | CommitError>
  /** Live tasks this task owns directly, in ID order. */
  ownedTasks(): Effect.Effect<readonly TaskRecord[], InvocationEnded | ReadFailure>
  /** Outcomes of terminal tasks, in order; a defect when one is not terminal. Read after a wait (spec 5.5). */
  outcomes<T>(ids: readonly TaskId<T>[]): Effect.Effect<readonly TaskOutcome<T>[], InvocationEnded | ReadFailure>
  /** A committed entry visible from the task's conversation. */
  entry(id: EntryId): Effect.Effect<EntryRecord | undefined, InvocationEnded | ReadFailure>
  /** Committed history of the task's conversation, fork-aware. */
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor?: Cursor,
  ): Effect.Effect<Page<EntryRecord>, InvocationEnded | ReadFailure>
  /** The committed value at a document address (spec 3.3). */
  snapshot<K extends AnyDocToken>(
    token: K,
    ...address: DocAddressArgs<K>
  ): Effect.Effect<Readonly<DocValue<K>> | undefined, InvocationEnded | ReadFailure>
  /** The scheduler's clock. */
  now(): number
  /** Forwards a non-fatal failure as this task's `task_error`. */
  report(error: unknown): void
}

/** A phase handler: the work of one phase, ending with a commit that moves the task on (spec 5.1). */
export type PhaseHandler<I, P, S, R, Svc> = (
  task: RunningTask<I, P, R>,
  runtime: TaskRuntime<I, S, R>,
) => Effect.Effect<void, unknown, Svc>

export type TaskDefinition<I, S extends { readonly phase: string }, R, Svc = never> = {
  readonly name: string
  readonly version: number
  initial(input: I): S
  readonly phases: { readonly [P in S["phase"]]: PhaseHandler<I, Extract<S, { readonly phase: P }>, S, R, Svc> }
  /** Decides the outcome of an aborted task; returning without a terminal outcome faults it. */
  abort(task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R>): Effect.Effect<void, unknown, Svc>
  /** Moves the input and checkpoint of an older stored version to this one; called at reservation. */
  migrate?(input: JsonValue, checkpoint: JsonValue, fromVersion: number): { readonly input: I; readonly checkpoint: S }
}

export interface Task<I, S extends { readonly phase: string }, R, Svc = never> {
  readonly definition: TaskDefinition<I, S, R, Svc>
}

// biome-ignore lint: an erased task of any shape
export type AnyTask<Svc = never> = Task<any, any, any, Svc>

/** Defines an executable task. A scheduler runs tasks of its kind once its registry lists it. */
export const defineTask = <I, S extends { readonly phase: string }, R, Svc = never>(
  definition: TaskDefinition<I, S, R, Svc>,
): Task<I, S, R, Svc> => ({ definition })

/** The task definitions a scheduler can run, as of one moment. */
export interface TaskSnapshot<Svc> {
  /** The definition registered for a kind; `undefined` when none is. */
  task(kind: string): AnyTask<Svc> | undefined
}

/** Where a scheduler finds definitions. A change lets blocked tasks run, and running ones hand over at a boundary. */
export interface TaskRegistry<Svc> {
  snapshot(): TaskSnapshot<Svc>
  /** Calls `listener` when the registry changes; returns the unsubscribe. */
  subscribe?(listener: () => void): () => void
}

export type { JoinPolicy }
