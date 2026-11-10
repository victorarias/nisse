// The built-in tool task (spec 8.5): resolves the called tool, validates, runs `beforeTool`, records intent, executes,
// runs `afterTool`, and settles the result. Running output, details and diagnostics are committed into the call's slot
// in `pi.live` on an adaptive pace, as ordinary commits (D5). From pi-durable's `src/harness/tool.ts` at 7d073328e
// (MIT, see LICENSE).
import type { Draft } from "@nisse/delta"
import { overlap } from "@nisse/delta"
import { copyJson } from "@nisse/delta/json"
import type { ExecutionEnv, ShellOutputSkip, ShellOutputWindow } from "@nisse/env"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@nisse/env/truncate"
import {
  defineDocFamily,
  defineTask,
  type ConversationId,
  type EntryId,
  type InvocationEnded,
  type JsonObject,
  type JsonValue,
  type NextTaskState,
  type ReadFailure,
  type RunningTask,
  type SettledTask,
  type Task,
  type TaskId,
  type TaskRecord,
  type TaskRuntime,
  type TaskSnapshot,
  type Tx,
  type TypedEntry,
} from "@nisse/kernel"
import {
  validateToolArguments,
  type ImageContent,
  type JsonRepresentation,
  type Models,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from "@nisse/models"
import { Cause, Effect, Exit } from "effect"
import { AssistantEntry, ToolResultEntry } from "./entries.ts"
import { assignJson } from "./json.ts"
import {
  clearProgress,
  cutOffCount,
  cutOffTooOften,
  finishSlot,
  LiveDoc,
  type NestedToolSlot,
  removeNestedSlots,
  salvageable,
  type ToolSlot,
  toolSlot,
} from "./live.ts"
import {
  boundOutput,
  OutputBuffer,
  type OutputLimits,
  PROGRESS_BYTES_PER_SECOND,
  Progress,
  type ProgressClock,
  utf8ByteLength,
} from "./output.ts"
import { type ConversationHandle, type TaskApi, TaskServices } from "./services.ts"
import type {
  Agent,
  DocumentReader,
  ToolControl,
  ToolDiagnostic,
  ToolExecutionResult,
  ToolHookCall,
  ToolHooks,
  ToolRegistration,
} from "./types.ts"
import { recordUsage } from "./usage.ts"

/**
 * A model-issued call, read from its assistant entry, or a nested call a running tool made through `executeTool()`,
 * whose call the input carries because no entry holds it.
 */
export type ToolTaskInput =
  | {
      kind: "model"
      assistant: EntryId
      callId: string
      /** A call to a tool its request did not offer: settles `tool_unavailable` without resolving the name. */
      unoffered?: true
    }
  | {
      kind: "nested"
      parent: TaskId
      parentCallId: string
      key: string
      call: ToolCall
      /** `false`: commit no running output, details, or diagnostics to the slot; the result still gets them. */
      progress?: false
    }

export type ToolTaskCheckpoint =
  | { phase: "call" }
  /** Durable intent: the final arguments and the replay policy recorded before execution. */
  | { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" }

/**
 * A model-issued call's result is its transcript entry; a nested call's result is in its caller's `NestedCallDoc`, so
 * the receipt stays small and the result retires with the caller. A version 1 result has no `kind`; a result without
 * `kind` is a model-issued call's.
 */
export type ToolTaskResult = { kind: "model"; entryId: EntryId; control?: ToolControl } | { kind: "nested" }

/**
 * Memo of a tool task that made a nested call, in any attempt, committed before the first admission of each attempt:
 * only then can `pi.live` hold slots below it, which settling removes.
 */
const MADE_NESTED_CALLS = "pi.tool.madeNestedCalls"

/** One nested call of a running tool: its task, and once it ended, its result. */
export type NestedCallState = {
  /** Absent only inside the commit that creates the call; a creation that fails leaves no member. */
  taskId?: TaskId<ToolTaskResult>
  /** What `executeTool()` returns; absent while running, and for a call the scheduler faulted or orphaned. */
  result?: JsonObject
}

/**
 * The nested calls of a tool call, a task-scoped family of the calling task keyed by the nested call's key: a rerun
 * finds the calls it already made, and the caller reads each result. Retires with the caller.
 */
export const NestedCallDoc = defineDocFamily<NestedCallState, null>({
  kind: "pi.tool.nested-call",
  version: 1,
  scope: "task",
  family: true,
  initial: () => ({}),
  // The document retires with its task.
  checkpointWhen: () => false,
})

/** What a running tool's `execute` gets besides its arguments. Every operation fails once the invocation ended. */
export interface ToolExecutionApi extends DocumentReader<ReadFailure | InvocationEnded> {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
  readonly callId: string
  /** Aborts when the tool task's invocation ends. */
  readonly signal: AbortSignal
  /** The tool task's phase snapshot. */
  readonly registry: TaskSnapshot<unknown>
  /** The calling conversation's agent, as the tool task's phase resolved it. */
  readonly agent: Effect.Effect<Agent, unknown>
  /** The host's models, read at each call. */
  models(): Models
  /** Built for this call; `undefined` without an environment. */
  readonly env: ExecutionEnv | undefined
  /** The Harness clock, for times a rerun after a restart compares against. */
  now(): number
  /**
   * Appends running output; it becomes the result's `output` when the result omits it. `skipped` counts output omitted
   * before the chunk, as reported by an environment given `outputWindow`.
   */
  output(chunk: string | Uint8Array, skipped?: ShellOutputSkip): void
  /** The tail this call's output keeps and the pace of its progress commits; `undefined` when it keeps the head. */
  readonly outputWindow: ShellOutputWindow | undefined
  /** The output retained so far, as the model sees it when the result omits `output`, and whether some was dropped. */
  retainedOutput(): { readonly text: string; readonly truncated: boolean }
  /** Records a model-visible remark about this call. */
  diagnostic(diagnostic: ToolDiagnostic): void
  /** Replaces running details; succeeds once a commit holds them. The last value is the result's default details. */
  details(value: JsonValue): Effect.Effect<void, unknown>
  /** A commit of this call's task. */
  commit<A, E>(change: (tx: Tx) => Effect.Effect<A, E>): Effect.Effect<A, unknown>
  memo<T extends JsonValue>(name: string): Effect.Effect<T | undefined, InvocationEnded>
  memo<T extends JsonValue>(name: string, candidate: T): Effect.Effect<T, unknown>
  getTask<R>(
    id: TaskId<R>,
  ): Effect.Effect<TaskRecord<JsonValue, JsonValue, R> | undefined, InvocationEnded | ReadFailure>
  waitForTask<R>(id: TaskId<R>): Effect.Effect<SettledTask<R>, InvocationEnded | ReadFailure>
  /** A handle of an existing conversation, bound to this call's invocation. */
  conversation(id: ConversationId): Effect.Effect<ConversationHandle | undefined, InvocationEnded | ReadFailure>
  /** Creates a task owned by this call. */
  createTask(task: Task<unknown, { phase: string }, unknown, unknown>, input: unknown): Effect.Effect<TaskId, unknown>
  /** Runs tool `name` as a nested call of this one and waits for its result. */
  executeTool(name: string, args: JsonObject, options?: { readonly key?: string }): Effect.Effect<unknown, unknown>
}

type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult>
type Next = NextTaskState<ToolTaskCheckpoint, ToolTaskResult>
type Phase<P extends ToolTaskCheckpoint["phase"]> = RunningTask<
  ToolTaskInput,
  Extract<ToolTaskCheckpoint, { phase: P }>,
  ToolTaskResult
>
type Content = (TextContent | ImageContent)[]

/** What a phase works with: the kernel's runtime and the harness's services. */
type Ctx = { readonly runtime: Runtime; readonly api: TaskApi }

const LATER_STEP = "runs once the harness-tools step of the kernel rebuild lands"

/** A phase handler with the harness's services. */
const phase =
  <P extends ToolTaskCheckpoint["phase"]>(body: (task: Phase<P>, ctx: Ctx) => Effect.Effect<void, unknown>) =>
  (task: Phase<P>, runtime: Runtime): Effect.Effect<void, unknown, TaskServices> =>
    Effect.gen(function* () {
      const api = yield* TaskServices
      return yield* body(task, { runtime, api })
    })

/** The tool task's hooks of `name`, each called with `invoke`. */
const eachHook = <K extends keyof ToolHooks>(
  ctx: Ctx,
  name: K,
  invoke: (hook: ToolHooks[K]) => Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> => ctx.api.hooks.each(name, invoke)

/** Whether a failure is the invocation's end rather than the code's own error. */
const ending = (ctx: Ctx, cause: Cause.Cause<unknown>): boolean =>
  ctx.runtime.signal.aborted || Cause.hasInterruptsOnly(cause)

/**
 * Built-in tool task: everything from resolution to settlement runs in the one `call` handler, so nothing separates
 * them. `execute` is reached only by recovery and applies the replay rule. A model-issued call settles by appending
 * its result entry.
 */
export const ToolTask: Task<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, TaskServices> = defineTask<
  ToolTaskInput,
  ToolTaskCheckpoint,
  ToolTaskResult,
  TaskServices
>({
  name: "pi.tool",
  version: 3,
  initial: () => ({ phase: "call" }),
  // Version 1 had only model-issued calls, without `kind`; version 3 added `unoffered`, absent in version 2 inputs.
  migrate: (input, checkpoint, fromVersion) => ({
    input:
      fromVersion === 1
        ? { kind: "model", ...(input as { assistant: EntryId; callId: string }) }
        : (input as ToolTaskInput),
    checkpoint: checkpoint as ToolTaskCheckpoint,
  }),
  phases: {
    call: phase<"call">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        const call = yield* readCall(runtime, task.input)
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task, call)
        const tool = isUnoffered(task.input) ? undefined : yield* resolveTool(ctx, task.input, call.name)
        if (tool === undefined) {
          const error = harnessError("tool_unavailable", `Tool ${call.name} is not available`)
          return yield* reject(ctx, task.input, call, undefined, error)
        }
        const prepared = prepare(tool, call.arguments as JsonObject)
        const checked = "error" in prepared ? prepared : validate(tool, call, prepared.args)
        if ("error" in checked) return yield* reject(ctx, task.input, call, tool, invalid(checked.error))
        let args = checked.args
        let block: string | undefined
        yield* eachHook(ctx, "beforeTool", (hook) =>
          block !== undefined
            ? Effect.void
            : hook({ ...call, arguments: args }, api.hookApi).pipe(
                Effect.map((decision) => {
                  if (decision?.block !== undefined) block = decision.block
                  else if (decision?.arguments !== undefined) args = decision.arguments
                }),
                // A failing hook blocks the call.
                Effect.catchCause((cause) =>
                  ending(ctx, cause)
                    ? Effect.failCause(cause)
                    : Effect.sync(() => {
                        block = errorMessage(Cause.squash(cause))
                      }),
                ),
              ),
        )
        if (block !== undefined) {
          const blocked = harnessError("blocked", `Tool call blocked: ${block}`)
          return yield* reject(ctx, task.input, call, tool, blocked)
        }
        const validated = validate(tool, call, args)
        if ("error" in validated) return yield* reject(ctx, task.input, call, tool, invalid(validated.error))
        // Strict JSON: repair may set optional properties to undefined, which the slot and checkpoint cannot hold.
        const final = copyJson(validated.args, { omitUndefinedProperties: true }) as JsonObject
        // The slot shows the call running; the intent is durable before the tool runs.
        yield* runtime.commit((tx) =>
          Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live) => {
            const slot = toolSlot(live, runtime.taskId)
            if (slot !== undefined) slot.status = "running"
            // A nested slot shows the arguments the call runs with, which repair, hooks and coercion may have changed.
            if (slot !== undefined && "parentTaskId" in slot) slot.arguments = final
            return undefined
          }),
        )
        yield* runtime.commit(() =>
          Effect.succeed<Next>({
            status: "running",
            checkpoint: { phase: "execute", arguments: final, replay: tool.replay ?? "unsafe" },
          }),
        )
        yield* run(ctx, task.input, call, tool, final)
      }),
    ),
    /** Recovery after intent: rerun only when the stored and the current policy both say `safe`. */
    execute: phase<"execute">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        const { arguments: args, replay } = task.state.checkpoint
        const call = yield* readCall(runtime, task.input)
        // Also before an interruption result: its `afterTool` hooks may be what cut the task off.
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task, call)
        const tool = yield* resolveTool(ctx, task.input, call.name)
        if (replay === "safe" && tool?.replay === "safe") {
          // The rerun reports from scratch: clear what the interrupted attempt published, and show the slot running.
          yield* runtime.commit((tx) =>
            Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live) => {
              const slot = toolSlot(live, runtime.taskId)
              if (slot !== undefined) {
                clearProgress(slot)
                slot.status = "running"
                if ("parentTaskId" in slot) slot.arguments = args
              }
              return undefined
            }),
          )
          return yield* run(ctx, task.input, call, tool, args)
        }
        const message = `Tool ${call.name} was interrupted and may have partially run`
        // `failed` records cancellation intent, so the call's owned conversations, left unsupervised, are aborted.
        yield* settleFromSlot(ctx, task.input, call, { tool }, { status: "failed", message }, "interrupted", message)
      }),
    ),
  },
  abort: (task, runtime) =>
    Effect.gen(function* () {
      const api = yield* TaskServices
      const ctx: Ctx = { runtime, api }
      const call = yield* readCall(runtime, task.input)
      // Abandoned after a restart (`abandonOnRestart`): say whether the call may have run. An unoffered call could not
      // run in any case, and its result says so.
      const [code, message] = isUnoffered(task.input)
        ? ["tool_unavailable", `Tool ${call.name} is not available`]
        : task.abortReason !== "restart"
          ? ["aborted", `Tool ${call.name} was aborted`]
          : task.state.checkpoint.phase === "execute"
            ? ["interrupted", `Tool ${call.name} was interrupted by a restart and may have partially run`]
            : ["abandoned", `Tool ${call.name} was not started: its caller ended with a restart`]
      // The scheduler runs an abort handler only while its restarts are below the limit, and faults the task when the
      // last attempt is cut off. That attempt skips the hooks, which may be what cuts it off.
      const hooks =
        (task.restarts ?? 0) < api.settings().restartLimit - 1
          ? { tool: yield* toolForLimits(ctx, task.input, call.name) }
          : undefined
      yield* settleFromSlot(ctx, task.input, call, hooks, { status: "aborted" }, code!, message!)
    }),
})

/**
 * End a call cut off `settings.restartLimit` times in a row (spec 5.4) with an error result, built from the slot like
 * an interrupted call's, instead of running it again. `failed`, like an interruption, so its owned work is aborted.
 */
const endCutOff = (
  ctx: Ctx,
  task: { readonly restarts?: number; readonly input: ToolTaskInput },
  call: ToolHookCall,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const message = `Tool ${call.name} was interrupted ${cutOffCount(task)}; it is not run again`
    const end = { status: "failed", message, reason: "restart_limit" } as const
    // Past the limit the hooks may be what keeps cutting the task off.
    const hooks = salvageable(task, ctx.api.settings().restartLimit)
      ? { tool: yield* toolForLimits(ctx, task.input, call.name) }
      : undefined
    yield* settleFromSlot(ctx, task.input, call, hooks, end, "restart_limit", message)
  })

/**
 * Settle a result the Harness decided in the `call` phase, without running the tool: the tool did not resolve, the
 * arguments are invalid, or `beforeTool` blocked the call. `afterTool` applies as to an executed call's result.
 */
const reject = (
  ctx: Ctx,
  input: ToolTaskInput,
  call: ToolHookCall,
  tool: ToolRegistration | undefined,
  result: ToolExecutionResult,
): Effect.Effect<void, unknown> =>
  Effect.flatMap(afterHarnessResult(ctx, call, tool, result, undefined), (settled) =>
    settle(ctx, input, call, COMPLETED, settled),
  )

/**
 * Settle an error result built from the call's slot (`fromSlot`): an interruption, the restart limit, or an abort. The
 * tool is not running, so the slot read before the commit is still current when it commits. With `hooks`, the result
 * passes `afterTool` and is bounded with the limits of `hooks.tool`; without, it is settled as built.
 */
const settleFromSlot = (
  ctx: Ctx,
  input: ToolTaskInput,
  call: ToolHookCall,
  hooks: { readonly tool: ToolRegistration | undefined } | undefined,
  end: Ending,
  code: string,
  message: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const live = yield* ctx.runtime.snapshot(LiveDoc, ctx.runtime.conversationId)
    const slot = live === undefined ? undefined : toolSlot(live as Draft<typeof live>, ctx.runtime.taskId)
    const { result, truncation } = fromSlot(slot, code, message)
    const settled =
      hooks !== undefined
        ? yield* afterHarnessResult(ctx, call, hooks.tool, result, truncation)
        : truncation === undefined
          ? result
          : { ...result, diagnostics: [...(result.diagnostics ?? []), truncation] }
    yield* settle(ctx, input, call, end, settled)
  })

/**
 * The tool whose output limits bound a hooks' result: the called tool, or none when it, or the agent, fails to
 * resolve, and for an unoffered call, which never resolves its name.
 */
const toolForLimits = (ctx: Ctx, input: ToolTaskInput, name: string): Effect.Effect<ToolRegistration | undefined> =>
  isUnoffered(input)
    ? Effect.succeed(undefined)
    : Effect.catchCause(resolveTool(ctx, input, name), () => Effect.succeed(undefined))

/** A model-issued call to a tool its request did not offer (spec 8.3). */
function isUnoffered(input: ToolTaskInput): boolean {
  return input.kind === "model" && input.unoffered === true
}

/** The called tool: among the tools the model is offered for a model-issued call, else among those tools may call. */
const resolveTool = (
  ctx: Ctx,
  input: ToolTaskInput,
  name: string,
): Effect.Effect<ToolRegistration | undefined, unknown> =>
  Effect.map(ctx.api.agent, (agent) =>
    (input.kind === "model" ? agent.tools : agent.callable).find((tool) => tool.name === name),
  )

/** The tool's output limits, the defaults filled in; all defaults when the tool did not resolve. */
function outputLimits(tool: ToolRegistration | undefined): OutputLimits {
  return {
    maxBytes: tool?.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
    maxLines: tool?.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
    retain: tool?.outputLimits?.retain ?? "head",
  }
}

/** The call: from the input for a nested call, which hooks see with its parent, else from the assistant entry. */
const readCall = (runtime: Runtime, input: ToolTaskInput): Effect.Effect<ToolHookCall, unknown> => {
  if (input.kind === "nested") {
    return Effect.succeed({ ...input.call, parent: { taskId: input.parent, callId: input.parentCallId } })
  }
  return Effect.flatMap(runtime.entry(input.assistant), (entry) => {
    const message = entry !== undefined && AssistantEntry.is(entry) ? entry.model?.[0] : undefined
    const call =
      message?.role === "assistant"
        ? (message.content as unknown as readonly { readonly type: string }[]).find(
            (content): content is ToolCall => content.type === "toolCall" && (content as ToolCall).id === input.callId,
          )
        : undefined
    return call === undefined
      ? Effect.die(new Error(`Entry ${input.assistant} has no tool call ${input.callId}`))
      : Effect.succeed(call)
  })
}

/** Arguments, or why they are invalid. */
type Checked = { readonly args: JsonObject } | { readonly error: string }

/** The call's arguments as repaired by the tool; a throwing repair makes them invalid. */
function prepare(tool: ToolRegistration, args: JsonObject): Checked {
  if (tool.prepareArguments === undefined) return { args }
  try {
    return { args: tool.prepareArguments(args) as JsonObject }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

/** Arguments validated and coerced against the implementation's schema. */
function validate(tool: ToolRegistration, call: ToolCall, args: JsonObject): Checked {
  try {
    return { args: validateToolArguments(tool, { ...call, arguments: args }) as JsonObject }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

function invalid(message: string): ToolExecutionResult {
  return harnessError("invalid_arguments", message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a running tool reported through its api: output, the last details, and diagnostics. */
type Reported = {
  readonly output: OutputBuffer
  readonly limits: OutputLimits
  readonly diagnostics: ToolDiagnostic[]
  details: JsonValue | undefined
}

/** Execute with the resolved implementation, then settle its result. */
const run = (
  ctx: Ctx,
  input: ToolTaskInput,
  call: ToolHookCall,
  tool: ToolRegistration,
  args: JsonObject,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { runtime, api: services } = ctx
    const limits = outputLimits(tool)
    const reported: Reported = { output: new OutputBuffer(limits), limits, diagnostics: [], details: undefined }
    const streams = input.kind === "model" || input.progress !== false
    const progress = publishProgress(ctx, reported, streams)
    let ended = false
    const assertLive = (): void => {
      if (ended) throw new Error(`Tool call ${call.id} has settled`)
    }
    /** Built for this call, below, so a rerun after recovery gets the conversation's environment at that time. */
    let env: ExecutionEnv | undefined
    const api: ToolExecutionApi = {
      taskId: runtime.taskId,
      conversationId: runtime.conversationId,
      callId: call.id,
      signal: runtime.signal,
      registry: runtime.registry,
      agent: services.agent,
      models: () => services.models(),
      get env() {
        return env
      },
      now: () => runtime.now(),
      snapshot: (token, ...address) => runtime.snapshot(token, ...address),
      getTask: (id) => runtime.getTask(id),
      waitForTask: (id) => runtime.waitForTask(id),
      conversation: (id) => services.conversation(id),
      output: (chunk, skipped) => {
        assertLive()
        if (reported.output.push(chunk, skipped)) progress.mark()
      },
      outputWindow:
        limits.retain === "tail"
          ? {
              maxBytes: limits.maxBytes,
              maxLines: limits.maxLines,
              minIntervalMs: services.settings().progress.outputIntervalMs,
              bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
            }
          : undefined,
      retainedOutput: () => {
        assertLive()
        const retained = reported.output.snapshot()
        return { text: retained.text, truncated: retained.droppedBytes > 0 }
      },
      diagnostic: (diagnostic) => {
        assertLive()
        reported.diagnostics.push(copyJson(diagnostic, { omitUndefinedProperties: true }) as ToolDiagnostic)
        progress.mark()
      },
      details: (value) =>
        Effect.suspend(() => {
          assertLive()
          reported.details = copyJson(value, { omitUndefinedProperties: true })
          const committed = progress.markAndWait()
          // Interrupting the wait leaves the update in place; the commit's own outcome stays observed.
          committed.catch(() => {})
          return Effect.tryPromise({ try: () => committed, catch: (error) => error })
        }),
      commit: <A, E>(change: (tx: Tx) => Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          let result: A | undefined
          yield* runtime.commit((tx) =>
            Effect.map(change(tx), (value) => {
              result = value
              return undefined
            }),
          )
          return result as A
        }),
      memo: ((name: string, ...candidate: [JsonValue?]) =>
        candidate.length === 0 ? runtime.memo(name) : runtime.memo(name, candidate[0]!)) as ToolExecutionApi["memo"],
      createTask: () => Effect.die(new Error(`Creating tasks from a tool ${LATER_STEP}`)),
      executeTool: () => Effect.die(new Error(`Nested tool calls ${LATER_STEP}`)),
    }

    let result: ToolExecutionResult
    let end = COMPLETED
    // Execution time of this attempt; a rerun after recovery measures only itself.
    let durationMs: number | undefined
    const executed = yield* Effect.exit(
      Effect.gen(function* () {
        env = yield* services.env
        const startedAt = performance.now()
        return yield* (tool.execute(args, api) as Effect.Effect<ToolExecutionResult, unknown>).pipe(
          Effect.ensuring(Effect.sync(() => (durationMs = Math.round(performance.now() - startedAt)))),
        )
      }),
    )
    if (Exit.isFailure(executed)) {
      if (ending(ctx, executed.cause)) {
        ended = true
        const error = Cause.squash(executed.cause)
        for (const waiter of yield* Effect.promise(() => progress.stop())) waiter.reject(error)
        return yield* Effect.failCause(executed.cause)
      }
      const error = Cause.squash(executed.cause)
      result = { isError: true, diagnostics: [toolDiagnostic("tool_error", errorMessage(error))] }
      // A failure, from `execute()` or from building the environment, ends the task `failed`, which cancels what the
      // call owned; it no longer supervises it. The error text is already in the result.
      end = { status: "failed", message: `Tool ${call.name} threw` }
    } else result = executed.value
    ended = true
    reported.output.end()
    // Details still waiting for a progress commit settle with the terminal commit, the final flush.
    const pending = yield* Effect.promise(() => progress.stop())
    const settled = yield* Effect.exit(
      Effect.flatMap(finalResult(ctx, call, result, reported), (final) =>
        settle(ctx, input, call, end, final, durationMs),
      ),
    )
    if (Exit.isFailure(settled)) {
      const error = Cause.squash(settled.cause)
      for (const waiter of pending) waiter.reject(error)
      return yield* Effect.failCause(settled.cause)
    }
    for (const waiter of pending) waiter.resolve()
  })

/**
 * The Harness clock, with timers on Effect's clock, for progress pacing. After the invocation ends nothing more
 * commits, and the clock answers with the last time it read.
 */
function progressClock(runtime: Runtime): ProgressClock {
  let last = 0
  return {
    now: () => {
      try {
        last = runtime.now()
      } catch {
        // The invocation ended.
      }
      return last
    },
    setTimer: (callback, delayMs) => {
      const fiber = Effect.runFork(Effect.andThen(Effect.sleep(delayMs), Effect.sync(callback)))
      return () => {
        fiber.interruptUnsafe()
      }
    },
  }
}

/**
 * Throttled commits of what the tool reported into its slot, in `pi.live.tools` or `pi.live.nestedTools`, each writing
 * only what changed since the last one; none when `enabled` is false.
 */
function publishProgress(ctx: Ctx, reported: Reported, enabled: boolean): Progress {
  const { runtime, api } = ctx
  let written = { text: "", details: undefined as JsonValue | undefined, diagnostics: 0 }
  return new Progress(
    async () => {
      if (!enabled) return 0
      // Capture everything now: the tool keeps reporting while the commit is in flight.
      const snapshot = reported.output.snapshot()
      const current = { text: snapshot.text, details: reported.details, diagnostics: reported.diagnostics.length }
      const added = reported.diagnostics.slice(written.diagnostics, current.diagnostics)
      const detailsChanged = current.details !== written.details
      // What the commit writes, as the delta diffs the string: an append, a trim plus an append of what follows the
      // shared part, or the whole window when its bounded overlap search finds nothing.
      let bytes = 0
      if (snapshot.text !== written.text) {
        const shared = snapshot.text.startsWith(written.text)
          ? written.text.length
          : overlap(written.text, snapshot.text, 65_536)
        bytes += utf8ByteLength(snapshot.text.slice(shared))
      }
      if (detailsChanged) bytes += utf8ByteLength(JSON.stringify(current.details ?? null))
      if (added.length > 0) bytes += utf8ByteLength(JSON.stringify(added))
      await Effect.runPromise(
        runtime.commit((tx) =>
          Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live) => {
            const slot = toolSlot(live, runtime.taskId)
            if (slot === undefined) return undefined
            // Assign `output` as one string field: the delta then records an append, or a trim plus an append for a
            // sliding tail; replacing the slot object would record the whole window on every commit.
            if ((slot.output ?? "") !== snapshot.text) slot.output = snapshot.text
            if (snapshot.droppedBytes > 0) slot.droppedBytes = snapshot.droppedBytes
            if (snapshot.droppedLines > 0) slot.droppedLines = snapshot.droppedLines
            // Diff details leaf by leaf and append new diagnostics, so each commit writes only what changed.
            if (detailsChanged && current.details !== undefined) assignJson(slot, "details", current.details)
            if (added.length > 0) {
              if (slot.diagnostics === undefined) slot.diagnostics = []
              for (const diagnostic of added) slot.diagnostics.push(diagnostic)
            }
            return undefined
          }),
        ),
      )
      written = current
      return bytes
    },
    (error) => {
      // Failures after the invocation ended are expected; the committed state stays consistent.
      if (!runtime.signal.aborted) api.report(error)
    },
    api.settings().progress.outputIntervalMs,
    progressClock(runtime),
  )
}

/**
 * The settled result: the tool's result with the retained output and last details as fallbacks, its diagnostics after
 * those reported through the api, `afterTool` applied and explicit text bounded, with the Harness's diagnostics last.
 */
const finalResult = (
  ctx: Ctx,
  call: ToolHookCall,
  result: ToolExecutionResult,
  reported: Reported,
): Effect.Effect<ToolExecutionResult, unknown> =>
  Effect.gen(function* () {
    const harness: ToolDiagnostic[] = []
    const retained = result.output === undefined ? reported.output.snapshot() : undefined
    const output: Content =
      retained === undefined ? result.output! : retained.text === "" ? [] : [{ type: "text", text: retained.text }]
    const details = result.details === undefined ? reported.details : result.details
    let final: ToolExecutionResult = {
      ...result,
      output,
      ...(details === undefined ? {} : { details }),
      diagnostics: [...reported.diagnostics, ...(result.diagnostics ?? [])],
    }
    yield* eachHook(ctx, "afterTool", (hook) =>
      Effect.map(hook(call, final, ctx.api.hookApi), (replaced) => {
        final = replaced ?? final
      }),
    )
    // The retained output's truncation applies only while afterTool kept that output.
    if (retained !== undefined && retained.droppedBytes > 0 && final.output === output) {
      harness.push(truncated(retained, reported.limits.retain))
    }
    const bounded = boundContent(final.output ?? [], reported.limits)
    if (bounded.droppedBytes > 0) harness.push(truncated(bounded, reported.limits.retain))
    return { ...final, output: bounded.content, diagnostics: [...(final.diagnostics ?? []), ...harness] }
  })

/**
 * A result the Harness wrote itself, without executing the tool, after the `afterTool` chain, normalized like an
 * executed call's: the output bounded with the tool's limits (the defaults when it did not resolve) and a truncation
 * diagnostic when that dropped something. `truncation` describes what the result's own output lost before (a slot's
 * retained output); it is kept only while the hooks keep that output.
 */
const afterHarnessResult = (
  ctx: Ctx,
  call: ToolHookCall,
  tool: ToolRegistration | undefined,
  result: ToolExecutionResult,
  truncation: ToolDiagnostic | undefined,
): Effect.Effect<ToolExecutionResult, unknown> =>
  Effect.gen(function* () {
    let final = result
    yield* eachHook(ctx, "afterTool", (hook) =>
      Effect.map(hook(call, final, ctx.api.hookApi), (replaced) => {
        final = replaced ?? final
      }),
    )
    const harness: ToolDiagnostic[] = []
    if (truncation !== undefined && final.output === result.output) harness.push(truncation)
    const limits = outputLimits(tool)
    const bounded = boundContent(final.output ?? [], limits)
    if (bounded.droppedBytes > 0) harness.push(truncated(bounded, limits.retain))
    // The tool never produced a value for programs.
    const { structuredOutput: _dropped, ...rest } = final
    return { ...rest, output: bounded.content, diagnostics: [...(rest.diagnostics ?? []), ...harness] }
  })

/**
 * Commit the tool's terminal state and mark its slot done: a model-issued call appends its result entry and ends with
 * the entry ID. Nested calls this call left running are aborted first, so they report into their slots before the
 * slots below the call leave `pi.live`. `control` applies only when the task completes.
 */
const settle = (
  ctx: Ctx,
  input: ToolTaskInput,
  call: ToolHookCall,
  end: Ending,
  result: ToolExecutionResult,
  durationMs?: number,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { runtime } = ctx
    if (input.kind === "nested") return yield* Effect.die(new Error(`Settling a nested tool call ${LATER_STEP}`))
    // Every live nested call the task owns, also those an earlier attempt made.
    const nestedIds = (yield* runtime.ownedTasks())
      .filter((record) => record.kind === ToolTask.definition.name && (record.input as ToolTaskInput).kind === "nested")
      .map((record) => record.id)
    const madeNested = (yield* runtime.memo(MADE_NESTED_CALLS)) === true
    // Mark them all before waiting for any: one may run until a sibling is cancelled.
    yield* Effect.all(
      nestedIds.map((id) => runtime.abortOwned(id)),
      { concurrency: "unbounded", discard: true },
    )
    yield* runtime.commit((tx) =>
      Effect.gen(function* () {
        const conversationId = runtime.conversationId
        const live = yield* tx.doc(LiveDoc, conversationId)
        const slot = toolSlot(live, runtime.taskId)
        const timing = { timestamp: runtime.now(), ...(durationMs === undefined ? {} : { durationMs }) }
        const entry = yield* appendToolResult(tx, conversationId, call, result, timing)
        if (slot !== undefined && !("parentTaskId" in slot)) {
          finishSlot(slot)
          slot.entry = entry.id
        }
        // Tools build control objects freely; drop keys set to undefined so the task result is strict JSON.
        const control =
          result.control === undefined || end.status !== "completed"
            ? {}
            : { control: copyJson(result.control as JsonValue, { omitUndefinedProperties: true }) as ToolControl }
        const settled: ToolTaskResult = { kind: "model", entryId: entry.id, ...control }
        // A call that made no nested calls, in any attempt, has no slots below it; skipping the scan keeps many leaves
        // linear.
        if (madeNested) removeNestedSlots(live, runtime.taskId)
        if (end.status === "aborted") {
          return { status: "terminal", outcome: { status: "aborted", result: settled } } as Next
        }
        if (end.status === "failed") {
          const error = {
            message: end.message,
            ...(end.reason === undefined ? {} : { detail: { reason: end.reason } }),
          }
          return { status: "terminal", outcome: { status: "failed", error, result: settled } } as Next
        }
        return { status: "terminal", outcome: { status: "completed", result: settled } } as Next
      }),
    )
  })

/**
 * How a tool task ends; the result entry is appended either way. `failed` (execution failed or was interrupted)
 * records cancellation intent for the conversations the call owns; a result with `isError` still completes.
 */
type Ending =
  | { readonly status: "completed" | "aborted" }
  | { readonly status: "failed"; readonly message: string; readonly reason?: string }

const COMPLETED: Ending = { status: "completed" }

/**
 * An error result from the slot's durable partial output, details, and diagnostics, ending with `code`; and the
 * truncation diagnostic of that output, when its bounds dropped some, which the caller adds after `afterTool`.
 */
function fromSlot(
  slot: Readonly<ToolSlot | NestedToolSlot> | undefined,
  code: string,
  message: string,
): { readonly result: ToolExecutionResult; readonly truncation?: ToolDiagnostic } {
  const droppedBytes = slot?.droppedBytes ?? 0
  const result: ToolExecutionResult = {
    output: slot?.output === undefined || slot.output === "" ? [] : [{ type: "text", text: slot.output }],
    isError: true,
    ...(slot?.details === undefined ? {} : { details: slot.details }),
    diagnostics: [...(slot?.diagnostics ?? []), toolDiagnostic(code, message)],
  }
  if (droppedBytes === 0) return { result }
  return { result, truncation: truncated({ droppedBytes, droppedLines: slot?.droppedLines ?? 0 }) }
}

/** An error result the Harness writes itself: no content and one `error` diagnostic with `code`. */
export function harnessError(code: string, message: string): ToolExecutionResult {
  return { output: [], isError: true, diagnostics: [toolDiagnostic(code, message)] }
}

function toolDiagnostic(code: string, message: string): ToolDiagnostic {
  return { severity: "error", code, message }
}

/** The Harness's truncation diagnostic; `retain` is unknown when rebuilt from a slot after recovery. */
function truncated(
  dropped: { readonly droppedLines: number; readonly droppedBytes: number },
  retain?: "head" | "tail",
): ToolDiagnostic {
  const kept = retain === undefined ? "" : ` to its ${retain === "head" ? "beginning" : "end"}`
  return {
    severity: "warn",
    code: "truncated",
    message: `Output truncated${kept}: ${dropped.droppedLines} lines, ${dropped.droppedBytes} bytes dropped`,
  }
}

/**
 * Append a `pi.tool-result` entry. The content ends with the rendered diagnostics, so the stored message is exactly
 * what the model sees; `data` keeps the structured list. A result's usage is added to `pi.usage` in the same commit.
 */
export const appendToolResult = (
  tx: Tx,
  conversationId: ConversationId,
  call: ToolCall,
  result: ToolExecutionResult,
  meta: { readonly timestamp: number; readonly durationMs?: number },
): Effect.Effect<TypedEntry<{ diagnostics: ToolDiagnostic[] }>, unknown> =>
  Effect.gen(function* () {
    const { timestamp, durationMs } = meta
    const diagnostics = [...(result.diagnostics ?? [])]
    const content: Content = [...(result.output ?? [])]
    if (diagnostics.length > 0) content.push({ type: "text", text: renderDiagnostics(diagnostics) })
    const message = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content,
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      isError: result.isError ?? false,
      ...(durationMs === undefined ? {} : { durationMs }),
      timestamp,
    } as ToolResultMessage
    if (result.usage !== undefined) yield* recordUsage(tx, conversationId, "tools", call.name, result.usage)
    const stored = copyJson(message, {
      omitUndefinedProperties: true,
    }) as unknown as JsonRepresentation<ToolResultMessage>
    return yield* tx.appendEntry(ToolResultEntry, conversationId, {
      model: [stored as unknown as JsonObject],
      data: { diagnostics: diagnostics as unknown as JsonObject[] } as never,
    })
  })

function renderDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
  return `<harness>\n${diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`).join("\n")}\n</harness>`
}

/**
 * Bound the text of result content. When the joined text exceeds the limits, the text items are replaced by one
 * bounded item at the position of the first (head) or last (tail) text item; other content is kept.
 */
function boundContent(
  content: Content,
  limits: OutputLimits,
): { content: Content; droppedBytes: number; droppedLines: number } {
  const texts = content.filter((item): item is TextContent => item.type === "text")
  const bounded = boundOutput(texts.map((item) => item.text).join(""), limits)
  if (bounded.droppedBytes === 0) return { content, droppedBytes: 0, droppedLines: 0 }
  const keep = limits.retain === "head" ? texts[0] : texts.at(-1)
  const result: Content = []
  for (const item of content) {
    if (item.type !== "text") result.push(item)
    else if (item === keep) result.push({ ...item, text: bounded.text })
  }
  return { content: result, droppedBytes: bounded.droppedBytes, droppedLines: bounded.droppedLines }
}
