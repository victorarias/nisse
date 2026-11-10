// The built-in generation task (spec 8.3): prepares the positional system prompt and tool loadout, requests or polls the
// model, retries with a durable backoff, classifies the response, and runs the tool round and the run's end. The run's
// inputs live in `pi.live.run`. Partial responses are committed into `pi.live` on a throttle, as ordinary commits
// (D5). From pi-durable's `src/harness/generation.ts` at 7d073328e (MIT, see LICENSE).
import { copyJson } from "@nisse/delta/json"
import type { Draft } from "@nisse/delta"
import {
  defineTask,
  endedByCrashes,
  type ConversationId,
  type EntryId,
  type JsonObject,
  type JsonValue,
  type NextTaskState,
  type RunningTask,
  type SubmissionId,
  type Task,
  type TaskId,
  type TaskOutcome,
  type TaskRuntime,
  type Tx,
} from "@nisse/kernel"
import {
  getCurrentTools,
  isContextOverflow,
  isRetryableAssistantError,
  retryDelayMs,
  type Api,
  type AssistantMessage,
  type DeferredHandle,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type RequestOptions,
  type ToolCall,
} from "@nisse/models"
import { Cause, Effect, Exit, Fiber, Queue, Stream } from "effect"
import { addTools, agentHooks, sectionExtension } from "./agent.ts"
import { compactionPolicy, createCompaction, estimateContext, selectCut } from "./compaction.ts"
import { AssistantEntry, ResetEntry, SystemEntry, UserEntry } from "./entries.ts"
import { ProviderDoc } from "./documents.ts"
import { applyBoundary, type Boundary, hasQueuedReset, prepareBoundary, withdrawQueuedInputs } from "./inbox.ts"
import {
  appendAssistant,
  convertPartial,
  cutOffCount,
  cutOffTooOften,
  endRun,
  LiveDoc,
  type LiveState,
  type RunEnd,
  salvageable,
  type Stored,
  type ToolSlot,
} from "./live.ts"
import { PartialChanges, type PartialMessage } from "./partial-changes.ts"
import { planSystemEntries, renderSections, replaySections } from "./prompt.ts"
import { type TaskApi, TaskServices } from "./services.ts"
import { appendToolResult, harnessError, ToolTask, type ToolTaskResult } from "./tool.ts"
import type {
  AfterFailedRun,
  CompactionPolicy,
  CompactionResult,
  ContextView,
  GenerationHooks,
  ModelRef,
  PromptInput,
  RunEndTask,
  RunSummary,
  ToolControl,
  UserInput,
} from "./types.ts"

export type GenerationInput = Record<string, never>

export type GenerationCheckpoint =
  | {
      phase: "prepare"
      attempt: number
      /** The blocking compaction this generation waited for; it starts no other compaction (spec 8.3). */
      compacted?: TaskId<CompactionResult>
      /** Error text of the overflow that started `compacted`; checked once when `prepare` resumes. */
      overflow?: string
      /** Set when the blocking threshold started `compacted`; its outcome is checked once when `prepare` resumes. */
      threshold?: true
    }
  | {
      phase: "request"
      attempt: number
      compacted?: TaskId<CompactionResult>
      model: ModelRef
      thinkingLevel: ModelThinkingLevel
      /** The settings' request options when preparation committed; a resend after recovery uses them unchanged. */
      streamOptions: Record<string, JsonValue>
      /** Newest entry included in the request. */
      cutoff: EntryId
    }
  | {
      phase: "retry"
      attempt: number
      compacted?: TaskId<CompactionResult>
      until: number
      /**
       * The deferred response a poll was fetching when the host died: the next attempt polls it again instead of
       * sending another request, so the provider's job is neither lost nor paid twice. Absent otherwise.
       */
      poll?: { model: ModelRef; thinkingLevel?: ModelThinkingLevel; cutoff: EntryId; handle: Stored<DeferredHandle> }
    }
  | {
      phase: "poll"
      attempt: number
      compacted?: TaskId<CompactionResult>
      model: ModelRef
      thinkingLevel?: ModelThinkingLevel
      cutoff: EntryId
      handle: Stored<DeferredHandle>
      pollAt: number
    }
  | {
      /** Waiting on the round's tool tasks, which the generation owns (spec 8.5). */
      phase: "tools"
      /** The tool-calling answer. */
      assistant: EntryId
      /** Tool tasks created so far, in call order; grows by one per started call of a sequential round. */
      tools: TaskId<ToolTaskResult>[]
      /** Calls of a sequential round not started yet, in call order. */
      pending: string[]
    }
  | {
      /**
       * The run answered: its answer is committed and its inputs settled, and it keeps `pi.live.run` while `afterRun`
       * hooks are asked for tasks (spec 8.3). A crash here asks them again: nothing was created yet.
       */
      phase: "finish"
      run: RunSummary
    }
  | {
      /** Waiting on the tasks `afterRun` hooks asked for, which the generation owns; then the run ends. */
      phase: "drain"
      answer: EntryId
      tasks: TaskId[]
    }

export type GenerationResult = { entryId: EntryId }

type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult>
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>
type Phase<P extends GenerationCheckpoint["phase"]> = RunningTask<
  GenerationInput,
  Extract<GenerationCheckpoint, { phase: P }>,
  GenerationResult
>
type AnyPhase = RunningTask<GenerationInput, GenerationCheckpoint, GenerationResult>

/** What a phase works with: the kernel's runtime and the harness's services. */
type Ctx = { readonly runtime: Runtime; readonly api: TaskApi }

/** What classification needs from the request that produced a message. */
type Request = {
  readonly attempt: number
  readonly compacted: TaskId<CompactionResult> | undefined
  readonly model: ModelRef
  readonly thinkingLevel: ModelThinkingLevel | undefined
  readonly cutoff: EntryId
  /** Committed model context through `cutoff`, when the phase already derived it. */
  readonly messages?: readonly Message[]
  /** Set when the message came from polling, so a still deferred result polls strictly later. */
  readonly pollAt?: number
}

const DEFAULT_POLL_AFTER_MS = 5000

/** A phase handler with the harness's services. */
const phase =
  <P extends GenerationCheckpoint["phase"]>(body: (task: Phase<P>, ctx: Ctx) => Effect.Effect<void, unknown>) =>
  (task: Phase<P>, runtime: Runtime): Effect.Effect<void, unknown, TaskServices> =>
    Effect.gen(function* () {
      const api = yield* TaskServices
      return yield* body(task, { runtime, api })
    })

/** The generation's hooks of `name`, each called with `invoke`. */
const eachHook = <K extends keyof GenerationHooks>(
  ctx: Ctx,
  name: K,
  invoke: (hook: GenerationHooks[K]) => Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> => ctx.api.hooks.each(name, invoke)

/** Built-in generation task; see the file's header. */
export const GenerationTask: Task<GenerationInput, GenerationCheckpoint, GenerationResult, TaskServices> = defineTask<
  GenerationInput,
  GenerationCheckpoint,
  GenerationResult,
  TaskServices
>({
  name: "pi.generation",
  version: 2,
  initial: () => ({ phase: "prepare", attempt: 1 }),
  // Version 2 leaves calls to tools not offered in a sequential round's `pending`, flagged `unoffered` in their slots.
  // A version 1 checkpoint has no such calls and is kept as it is.
  migrate: (input, checkpoint) => ({
    input: input as GenerationInput,
    checkpoint: checkpoint as GenerationCheckpoint,
  }),
  phases: {
    /**
     * Render the system prompt and tool loadout and append the positional `pi.system` entries they need, then move to
     * `request`. The agent and settings resolved here are fixed for this request. Only the Harness writes model context
     * to a busy conversation, so the context read here is still current at the commit; display-only entries may land
     * meanwhile.
     */
    prepare: phase<"prepare">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task)
        const { conversationId } = runtime
        const agent = yield* api.agent
        const settings = api.settings()
        const { model, thinkingLevel } = agent
        const resolved = model === undefined ? undefined : api.models().getModel(model.provider, model.modelId)
        if (model === undefined || resolved === undefined) return yield* failNoModel(ctx, model)
        const { attempt, compacted, overflow, threshold: blocked } = task.state.checkpoint
        if (compacted !== undefined && overflow !== undefined) {
          const [outcome] = yield* runtime.outcomes([compacted])
          if (outcome?.status !== "completed" || outcome.result.entryId === undefined) {
            return yield* failModelError(ctx, overflow)
          }
        }
        // A threshold compaction that found nothing to compact or was declined leaves a request that may still fit. One
        // that failed left a context it judged too large: sending it would at best leave no room for the answer.
        if (compacted !== undefined && blocked === true) {
          const [outcome] = yield* runtime.outcomes([compacted])
          if (outcome !== undefined && outcome.status !== "completed") {
            return yield* failModelError(ctx, compactionFailure(outcome))
          }
        }
        const view = yield* api.context(conversationId)
        // The model owes an answer only to a context ending in a user message or tool results; system messages say
        // nothing it answers. Otherwise, as for a continue after an answer or in an empty conversation, end the run
        // before any request.
        const last = view.messages.findLast((message) => message.role !== "system")
        if (last?.role !== "user" && last?.role !== "toolResult") return yield* failNothingToAnswer(ctx)
        const shown = replaySections(view.messages)
        const built = yield* Effect.exit(api.env)
        if (Exit.isFailure(built)) {
          if (runtime.signal.aborted || Cause.hasInterruptsOnly(built.cause))
            return yield* Effect.failCause(built.cause)
          api.report(Cause.squash(built.cause), { kind: "host", callback: "env" })
        }
        const env = Exit.isSuccess(built) ? built.value : undefined
        const input: PromptInput = {
          conversationId,
          agent,
          env,
          shown: Object.fromEntries(shown),
          read: { snapshot: (token, ...address) => runtime.snapshot(token, ...address) },
        }
        const desired = yield* renderSections(agent.sections, input, shown, (error, section) => {
          const extension = sectionExtension(agent, section.key)
          api.report(error, { kind: "extension", ...(extension === undefined ? {} : { extension }) })
        })
        const entries = planSystemEntries(view, desired, agent.tools, runtime.now())
        const threshold =
          compacted === undefined
            ? thresholdCompaction(
                view,
                entries,
                resolved.contextWindow,
                compactionPolicy(settings, model, agent.compaction),
              )
            : undefined
        if (threshold === "blocking") {
          // Compact first and prepare again; the transcript is unchanged until the compaction appends.
          return yield* runtime.commit((tx) =>
            Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
              const child = yield* createCompaction(tx, conversationId, { reason: "threshold" }, runtime.taskId)
              const checkpoint = { phase: "prepare", attempt, compacted: child, threshold: true } as const
              return { status: "waiting", checkpoint, on: [child], policy: "allSettled" }
            }),
          )
        }
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
            // The context ends in a message the model answers, so the conversation has an entry.
            let cutoff = (yield* tx.latestEntryId(conversationId))!
            for (const entry of entries) cutoff = (yield* tx.appendEntry(SystemEntry, conversationId, entry)).id
            // Checked in this commit, so a compaction admitted during preparation counts.
            if (threshold === "background" && (yield* tx.doc(LiveDoc, conversationId)).compactions === undefined) {
              yield* createCompaction(tx, conversationId, { reason: "threshold" })
            }
            const streamOptions = copyJson(settings.stream, { omitUndefinedProperties: true }) as Record<
              string,
              JsonValue
            >
            const request = {
              attempt,
              ...(compacted === undefined ? {} : { compacted }),
              model: { provider: model.provider, modelId: model.modelId },
              thinkingLevel,
              streamOptions,
              cutoff,
            }
            return { status: "running", checkpoint: { phase: "request", ...request } }
          }),
        )
      }),
    ),
    request: phase<"request">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        // Charging the attempt may itself be what keeps failing, such as converting a huge partial: the limit ends it.
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task)
        // The host stopped while this request was in flight: a failed attempt, not a resend (spec 8.3).
        if (task.restarts !== undefined) return yield* interrupted(ctx, task.state.checkpoint)
        const { attempt, compacted, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint
        const conversationId = runtime.conversationId
        // Converting a partial left by an interrupted attempt appends its aborted entry.
        yield* runtime.commit((tx) =>
          Effect.gen(function* () {
            const live = yield* tx.doc(LiveDoc, conversationId)
            yield* convertPartial(tx, live, conversationId)
            live.generation = { attempt }
            return undefined
          }),
        )
        const model = api.models().getModel(ref.provider, ref.modelId)
        if (model === undefined) return yield* failNoModel(ctx, ref)
        const view = yield* api.context(conversationId, { at: cutoff })
        let messages = view.messages
        yield* eachHook(ctx, "beforeRequest", (hook) =>
          Effect.map(hook({ messages }, api.hookApi), (replaced) => {
            if (replaced !== undefined) messages = replaced.messages
          }),
        )
        const options: RequestOptions = {
          ...streamOptions,
          sessionId: yield* providerSessionId(runtime),
          ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
          onPayload: (payload) => Effect.runPromise(providerPayload(ctx, model, payload)),
        }
        const message = yield* streamResponse(ctx, model, messages, options, attempt)
        const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, messages: view.messages }
        yield* classify(ctx, request, message)
      }),
    ),
    /** After the backoff's sleep; a run before `until` (an early wake, or a record of an earlier version) sleeps again. */
    retry: phase<"retry">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        const { attempt, compacted, until, poll } = task.state.checkpoint
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task)
        if (until > runtime.now()) return yield* runtime.sleepUntil(until, task.state.checkpoint)
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
            const live = yield* tx.doc(LiveDoc, runtime.conversationId)
            const kept = compacted === undefined ? {} : { compacted }
            // A poll the host died during polls its response again, as the next attempt.
            if (poll !== undefined) {
              const pollAt = runtime.now()
              live.generation = { attempt: attempt + 1, deferred: { pollAt } }
              return {
                status: "running",
                checkpoint: { phase: "poll", attempt: attempt + 1, ...kept, ...poll, pollAt },
              }
            }
            live.generation = { attempt: attempt + 1 }
            return { status: "running", checkpoint: { phase: "prepare", attempt: attempt + 1, ...kept } }
          }),
        )
      }),
    ),
    /** After the sleep until `pollAt`; a run before it (an early wake, or a record of an earlier version) sleeps again. */
    poll: phase<"poll">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        const { attempt, compacted, model: ref, thinkingLevel, cutoff, handle, pollAt } = task.state.checkpoint
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task)
        // The host stopped while the poll's fetch was in flight: a failed attempt, as for a request. Checked before the
        // time, which may have moved backwards on a replacement host; a sleeping poll is never cut off.
        if (task.restarts !== undefined) return yield* interrupted(ctx, task.state.checkpoint)
        if (pollAt > runtime.now()) return yield* runtime.sleepUntil(pollAt, task.state.checkpoint)
        const model = api.models().getModel(ref.provider, ref.modelId)
        if (model === undefined) return yield* failNoModel(ctx, ref)
        const message = yield* api.models().fetchDeferred(model, handle as DeferredHandle)
        const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, pollAt }
        yield* classify(ctx, request, message)
      }),
    ),
    tools: phase<"tools">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task)
        const { assistant, tools, pending } = task.state.checkpoint
        const [next, ...rest] = pending
        if (next === undefined) return yield* finishToolRound(ctx, assistant, tools)
        // Sequential round: start the next call and wait for it.
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
            const live = yield* tx.doc(LiveDoc, runtime.conversationId)
            const slot = live.tools?.find((slot) => slot.callId === next && slot.taskId === undefined)
            const taskId = yield* createToolTask(tx, runtime, assistant, next, slot?.unoffered)
            if (slot !== undefined) slot.taskId = taskId
            const checkpoint: GenerationCheckpoint = {
              phase: "tools",
              assistant,
              tools: [...tools, taskId],
              pending: rest,
            }
            return { status: "waiting", checkpoint, on: [taskId], policy: "allSettled" }
          }),
        )
      }),
    ),
    /**
     * Ask the `afterRun` hooks for tasks and create them, as the generation's children, in the commit that moves to
     * `drain`; without any, end the run now.
     */
    finish: phase<"finish">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        const { run } = task.state.checkpoint
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endAnsweredCutOff(ctx, task, run.answer)
        const prepared: PreparedTask[] = []
        yield* eachHook(ctx, "afterRun", (hook) =>
          Effect.flatMap(hook(run, api.hookApi), (asked) =>
            asked === undefined ? Effect.void : prepareRunEndTasks(runtime, asked.tasks, prepared),
          ),
        )
        if (prepared.length === 0) return yield* endAnsweredRun(ctx, run.answer)
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
            const tasks: TaskId[] = []
            for (const { task, input } of prepared) {
              tasks.push(yield* tx.createTask(task, input, { ownership: { kind: "task", taskId: runtime.taskId } }))
            }
            const live = yield* tx.doc(LiveDoc, runtime.conversationId)
            if (live.run?.taskId === runtime.taskId && live.run.afterRun !== undefined) live.run.afterRun.tasks = tasks
            const checkpoint = { phase: "drain", answer: run.answer, tasks } as const
            return { status: "waiting", checkpoint, on: tasks, policy: "allSettled" }
          }),
        )
      }),
    ),
    /** The after-run tasks are terminal, whatever their outcomes: end the run. */
    drain: phase<"drain">((task, ctx) =>
      Effect.gen(function* () {
        const { answer } = task.state.checkpoint
        if (cutOffTooOften(task, ctx.api.settings().restartLimit)) return yield* endAnsweredCutOff(ctx, task, answer)
        return yield* endAnsweredRun(ctx, answer)
      }),
    ),
  },
  abort: (task, runtime) =>
    Effect.gen(function* () {
      const api = yield* TaskServices
      const ctx = { runtime, api }
      const checkpoint = task.state.checkpoint
      const polled = deferredOf(checkpoint)
      if (polled !== undefined) yield* cancelDeferred(ctx, polled)
      const conversationId = runtime.conversationId
      // Runs after the round's tool tasks are terminal; calls never started get `aborted` results (spec 8.5), unoffered
      // ones `tool_unavailable`.
      const unstarted =
        checkpoint.phase === "tools" ? yield* readCalls(runtime, checkpoint.assistant, checkpoint.pending) : []
      yield* runtime.commit((tx) =>
        Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
          const live = yield* tx.doc(LiveDoc, conversationId)
          yield* convertPartial(tx, live, conversationId)
          for (const call of unstarted) {
            // A call its request did not offer could not have run either way.
            const unoffered = live.tools?.find((slot) => slot.callId === call.id)?.unoffered === true
            const result = unoffered
              ? harnessError("tool_unavailable", `Tool ${call.name} is not available`)
              : harnessError("aborted", `Tool ${call.name} was aborted`)
            yield* appendToolResult(tx, conversationId, call, result, { timestamp: runtime.now() })
          }
          // In `finish` and `drain` the run answered already: it ends without a failure, its inputs stay `done`.
          yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" })
          return { status: "terminal", outcome: { status: "aborted" } }
        }),
      )
    }),
})

/** The calls `callIds` of the assistant entry, in the given order. */
const readCalls = (
  runtime: Runtime,
  assistant: EntryId,
  callIds: readonly string[],
): Effect.Effect<ToolCall[], unknown> =>
  Effect.map(runtime.entry(assistant), (entry) => {
    const message = entry !== undefined && AssistantEntry.is(entry) ? entry.model?.[0] : undefined
    const calls =
      message?.role === "assistant"
        ? (message.content as unknown as AssistantMessage["content"]).filter((content) => content.type === "toolCall")
        : []
    return callIds.flatMap((id) => calls.filter((call) => call.id === id).slice(0, 1))
  })

/** A tool task for call `callId`, owned by the generation; `unoffered` for a call to a tool its request did not offer. */
const createToolTask = (tx: Tx, runtime: Runtime, assistant: EntryId, callId: string, unoffered: true | undefined) =>
  tx.createTask(
    ToolTask,
    { kind: "model", assistant, callId, ...(unoffered === undefined ? {} : { unoffered }) },
    { ownership: { kind: "task", taskId: runtime.taskId } },
  )

/**
 * Which threshold compaction preparation starts before its request (spec 8.3): `blocking` above
 * `contextWindow - reserveTokens`, `background` above the background threshold, and only when range selection finds a
 * cut. The caller starts a background one only while no compaction is listed.
 */
function thresholdCompaction(
  view: ContextView,
  planned: readonly { readonly model?: readonly unknown[] }[],
  contextWindow: number,
  policy: CompactionPolicy,
): "blocking" | "background" | undefined {
  if (!policy.enabled || contextWindow <= 0) return undefined
  const tokens = estimateContext(
    view,
    planned.flatMap((entry) => (entry.model ?? []) as Message[]),
  )
  const blocking = contextWindow - policy.reserveTokens
  const background = blocking - policy.backgroundTokens
  const over =
    tokens > blocking ? "blocking" : policy.backgroundTokens > 0 && tokens > background ? "background" : undefined
  if (over === undefined || selectCut(view, policy.keepRecentTokens) === undefined) return undefined
  return over
}

/** Error text for a generation whose blocking compaction ended without completing. */
function compactionFailure(outcome: Exclude<TaskOutcome<CompactionResult>, { status: "completed" }>): string {
  switch (outcome.status) {
    case "failed":
    case "faulted":
      return `Compaction failed: ${outcome.error.message}`
    case "orphaned":
      return `Compaction failed: ${outcome.reason}`
    case "aborted":
      return "Compaction was aborted"
  }
}

/** A failed terminal state with `message` and `reason` as its detail. */
const failed = (message: string, reason: string): Next => ({
  status: "terminal",
  outcome: { status: "failed", error: { message, detail: { reason } } },
})

/** Settle the run's inputs `unanswered` with `model_error` and fail with `text`. */
const failModelError = (ctx: Ctx, text: string) =>
  ctx.runtime.commit((tx) =>
    Effect.gen(function* () {
      const failure = yield* prepareFailure(tx, ctx)
      const live = yield* tx.doc(LiveDoc, ctx.runtime.conversationId)
      yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "model_error", detail: text })
      return failed(text, "model_error")
    }),
  )

/**
 * The host stopped while this attempt's request or poll was in flight (`TaskRecord.restarts`): a failed attempt under
 * `settings.retry` (spec 8.3). The committed partial becomes an aborted entry; the next attempt follows the backoff, a
 * poll's by polling its deferred response again, or, with no retry left, the run ends `interrupted`.
 */
const interrupted = (ctx: Ctx, checkpoint: Extract<GenerationCheckpoint, { phase: "request" | "poll" }>) =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    const { attempt, compacted } = checkpoint
    const policy = api.settings().retry
    const retry = policy.enabled && attempt <= policy.maxRetries
    const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0
    const polled = checkpoint.phase === "poll" ? checkpoint : undefined
    const text =
      polled === undefined
        ? `The host stopped while the model was answering, on attempt ${attempt}`
        : `The host stopped while the deferred answer was fetched, on attempt ${attempt}`
    // A run that ends does not leave the provider's job running.
    if (!retry && polled !== undefined) yield* cancelDeferred(ctx, polled)
    yield* runtime.commit((tx) =>
      Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
        // Read before the first table write; only a failure uses it.
        const failure = retry ? undefined : yield* prepareFailure(tx, ctx)
        const live = yield* tx.doc(LiveDoc, runtime.conversationId)
        yield* convertPartial(tx, live, runtime.conversationId)
        if (failure === undefined) {
          live.generation = { attempt, retry: { at: until, error: text } }
          const poll =
            polled === undefined
              ? {}
              : {
                  poll: {
                    model: polled.model,
                    ...(polled.thinkingLevel === undefined ? {} : { thinkingLevel: polled.thinkingLevel }),
                    cutoff: polled.cutoff,
                    handle: polled.handle,
                  },
                }
          const next = { phase: "retry", attempt, ...(compacted === undefined ? {} : { compacted }), until, ...poll }
          return { status: "sleeping", checkpoint: next as GenerationCheckpoint, until }
        }
        yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "interrupted", detail: text })
        return failed(text, "interrupted")
      }),
    )
  })

/**
 * End a run whose generation was cut off `settings.restartLimit` times in a row (spec 5.4). At the limit it still keeps
 * a committed partial as an aborted entry and cancels a deferred response it polled; past the limit that cleanup may be
 * what cut it off, so it ends without it.
 */
const endCutOff = (ctx: Ctx, task: AnyPhase) =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    const checkpoint = task.state.checkpoint
    const text = `The generation was interrupted ${cutOffCount(task)} in its ${checkpoint.phase} phase`
    const salvage = salvageable(task, api.settings().restartLimit)
    const polled = deferredOf(checkpoint)
    if (salvage && polled !== undefined) yield* cancelDeferred(ctx, polled)
    yield* runtime.commit((tx) =>
      Effect.gen(function* () {
        const failure = yield* prepareFailure(tx, ctx)
        const live = yield* tx.doc(LiveDoc, runtime.conversationId)
        if (salvage) yield* convertPartial(tx, live, runtime.conversationId)
        yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "restart_limit", detail: text })
        return failed(text, "restart_limit")
      }),
    )
  })

/** The deferred response a checkpoint polls, or will poll again after a retry's backoff. */
function deferredOf(
  checkpoint: GenerationCheckpoint,
): { readonly model: ModelRef; readonly handle: Stored<DeferredHandle> } | undefined {
  if (checkpoint.phase === "poll") return checkpoint
  return checkpoint.phase === "retry" ? checkpoint.poll : undefined
}

/** Cancel a deferred response no attempt will poll again; a failure is reported, never raised. */
const cancelDeferred = (
  ctx: Ctx,
  checkpoint: { readonly model: ModelRef; readonly handle: Stored<DeferredHandle> },
): Effect.Effect<void> => {
  const models = ctx.api.models()
  const model = models.getModel(checkpoint.model.provider, checkpoint.model.modelId)
  if (model === undefined) return Effect.void
  return Effect.catchCause(models.cancelDeferred(model, checkpoint.handle as DeferredHandle), (cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.sync(() => ctx.api.report(Cause.squash(cause), { kind: "host", callback: "models" })),
  ) as Effect.Effect<void>
}

/** Settle the run's inputs `unanswered` with `no_model` and fail. */
const failNoModel = (ctx: Ctx, ref: ModelRef | undefined) => {
  const message = ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`
  return ctx.runtime.commit((tx) =>
    Effect.gen(function* () {
      const failure = yield* prepareFailure(tx, ctx)
      const live = yield* tx.doc(LiveDoc, ctx.runtime.conversationId)
      yield* endFailedRun(tx, ctx, live, failure, {
        status: "unanswered",
        reason: "no_model",
        detail: message,
        settlement: { status: "unanswered", reason: "no_model" },
      })
      return failed(message, "no_model")
    }),
  )
}

/** End the run without a request: its context has nothing the model would answer. */
const failNothingToAnswer = (ctx: Ctx) =>
  ctx.runtime.commit((tx) =>
    Effect.gen(function* () {
      const failure = yield* prepareFailure(tx, ctx)
      const live = yield* tx.doc(LiveDoc, ctx.runtime.conversationId)
      yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "nothing_to_answer" })
      return failed("The conversation has nothing to answer", "nothing_to_answer")
    }),
  )

/** What a failed run's end needs from the table, read before the commit's first table write. */
type Failure = { readonly policy: AfterFailedRun; readonly boundary?: Boundary }

const prepareFailure = (tx: Tx, ctx: Ctx) =>
  Effect.gen(function* () {
    const settings = ctx.api.settings()
    const policy = settings.afterFailedRun
    if (policy !== "continue") return { policy } as Failure
    return { policy, boundary: yield* prepareBoundary(tx, ctx.runtime.conversationId, settings) } as Failure
  })

/**
 * End a failed run, settling its inputs with `settlement`, and do with the inputs queued behind it what
 * `settings.afterFailedRun` says (spec 6): keep them, start the next run with them, or withdraw them.
 */
const endFailedRun = (
  tx: Tx,
  ctx: Ctx,
  live: Draft<LiveState>,
  failure: Failure,
  end: Extract<RunEnd, { status: "unanswered" }>,
) =>
  Effect.gen(function* () {
    const { conversationId } = ctx.runtime
    yield* endRun(tx, live, ctx.runtime.taskId, end)
    if (failure.policy === "withdraw") yield* withdrawQueuedInputs(tx, conversationId, "run_failed")
    if (failure.boundary === undefined) return
    const { users, first } = yield* applyBoundary(tx, failure.boundary, "final", ctx.runtime.now())
    if (users.length > 0) yield* startRun(tx, conversationId, live, { inputs: users, first }, { keepFailure: true })
  })

/** The `beforeProviderRequest` replacement chain over one provider request body. */
const providerPayload = (ctx: Ctx, model: Model<Api>, payload: unknown): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    let current = payload
    return Effect.as(
      eachHook(ctx, "beforeProviderRequest", (hook) =>
        Effect.map(hook({ model, payload: current }, ctx.api.hookApi), (replaced) => {
          if (replaced !== undefined) current = replaced.payload
        }),
      ),
      current,
    ).pipe(Effect.map(() => current))
  })

/** The provider-facing session ID of the task's conversation, created on first use. */
const providerSessionId = (runtime: Runtime) =>
  Effect.gen(function* () {
    const existing = yield* runtime.snapshot(ProviderDoc, runtime.conversationId)
    if (existing !== undefined) return existing.sessionId
    let created: string | undefined
    yield* runtime.commit((tx) =>
      Effect.map(tx.doc(ProviderDoc, runtime.conversationId), (doc) => {
        created = doc.sessionId
        return undefined
      }),
    )
    if (created === undefined) {
      return yield* Effect.die(new Error(`Conversation ${runtime.conversationId} has no provider session ID`))
    }
    return created
  })

/**
 * Stream one request and return the terminal message. Partials commit at most every `progress.partialIntervalMs` with
 * one commit in flight; the throttle stops before the terminal message returns, after its commit in flight, so no
 * stale partial lands after the outcome. A commit appends what text and thinking grew by and applies the argument
 * changes since the last one (`PartialChanges`), so its cost follows the new text, not the strings' length.
 */
const streamResponse = (
  ctx: Ctx,
  model: Model<Api>,
  messages: readonly Message[],
  options: RequestOptions,
  attempt: number,
): Effect.Effect<AssistantMessage, unknown> =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    const interval = api.settings().progress.partialIntervalMs
    const changes = new PartialChanges()
    let pending: AssistantMessage | undefined
    const flush = Effect.suspend(() => {
      const partial = pending
      pending = undefined
      if (partial === undefined) return Effect.void
      // Copy now: the provider keeps mutating its partial. The changes since the last commit belong to it.
      const message = copyJson(partial, { omitUndefinedProperties: true }) as PartialMessage
      const taken = changes.take(message)
      return runtime
        .commit((tx) =>
          Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live) => {
            live.generation ??= { attempt }
            changes.commit(live.generation, message, taken)
            return undefined
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              changes.restore(taken)
              // Failures after the invocation ended are expected; the committed state stays consistent.
              if (!runtime.signal.aborted && !Cause.hasInterruptsOnly(cause)) api.report(Cause.squash(cause))
            }),
          ),
        )
    })
    const wake = yield* Queue.sliding<void>(1)
    const throttle = yield* Effect.forkChild(
      Effect.forever(Effect.andThen(Queue.take(wake), Effect.andThen(Effect.sleep(interval), flush))),
    )
    let result: AssistantMessage | undefined
    const run = api
      .models()
      .streamSimple(model, { messages: [...messages] as Message[] }, options)
      .pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "done") result = event.message
            else if (event.type === "error") result = event.error
            // A partial without content, such as the opening `start` event, shows nothing; a deferred response never
            // gets past it, so it never leaves a partial.
            else if (event.partial.content.length > 0) {
              changes.observe(event)
              pending = event.partial
              Queue.offerUnsafe(wake, undefined)
            }
          }),
        ),
      )
    // Stops the throttle after a flush in flight, whatever ended the stream.
    yield* Effect.ensuring(run, Fiber.interrupt(throttle))
    if (result === undefined) return yield* Effect.die(new Error("The model's stream ended without a final message"))
    return result
  })

/** Classify a terminal provider message in one commit that also clears the partial. */
const classify = (ctx: Ctx, request: Request, message: AssistantMessage) =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    // The invocation ended: the abort invocation or the reopened run handles the committed state.
    if (runtime.signal.aborted) return yield* Effect.interrupt
    const conversationId = runtime.conversationId
    const { attempt, compacted, model: ref, thinkingLevel, cutoff } = request
    // Record the requested level, as pi-agent-core's agent loop does.
    if (thinkingLevel !== undefined) message.thinkingLevel = thinkingLevel
    if (message.stopReason === "deferred" && message.deferred !== undefined) {
      const handle = message.deferred
      const pollAt = Math.max(
        runtime.now() + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
        request.pollAt === undefined ? Number.NEGATIVE_INFINITY : request.pollAt + 1,
      )
      return yield* runtime.commit((tx) =>
        Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
          ;(yield* tx.doc(LiveDoc, conversationId)).generation = { attempt, deferred: { pollAt } }
          const checkpoint = {
            phase: "poll",
            attempt,
            ...(compacted === undefined ? {} : { compacted }),
            model: ref,
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
            cutoff,
            handle: copyJson(handle, { omitUndefinedProperties: true }) as Stored<DeferredHandle>,
            pollAt,
          } as const
          return { status: "sleeping", checkpoint, until: pollAt }
        }),
      )
    }
    yield* eachHook(ctx, "afterResponse", (hook) => hook(message, api.hookApi))
    const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall")
    if (message.stopReason === "toolUse" && calls.length > 0) {
      return yield* startToolRound(ctx, request, message, calls)
    }
    if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
      return yield* answer(ctx, message)
    }
    // The retry and compaction policies govern the next attempt, so they are read now rather than pinned at preparation.
    const settings = api.settings()
    const overflow = message.stopReason === "error" && isContextOverflow(message)
    const compaction =
      overflow && compacted === undefined ? compactionPolicy(settings, ref, (yield* api.agent).compaction) : undefined
    if (compaction?.enabled === true) {
      const view = yield* api.context(conversationId, { at: cutoff })
      if (selectCut(view, compaction.keepRecentTokens) !== undefined) {
        const text = message.errorMessage ?? "Context overflow"
        return yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
            const live = yield* tx.doc(LiveDoc, conversationId)
            yield* appendAssistant(tx, conversationId, message)
            delete live.generation
            const child = yield* createCompaction(tx, conversationId, { reason: "overflow" }, runtime.taskId)
            const checkpoint = { phase: "prepare", attempt, compacted: child, overflow: text } as const
            return { status: "waiting", checkpoint, on: [child], policy: "allSettled" }
          }),
        )
      }
    }
    const policy = settings.retry
    // An overflow is never retried: only a compaction can make the next request fit.
    const retry =
      message.stopReason === "error" &&
      !overflow &&
      isRetryableAssistantError(message) &&
      policy.enabled &&
      attempt <= policy.maxRetries
    const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0
    yield* runtime.commit((tx) =>
      Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
        // Read before the first table write; only a failure uses it.
        const failure = retry ? undefined : yield* prepareFailure(tx, ctx)
        const live = yield* tx.doc(LiveDoc, conversationId)
        yield* appendAssistant(tx, conversationId, message)
        if (failure === undefined) {
          live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } }
          const checkpoint = {
            phase: "retry",
            attempt,
            ...(compacted === undefined ? {} : { compacted }),
            until,
          } as const
          return { status: "sleeping", checkpoint, until }
        }
        const text = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`
        yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "model_error", detail: text })
        return failed(text, "model_error")
      }),
    )
  })

/**
 * A final answer; the final boundary places queued items (spec 6). The first `onYield` continuation appends a user
 * message and hands the run to a successor generation, but only when the inbox holds no user item and no reset.
 * Otherwise the run's inputs settle `done`; with `afterRun` hooks selected the run waits for the tasks they ask for, in
 * `finish` and `drain`, before the final boundary; without, selected user items start the next run now.
 */
const answer = (ctx: Ctx, message: AssistantMessage) =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    let continuation: UserInput | undefined
    yield* eachHook(ctx, "onYield", (hook) =>
      continuation !== undefined
        ? Effect.void
        : Effect.map(hook(message, api.hookApi), (yielded) => {
            continuation = yielded?.continue
          }),
    )
    const afterRun = yield* asksAfterRun(ctx)
    const conversationId = runtime.conversationId
    yield* runtime.commit((tx) =>
      Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
        // Queue modes are read on the Session line, when the boundary is decided.
        const boundary = yield* prepareBoundary(tx, conversationId, api.settings())
        const live = yield* tx.doc(LiveDoc, conversationId)
        const entry = yield* appendAssistant(tx, conversationId, message)
        const result: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } }
        const continues = takesContinuation(continuation, boundary) ? continuation : undefined
        if (continues === undefined && afterRun) {
          const held = yield* holdRun(tx, live, runtime, { reason: "answer", answer: entry.id, last: entry.id })
          if (held !== undefined) return held
        }
        const { users, first } = yield* applyBoundary(tx, boundary, "final", runtime.now())
        if (continues !== undefined) {
          const user = { role: "user", content: continues, timestamp: runtime.now() }
          yield* tx.appendEntry(UserEntry, conversationId, {
            model: [copyJson(user, { omitUndefinedProperties: true }) as JsonObject],
          })
          // The continuation starts the run's turn count over: bounding `onYield` loops is the extension's job.
          if (live.run?.taskId === runtime.taskId) live.run.turns = 0
          handOver(live, runtime.taskId, yield* createGeneration(tx, conversationId))
          delete live.generation
          return result
        }
        yield* endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id })
        if (users.length > 0) yield* startRun(tx, conversationId, live, { inputs: users, first })
        return result
      }),
    )
  })

/** Whether the phase's agent selects an `afterRun` hook, so a run that answers waits for its tasks (spec 8.3). */
const asksAfterRun = (ctx: Ctx) =>
  Effect.map(ctx.api.agent, (agent) =>
    agentHooks(agent, GenerationTask.definition.name).some(
      ({ handlers }) => typeof (handlers as Partial<GenerationHooks>).afterRun === "function",
    ),
  )

/**
 * Commit A of a run that answered with `afterRun` hooks selected (spec 8.3): settle the run's inputs `done` with the
 * answer and keep `pi.live.run` for the after-run tasks, then ask the hooks in `finish`. The final boundary waits for the
 * run's end, so queued items stay queued.
 */
const holdRun = (
  tx: Tx,
  live: Draft<LiveState>,
  runtime: Runtime,
  end: Omit<RunSummary, "first">,
): Effect.Effect<Next | undefined, unknown> =>
  Effect.gen(function* () {
    const run = live.run
    if (run?.taskId !== runtime.taskId) return undefined
    for (const id of run.inputs) yield* tx.settleSubmission(id, { status: "done", answer: end.answer })
    run.inputs = []
    run.afterRun = {}
    delete live.generation
    delete live.tools
    delete live.nestedTools
    // A run started before `first` was recorded has its answer as its first entry.
    const summary: RunSummary = { ...end, first: run.first ?? end.answer }
    return { status: "running", checkpoint: { phase: "finish", run: summary } } as Next
  })

/** A task an `afterRun` hook asked for, checked and ready to create. */
type PreparedTask = {
  readonly task: Task<JsonValue, { phase: string }, JsonValue, TaskServices>
  readonly input: JsonValue
}

/**
 * Check the tasks one `afterRun` hook asked for, off the line, and add those that pass to `prepared`, so a broken
 * request is skipped instead of failing the creating commit: its kind must be an installed task that is not built-in,
 * its input JSON, and its definition's `initial()` must return a JSON checkpoint of one of its phases. The task is
 * created from the installed definition, as every task runs under it, with that checkpoint, so `initial()` runs once.
 * Then fails with the rejections, which `hooks.each` reports against the hook's extension.
 */
const prepareRunEndTasks = (
  runtime: Runtime,
  requests: readonly RunEndTask[],
  prepared: PreparedTask[],
): Effect.Effect<void, unknown> =>
  Effect.suspend(() => {
    const rejected: unknown[] = []
    for (const request of requests) {
      try {
        const name = request.task.definition.name
        if (name.startsWith("pi.")) throw new Error(`An afterRun hook cannot start the built-in task ${name}`)
        const installed = runtime.registry.task(name)
        if (installed === undefined) throw new Error(`Task ${name} is not installed`)
        const input = copyJson(request.input, { omitUndefinedProperties: true })
        // The registry erases definitions; an installed one is a task definition of its kind.
        const definition = installed.definition as PreparedTask["task"]["definition"]
        const checkpoint = copyJson(definition.initial(input), { omitUndefinedProperties: true }) as { phase: string }
        if (!Object.hasOwn(definition.phases, checkpoint.phase)) {
          throw new Error(`Task ${name} starts at the unknown phase ${String(checkpoint.phase)}`)
        }
        prepared.push({ task: { definition: { ...definition, initial: () => checkpoint } }, input })
      } catch (error) {
        rejected.push(error)
      }
    }
    if (rejected.length === 1) return Effect.fail(rejected[0])
    if (rejected.length > 1) {
      return Effect.fail(new AggregateError(rejected, `${rejected.length} afterRun task requests were rejected`))
    }
    return Effect.void
  })

/**
 * Commit B of a run that answered (spec 8.3): its after-run tasks are terminal, or there were none. Place what the
 * final boundary selects, end the run, and start the next one for selected user items.
 */
const endAnsweredRun = (ctx: Ctx, answer: EntryId) =>
  ctx.runtime.commit((tx) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
      const { runtime, api } = ctx
      const conversationId = runtime.conversationId
      const boundary = yield* prepareBoundary(tx, conversationId, api.settings())
      const live = yield* tx.doc(LiveDoc, conversationId)
      const { users, first } = yield* applyBoundary(tx, boundary, "final", runtime.now())
      yield* endRun(tx, live, runtime.taskId, { status: "done", answer })
      if (users.length > 0) yield* startRun(tx, conversationId, live, { inputs: users, first })
      return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
    }),
  )

/**
 * End a run that answered once its `finish` or `drain` phase was cut off `settings.restartLimit` times (spec 5.4): the
 * run answered, so it ends `completed`, without a failure and without the tasks it would still have waited for, and is
 * reported `task_interrupted`. Queued items stay queued, as after a failed run.
 */
const endAnsweredCutOff = (ctx: Ctx, task: AnyPhase, answer: EntryId) => {
  const { runtime } = ctx
  const text = `The generation was interrupted ${cutOffCount(task)} in its ${task.state.checkpoint.phase} phase`
  return runtime.commit((tx) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
      const live = yield* tx.doc(LiveDoc, runtime.conversationId)
      yield* endRun(tx, live, runtime.taskId, { status: "done", answer })
      const completed: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
      return endedByCrashes(completed, text)
    }),
  )
}

/**
 * Whether an answer's `onYield` continuation is taken (spec 8.3), decided from the inbox before the final boundary
 * places anything: only when it holds no user item, of which the boundary would select one, and no reset, which would
 * otherwise run first. A continuation starts the turn count over.
 */
function takesContinuation(continuation: UserInput | undefined, boundary: Boundary): continuation is UserInput {
  const items = boundary.inbox.items
  return (
    continuation !== undefined &&
    !items.some((item) => item.mode === "steer" || item.mode === "followUp") &&
    !hasQueuedReset(items as never)
  )
}

/**
 * Append the tool-calling answer and start its tool round in one commit (spec 8.3). Every call gets a tool task owned by
 * the generation, in call order, only the first one now when the round is sequential; a call to a tool the request did
 * not offer is flagged, and its task settles `tool_unavailable`. The generation then waits for them in its `tools`
 * phase, keeping the run.
 */
const startToolRound = (ctx: Ctx, request: Request, message: AssistantMessage, calls: readonly ToolCall[]) =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    const conversationId = runtime.conversationId
    const messages = request.messages ?? (yield* api.context(conversationId, { at: request.cutoff })).messages
    const offered = new Set(getCurrentTools(messages).map((tool) => tool.name))
    // Read as the round starts; a tool is resolved as its tool task resolves it.
    const agentTools = (yield* api.agent).tools
    const sequential =
      api.settings().toolExecution === "sequential" ||
      calls.some(
        (call) =>
          offered.has(call.name) && agentTools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
      )
    yield* runtime.commit((tx) =>
      Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
        const live = yield* tx.doc(LiveDoc, conversationId)
        const entry = yield* appendAssistant(tx, conversationId, message)
        const slots: ToolSlot[] = []
        const tools: TaskId<ToolTaskResult>[] = []
        const pending: string[] = []
        for (const call of calls) {
          const unoffered = offered.has(call.name) ? {} : ({ unoffered: true } as const)
          if (sequential && tools.length > 0) {
            pending.push(call.id)
            slots.push({ callId: call.id, name: call.name, status: "pending", ...unoffered })
            continue
          }
          const taskId = yield* createToolTask(tx, runtime, entry.id, call.id, unoffered.unoffered)
          tools.push(taskId)
          slots.push({ callId: call.id, name: call.name, taskId, status: "pending", ...unoffered })
        }
        delete live.generation
        live.tools = slots
        if (live.run?.taskId === runtime.taskId) {
          // A tool round is one turn of the run (`Agent.maxTurns`).
          live.run.turns += 1
          // A run its boundary started without placing anything, as a continue after an answer, begins here.
          live.run.first ??= entry.id
        }
        const checkpoint = { phase: "tools", assistant: entry.id, tools, pending } as const
        return { status: "waiting", checkpoint, on: tools, policy: "allSettled" }
      }),
    )
  })

/**
 * The round's tools are terminal: apply their controls, append a `handoff`'s reset, and then end the run at the final
 * boundary (`terminate`), end it like a failure at the conversation's turn limit (`turn_limit`), end it at a queued
 * reset, or hand it to the next generation at the `postTools` boundary, in the handoff's new context when there is one
 * (spec 8.5).
 */
const finishToolRound = (ctx: Ctx, assistant: EntryId, tools: readonly TaskId<ToolTaskResult>[]) =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    const conversationId = runtime.conversationId
    const controls = new Map<TaskId, ToolControl | undefined>()
    const outcomes = yield* runtime.outcomes(tools)
    tools.forEach((id, index) => {
      const outcome = outcomes[index]!
      // Version 1 results have no kind; every result a generation's round reads is a model-issued call's.
      controls.set(
        id,
        outcome.status === "completed" && outcome.result.kind !== "nested" ? outcome.result.control : undefined,
      )
    })
    const slots = (yield* runtime.snapshot(LiveDoc, conversationId))?.tools ?? []
    const results = slots.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry]))
    yield* eachHook(ctx, "afterTools", (hook) => hook(assistant, results, api.hookApi))
    // In call order, the slots' order; a slot without a task (faulted or orphaned before it got one) has no control.
    const ordered = slots.map((slot) => (slot.taskId === undefined ? undefined : controls.get(slot.taskId)))
    // Every call of the round must ask to terminate.
    const terminate = slots.length > 0 && ordered.every((control) => control?.terminate === true)
    const added = ordered.flatMap((control) => control?.addTools ?? [])
    // The last handoff in call order wins.
    const handoff = ordered.findLast((control) => control?.handoff !== undefined)?.handoff
    // Read from the phase's agent, as every agent field; a `configure()` during the round applies at its end.
    const maxTurns = (yield* api.agent).maxTurns
    const afterRun = terminate && (yield* asksAfterRun(ctx))
    yield* runtime.commit((tx) =>
      Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
        const boundary = yield* prepareBoundary(tx, conversationId, api.settings())
        if (added.length > 0) yield* addTools(tx, conversationId, added)
        const live = yield* tx.doc(LiveDoc, conversationId)
        const now = runtime.now()
        // The run's last entry so far: the newest result, or the assistant when no result has an entry.
        let last = results.reduce((newest, id) => (id > newest ? id : newest), assistant)
        if (handoff !== undefined) {
          // The handoff's reset precedes every queued item, so queued writes and selected steers land in its context.
          const message = { role: "user", content: handoff, timestamp: now } as const
          const entry = yield* tx.appendEntry(ResetEntry, conversationId, { head: "self", model: [message] })
          boundary.head = entry.id
          last = entry.id
        }
        const turns = live.run?.taskId === runtime.taskId ? live.run.turns : 0
        const held = afterRun
          ? yield* holdRun(tx, live, runtime, { reason: "terminate", answer: assistant, last })
          : undefined
        if (held !== undefined) return held
        if (terminate) {
          const { users, first } = yield* applyBoundary(tx, boundary, "final", now)
          yield* endRun(tx, live, runtime.taskId, { status: "done", answer: assistant })
          if (users.length > 0) yield* startRun(tx, conversationId, live, { inputs: users, first })
        } else if (maxTurns !== undefined && turns >= maxTurns) {
          // The turn limit ends the run like a failure: `afterFailedRun` decides the queued items, and a continue resumes
          // it on the round's results. The table was read for the boundary already, before any write.
          const policy = api.settings().afterFailedRun
          const failure = { policy, ...(policy === "continue" ? { boundary } : {}) }
          yield* endFailedRun(tx, ctx, live, failure, {
            status: "unanswered",
            reason: "turn_limit",
            detail: turns === 1 ? "1 turn" : `${turns} turns`,
          })
        } else {
          const { users, first, reset } = yield* applyBoundary(tx, boundary, "postTools", now)
          if (reset) {
            // The queued reset cut the run's context before an answer.
            yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" })
            if (users.length > 0) {
              yield* startRun(tx, conversationId, live, { inputs: users, first }, { keepFailure: true })
            }
          } else {
            delete live.tools
            delete live.nestedTools
            if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users)
            handOver(live, runtime.taskId, yield* createGeneration(tx, conversationId))
          }
        }
        return { status: "terminal", outcome: { status: "completed", result: { entryId: assistant } } }
      }),
    )
  })

/**
 * Start a run for `inputs`, placed input submissions, whose first entry is `first` (`LiveRun.first`): a new generation
 * takes `pi.live.run`. Removes `runFailure`, unless `keepFailure`: a run started in the commit that ended the failed one
 * keeps its failure.
 */
export const startRun = (
  tx: Tx,
  conversationId: ConversationId,
  live: Draft<LiveState>,
  run: { readonly inputs: SubmissionId[]; readonly first: EntryId | undefined },
  options?: { readonly keepFailure?: boolean },
) =>
  Effect.gen(function* () {
    const { inputs, first } = run
    const taskId = yield* createGeneration(tx, conversationId)
    live.run = { taskId, inputs, turns: 0, ...(first === undefined ? {} : { first }) }
    if (options?.keepFailure !== true) delete live.runFailure
  })

/** A generation owned by its conversation. */
const createGeneration = (tx: Tx, conversationId: ConversationId) =>
  tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId })

/** Hand run control from `from` to `to`; the run's inputs move with it. */
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
  if (live.run?.taskId === from) live.run.taskId = to
}
