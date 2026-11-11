// `pi.live`: run control and the presentation of a conversation's current work (spec 8.2), and the commits that end a
// run. From pi-durable's `src/harness/live.ts` at 7d073328e (MIT, see LICENSE). Partial output is committed state
// here, not a deferred commit (D5): a crash keeps what was committed.
import type { Draft } from "@nisse/delta"
import { copyJson, type JsonValue } from "@nisse/delta/json"
import {
  type ConversationId,
  defineDoc,
  type DocError,
  type EntryId,
  type JsonObject,
  type SchedulerOutcome,
  type StorageError,
  type SubmissionId,
  type SubmissionSettlement,
  type TaskId,
  type TaskRecord,
  type Tx,
  type TypedEntry,
} from "@nisse/kernel"
import type { AssistantMessage, JsonRepresentation, Usage } from "@nisse/models"
import { Effect } from "effect"
import { removeApproval } from "./approvals.ts"
import { AssistantEntry, stored } from "./entries.ts"
import type { CompactionReason, ToolDiagnostic } from "./types.ts"
import { recordUsage } from "./usage.ts"

/** A typed value as a document stores it: plain JSON with mutable containers. */
export type Stored<T> = T extends readonly (infer U)[]
  ? Stored<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Stored<T[K]> }
    : T

/** What a running tool call publishes, shared by model-issued and nested calls. */
type SlotProgress = {
  callId: string
  name: string
  status: "pending" | "running" | "done"
  /** Retained running output and what the bounds dropped. */
  output?: string
  droppedBytes?: number
  droppedLines?: number
  /** Last `details()` value. */
  details?: JsonValue
  /** Diagnostics recorded through `api.diagnostic()`. */
  diagnostics?: ToolDiagnostic[]
}

/** Presentation of one tool call of the current round. */
export type ToolSlot = SlotProgress & {
  /** Absent for a call not started yet (sequential round). */
  taskId?: TaskId
  /** A call to a tool its request did not offer: its task settles `tool_unavailable` without running anything. */
  unoffered?: true
  /** Result entry once done; absent when the tool task faulted or was orphaned. */
  entry?: EntryId
}

/**
 * Presentation of one nested call, a call a running tool made: `callId` is `<parentCallId>/<key>`; `taskId` is the
 * call's tool task, `parentTaskId` the calling one.
 */
export type NestedToolSlot = SlotProgress & {
  parentCallId: string
  parentTaskId: TaskId
  taskId: TaskId
  /** What the call was made with, replaced by the arguments it runs with once it starts executing. */
  arguments: JsonObject
  /** Once done: how the call ended, for a status line. */
  summary?: NestedToolSummary
}

/** How a nested call ended: an error flag, its execution time, its spend, and up to 500 characters of error text. */
export type NestedToolSummary = {
  isError: boolean
  durationMs?: number
  usage?: Stored<JsonRepresentation<Usage>>
  error?: string
}

/** Presentation of one live compaction task (spec 8.7). */
export type CompactionStatus = {
  taskId: TaskId
  /** What started it: `compact()`, a threshold, or a context overflow. */
  trigger: CompactionReason
  /** Whether a generation waits for it: a compaction the generation owns. */
  blocking: boolean
  attempt: number
  /** Durable backoff before the next summarization attempt. */
  retry?: { at: number; error: string }
}

/** The newest compaction that failed since a compaction last produced a summary (spec 8.7). */
export type CompactionFailure = {
  taskId: TaskId
  trigger: CompactionReason
  /** The failed or faulted outcome's error message, or why the scheduler orphaned the task. */
  error: string
}

/**
 * Why a run ended without an answer: `model_error` (the response failed after any retries, or the compaction a
 * request needed failed), `no_model`, `aborted`, `reset` (a queued reset cut it at the post-tools boundary),
 * `faulted`, `orphaned`, `interrupted` (the host stopped while the model answered, more often than the retries allow),
 * `restart_limit`, `nothing_to_answer` (the context did not end in a user message or tool results) and `turn_limit`.
 */
export type RunFailureReason =
  | "model_error"
  | "no_model"
  | "aborted"
  | "reset"
  | "faulted"
  | "orphaned"
  | "interrupted"
  | "restart_limit"
  | "nothing_to_answer"
  | "turn_limit"

/** The newest run that ended without an answer (spec 8.2). */
export type RunFailure = {
  /** The task that ended the run. */
  taskId: TaskId
  /** The run's inputs, settled `unanswered`. */
  inputs: SubmissionId[]
  reason: RunFailureReason
  detail?: string
  /** The failed run's `run.first`, so a continue's `afterRun` hooks see its history too. */
  first?: EntryId
}

/** Run control (spec 8.2). */
export type LiveRun = {
  /** The task that settles the run's inputs: its generation, handed from one to the next. */
  taskId: TaskId
  /** The run's placed inputs, settled when it ends; `[]` once it answered and runs only its `afterRun` tasks. */
  inputs: SubmissionId[]
  /** Tool rounds so far, which `maxTurns` bounds; an `onYield` continuation starts the count over. */
  turns: number
  /** The run's first entry: the first one the boundary that started it placed, or its first tool-calling answer. */
  first?: EntryId
  /** Present once the run answered and waits for the tasks `afterRun` hooks asked for, listed once created. */
  afterRun?: { tasks?: TaskId[] }
}

/** Built-in live conversation state: run control and presentation of the current generation and tool round. */
export type LiveState = {
  /** Present exactly while busy, also while a run that answered runs its `afterRun` tasks. */
  run?: LiveRun
  /** Presentation of the current generation attempt. */
  generation?: {
    attempt: number
    /** Committed throttled partial of the in-flight response. */
    message?: Stored<JsonRepresentation<AssistantMessage>>
    /** Durable backoff before the next attempt. */
    retry?: { at: number; error: string }
    /** Provider-side deferred response being polled. */
    deferred?: { pollAt: number }
  }
  /** The current tool round in call order, from the tool-calling answer until the generation's `tools` phase ends it. */
  tools?: ToolSlot[]
  /** Nested calls of running tool calls, in creation order, so a parent precedes its children and task IDs ascend. */
  nestedTools?: NestedToolSlot[]
  /** Live compaction tasks in task ID order; absent when none. */
  compactions?: CompactionStatus[]
  compactionFailure?: CompactionFailure
  /**
   * Why the newest run ended without an answer. Set in the commit that ends the run; removed when a later commit starts
   * a run. A run started in the same commit, by `afterFailedRun: "continue"` or after a reset, keeps it.
   */
  runFailure?: RunFailure
}

export const LiveDoc = defineDoc<LiveState>({
  kind: "pi.live",
  version: 3,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  // Version 1 named a compaction's trigger `reason`; versions 1 and 2 may lack `run.turns`.
  migrate: (value) => {
    const { run, compactions, compactionFailure } = value as {
      run?: JsonObject
      compactions?: JsonObject[]
      compactionFailure?: JsonObject
    }
    return {
      ...value,
      ...(run === undefined ? {} : { run: { ...run, turns: typeof run.turns === "number" ? run.turns : 0 } }),
      ...(compactions === undefined ? {} : { compactions: compactions.map(renameReason) }),
      ...(compactionFailure === undefined ? {} : { compactionFailure: renameReason(compactionFailure) }),
    } as LiveState
  },
  // A complete base whenever nothing runs (spec 8.2): no generation and no running tool slot. That holds while idle, in
  // the commit handing a generation over to its tool round, and between tools. A slot holds output only while running.
  // A long generation or tool round also takes a base every LIVE_DELTAS_PER_BASE deltas, so its chain stays bounded.
  checkpointWhen: (value, _ops, info) =>
    info.deltasSinceBase >= LIVE_DELTAS_PER_BASE ||
    (value.generation === undefined &&
      !(value.tools ?? []).some((slot) => slot.status === "running") &&
      !(value.nestedTools ?? []).some((slot) => slot.status === "running")),
})

/**
 * Deltas a running generation or tool round stores before `pi.live` takes another base. Without it a one-hour tool
 * stream retains every delta since the round began: about 36,000 rows and 125 MiB at 40 KB/s of output. A base costs
 * about one output window (50 KiB) and a delta about 3.5 KiB at that rate, so a base every 128 deltas adds about a tenth
 * to what the round writes and bounds what a reopen replays.
 */
export const LIVE_DELTAS_PER_BASE = 128

/** A copy of a version 1 compaction status or failure with `reason` renamed `trigger`, its keys in their order. */
function renameReason(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key === "reason" ? "trigger" : key, field]))
}

/** Built-in task kinds that can own `pi.live.run`. */
export const RUN_TASK_KINDS: ReadonlySet<string> = new Set(["pi.generation"])
const TOOL_TASK_KIND = "pi.tool"
const COMPACTION_TASK_KIND = "pi.compaction"

/**
 * Built-in task kinds that end themselves once cut off `settings.restartLimit` times (`TaskRecord.restarts`); the
 * scheduler faults a task of any other kind instead (spec 5.4).
 */
export const LIMITS_RESTARTS: ReadonlySet<string> = new Set([...RUN_TASK_KINDS, TOOL_TASK_KIND, COMPACTION_TASK_KIND])

/** Whether `task` was cut off `restartLimit` times in a row, so its phase ends it instead of running. */
export const cutOffTooOften = (task: { readonly restarts?: number }, restartLimit: number): boolean =>
  task.restarts !== undefined && task.restarts >= restartLimit

/**
 * Whether a task at the limit may still do the cleanup it does when it ends, such as converting a partial: only at the
 * limit. Past it, that cleanup may be what cut the task off.
 */
export const salvageable = (task: { readonly restarts?: number }, restartLimit: number): boolean =>
  (task.restarts ?? 0) <= restartLimit

/** How often a task was cut off, for a message: "once", or "3 times in a row". */
export function cutOffCount(task: { readonly restarts?: number }): string {
  const restarts = task.restarts ?? 0
  return restarts === 1 ? "once" : `${restarts} times in a row`
}

/** How a run ends: with an answer, or without one, settling its inputs `unanswered` and recording why. */
export type RunEnd =
  | { readonly status: "done"; readonly answer: EntryId }
  | {
      readonly status: "unanswered"
      readonly reason: RunFailureReason
      readonly detail?: string
      /** The inputs' settlement; default `unanswered` with `reason` and `detail`. */
      readonly settlement?: SubmissionSettlement
    }

/** A run as it ends, handed to the host's `runEnded` in the commit that ends it. */
export type EndedRun = {
  readonly conversationId: ConversationId
  readonly taskId: TaskId
  readonly end: RunEnd
  /** The run answered before it ended: always with `done`, and for a run cut while it ran its `afterRun` tasks. */
  readonly answered: boolean
}

/**
 * Runs in the commit that ends a run, after its inputs are settled, so what it writes is stored with the run's end. The
 * commit has written already, so it reads no table. A failure fails that commit.
 */
export type RunEndedHook = (tx: Tx, run: EndedRun) => Effect.Effect<void, StorageError>

/** Where a run ends: its conversation, and the host's hook. */
export type RunOwner = { readonly conversationId: ConversationId; readonly runEnded: RunEndedHook | undefined }

/**
 * Ends the run owned by `taskId`: settles each of its inputs, removes `run`, and, without an answer, records
 * `runFailure`. A run that answered already, and runs only its `afterRun` tasks, records no failure, however it ends.
 * Always removes `generation`, `tools` and `nestedTools`, whose presentation belongs to the ending run.
 */
export const endRun = (
  tx: Tx,
  live: Draft<LiveState>,
  taskId: TaskId,
  end: RunEnd,
  /** The run's conversation and the host's hook; `undefined` for a host without one. */
  owner: RunOwner | undefined,
): Effect.Effect<void, StorageError> =>
  Effect.gen(function* () {
    const run = live.run
    if (run?.taskId === taskId) {
      const answered = end.status === "done" || run.afterRun !== undefined
      const inputs = [...run.inputs]
      const { first } = run
      if (end.status === "done") {
        for (const id of inputs) yield* tx.settleSubmission(id, { status: "done", answer: end.answer })
      } else if (run.afterRun === undefined) {
        const { reason, detail } = end
        const settlement = end.settlement ?? {
          status: "unanswered",
          reason,
          ...(detail === undefined ? {} : { detail }),
        }
        for (const id of inputs) yield* tx.settleSubmission(id, settlement)
        live.runFailure = {
          taskId,
          inputs,
          reason,
          ...(detail === undefined ? {} : { detail }),
          ...(first === undefined ? {} : { first }),
        }
      }
      delete live.run
      if (owner?.runEnded !== undefined)
        yield* owner.runEnded(tx, { conversationId: owner.conversationId, taskId, end, answered })
    }
    delete live.generation
    delete live.tools
    delete live.nestedTools
  })

/** Adds the status of a compaction task created in this commit; statuses stay in task ID order. */
export function addCompactionStatus(live: Draft<LiveState>, status: CompactionStatus): void {
  live.compactions ??= []
  live.compactions.push(status)
}

/** The status of compaction task `taskId`, if listed. */
export function compactionStatus(live: Draft<LiveState>, taskId: TaskId): Draft<CompactionStatus> | undefined {
  return live.compactions?.find((status) => status.taskId === taskId)
}

/** Removes the status of compaction task `taskId`, and the list once empty. */
export function removeCompactionStatus(live: Draft<LiveState>, taskId: TaskId): void {
  const statuses = live.compactions
  if (statuses === undefined) return
  const index = statuses.findIndex((status) => status.taskId === taskId)
  if (index >= 0) statuses.splice(index, 1)
  if (statuses.length === 0) delete live.compactions
}

/** Removes the status of compaction task `taskId` and records that it failed with `error`. */
export function failCompactionStatus(live: Draft<LiveState>, taskId: TaskId, error: string): void {
  const status = compactionStatus(live, taskId)
  if (status !== undefined) live.compactionFailure = { taskId: status.taskId, trigger: status.trigger, error }
  removeCompactionStatus(live, taskId)
}

/**
 * The slot of tool task `taskId`, model-issued or nested, if `pi.live` still lists it. Nested slots are found by binary
 * search: their task IDs ascend, since each is appended in the commit that creates its task and removal keeps order.
 */
export function toolSlot(live: Draft<LiveState>, taskId: TaskId): Draft<ToolSlot | NestedToolSlot> | undefined {
  const slot = live.tools?.find((each) => each.taskId === taskId)
  if (slot !== undefined || live.nestedTools === undefined) return slot
  const nested = live.nestedTools
  let low = 0
  let high = nested.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const candidate = nested[middle]!
    if (candidate.taskId === taskId) return candidate
    if (candidate.taskId < taskId) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

/** Marks a slot done and clears its running output; the caller sets a result `entry` or a nested call's `summary`. */
export function finishSlot(slot: Draft<ToolSlot | NestedToolSlot>): void {
  slot.status = "done"
  clearProgress(slot)
}

/** Removes the nested slots below tool task `taskId`, transitively; the list holds parents before their children. */
export function removeNestedSlots(live: Draft<LiveState>, taskId: TaskId): void {
  const nested = live.nestedTools
  if (nested === undefined) return
  const removed = new Set<TaskId>([taskId])
  for (const slot of nested) if (removed.has(slot.parentTaskId)) removed.add(slot.taskId)
  for (let index = nested.length - 1; index >= 0; index--) {
    if (removed.has(nested[index]!.parentTaskId)) nested.splice(index, 1)
  }
  if (nested.length === 0) delete live.nestedTools
}

/** Removes what a tool published while running; its result entry or a rerun replaces it. */
export function clearProgress(slot: Draft<SlotProgress>): void {
  delete slot.output
  delete slot.droppedBytes
  delete slot.droppedLines
  delete slot.details
  delete slot.diagnostics
}

/**
 * Appends a provider result and adds its usage to `pi.usage` in the same commit. Every built-in writer of assistant
 * entries goes through here, so the usage ledger stays complete.
 */
export const appendAssistant = (
  tx: Tx,
  conversationId: ConversationId,
  message: AssistantMessage,
): Effect.Effect<TypedEntry<never>, StorageError | DocError> =>
  Effect.andThen(
    recordUsage(tx, conversationId, "models", `${message.provider}/${message.model}`, message.usage),
    tx.appendEntry(AssistantEntry, conversationId, { model: [stored(message)] }),
  )

/**
 * Appends a committed partial left by an interrupted, aborted, faulted or orphaned attempt as an aborted assistant
 * entry; the caller replaces or removes `generation`.
 */
export const convertPartial = (
  tx: Tx,
  live: Draft<LiveState>,
  conversationId: ConversationId,
): Effect.Effect<void, StorageError | DocError> => {
  const partial = live.generation?.message
  if (partial === undefined) return Effect.void
  const message = copyJson(partial) as unknown as AssistantMessage
  return Effect.asVoid(appendAssistant(tx, conversationId, { ...message, stopReason: "aborted" }))
}

/**
 * Harness cleanup for a terminal outcome the scheduler writes itself (`faulted` or `orphaned`), staged in the commit
 * that makes it terminal (spec 5.4). A run task ends its run, keeping a committed partial as an aborted entry; a tool
 * task's slot is marked done without an entry, and context derivation synthesizes the missing result; a compaction
 * task's status is removed and its failure recorded. Other kinds are left alone, so no `pi.live` is created elsewhere.
 */
export const settleSchedulerOutcome = (
  tx: Tx,
  record: TaskRecord,
  outcome: SchedulerOutcome,
  runEnded?: RunEndedHook,
): Effect.Effect<void, StorageError | DocError> =>
  Effect.gen(function* () {
    if (record.kind === TOOL_TASK_KIND) {
      yield* removeApproval(tx, record.conversationId, record.id)
      const live = yield* tx.doc(LiveDoc, record.conversationId)
      const slot = toolSlot(live, record.id)
      if (slot !== undefined) finishSlot(slot)
      removeNestedSlots(live, record.id)
      return
    }
    // Only an abort handler is faulted for the limit here (the built-in phases end themselves): the task was aborted,
    // and keeps that meaning. Its run ends `aborted`, with the limit as detail, and an aborted compaction is no failure.
    const detail = outcome.status === "faulted" ? outcome.error.detail : undefined
    const cutOff =
      typeof detail === "object" && detail !== null && "reason" in detail && detail.reason === "restart_limit"
    if (record.kind === COMPACTION_TASK_KIND) {
      const live = yield* tx.doc(LiveDoc, record.conversationId)
      if (cutOff) removeCompactionStatus(live, record.id)
      else failCompactionStatus(live, record.id, outcome.status === "faulted" ? outcome.error.message : outcome.reason)
      return
    }
    if (!RUN_TASK_KINDS.has(record.kind)) return
    const live = yield* tx.doc(LiveDoc, record.conversationId)
    if (live.run?.taskId !== record.id) return
    // Cut off, the abort handler may have died converting the partial: the run ends without it.
    if (!cutOff) yield* convertPartial(tx, live, record.conversationId)
    yield* endRun(
      tx,
      live,
      record.id,
      outcome.status === "faulted"
        ? { status: "unanswered", reason: cutOff ? "aborted" : "faulted", detail: outcome.error.message }
        : {
            status: "unanswered",
            reason: "orphaned",
            detail: outcome.reason,
            settlement: { status: "unanswered", reason: outcome.reason },
          },
      { conversationId: record.conversationId, runEnded },
    )
  })
