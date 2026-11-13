// The `claude.run` task: one run of a conversation whose model Claude Code serves, from its inputs to its run_end. It
// starts or resumes Claude Code's session where the conversation's position says, tells it what the session missed, and
// lets `converse` commit what it does. A host restart leaves calls without results; the next invocation records them
// as interrupted and goes on from the position. The `claude.subagent` task holds the run of a hosted subagent's
// conversation until Claude Code says the subagent ended.
import {
  ApprovalsDoc,
  applyBoundary,
  appendToolResult,
  convertPartial,
  cutOffCount,
  cutOffTooOften,
  endAnswered,
  endFailedRun,
  endRun,
  LiveDoc,
  type ModelRef,
  prepareBoundary,
  prepareFailure,
  type RunCtx,
  type RunTasks,
  startRun,
  salvageable,
  type TaskApi,
  TaskServices,
} from "@nisse/harness"
import {
  type ConversationId,
  defineTask,
  type AnyTask,
  type EntryId,
  type EntryRecord,
  idFromNumber,
  type NextTaskState,
  type RunningTask,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@nisse/kernel"
import type { Message } from "@nisse/models"
import { Deferred, Effect } from "effect"
import { SubagentLinks } from "./links.ts"
import {
  type ClaudeProcessSettings,
  openProcess,
  type ProcessConfig,
  processKey,
  selectionOf,
  type Start,
} from "./process.ts"
import type { ClaudeProcesses, Openings } from "./processes.ts"
import { history, INTERRUPTED, JOINING, textOf, unseen } from "./retell.ts"
import type { ClaudeRunCheckpoint, Ended, RunContext } from "./serving.ts"
import { ClaudeSessionDoc } from "./session.ts"

export const CLAUDE_RUN_KIND = "claude.run"
export const CLAUDE_SUBAGENT_KIND = "claude.subagent"

/** What a resumed session is sent when nothing happened since its position, as after a restart that lost nothing. */
export const CONTINUE = "Continue."

export type ClaudeRunResult = { entryId?: EntryId }
type Runtime = TaskRuntime<Record<string, never>, ClaudeRunCheckpoint, ClaudeRunResult>
type Next = NextTaskState<ClaudeRunCheckpoint, ClaudeRunResult>
type Running = RunningTask<Record<string, never>, ClaudeRunCheckpoint, ClaudeRunResult>

export interface ClaudeRunOptions {
  /** How the Claude Code of a provider instance is started; `undefined` for a provider Claude Code does not serve. */
  readonly settings: (provider: string) => ClaudeProcessSettings | undefined
  /** Extensions whose tools Claude Code has its own of, so nisse's MCP server leaves them out. */
  readonly builtinExtensions?: ReadonlySet<string>
  /** Tool names extensions removed, whose Claude Code equivalents it is told not to use. */
  readonly withheldTools?: () => ReadonlyArray<string>
  /** The conversation's title, which names a fresh session so Claude Code does not ask a model for one. */
  readonly title?: (conversation: ConversationId) => Effect.Effect<string | undefined>
  /** The live processes the runs lease, from `makeClaudeProcesses`. */
  readonly processes: ClaudeProcesses
}

const failed = (message: string, reason: string): Next => ({
  status: "terminal",
  outcome: { status: "failed", error: { message, detail: { reason } } },
})

/** Removes every approval request the task `task` keyed in the conversation: `<task>/<call>`. */
const expireApprovals = (tx: Tx, conversationId: Runtime["conversationId"], task: TaskId) =>
  Effect.map(tx.doc(ApprovalsDoc, conversationId), (doc) => {
    for (const key of Object.keys(doc.requests)) if (key.startsWith(`${task}/`)) delete doc.requests[key]
  })

/** The calls of the run that have no result: the process that ran them is gone, so each gets `INTERRUPTED`. */
const interruptCalls = (tx: Tx, runtime: Runtime) =>
  Effect.gen(function* () {
    const live = yield* tx.doc(LiveDoc, runtime.conversationId)
    yield* convertPartial(tx, live, runtime.conversationId)
    delete live.generation
    for (const slot of live.tools ?? []) {
      if (slot.entry !== undefined) continue
      const call = { type: "toolCall" as const, id: slot.callId, name: slot.name, arguments: {} }
      const entry = yield* appendToolResult(
        tx,
        runtime.conversationId,
        call,
        { output: [{ type: "text", text: INTERRUPTED }], isError: true },
        { timestamp: runtime.now() },
      )
      slot.entry = entry.id
      slot.status = "done"
    }
    yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
    return live
  })

/** The entries after `seen` in the task's conversation, oldest first. */
const entriesAfter = (runtime: Runtime, seen: number) =>
  Effect.gen(function* () {
    const found: EntryRecord[] = []
    let cursor: Parameters<Runtime["entries"]>[2]
    do {
      const page = yield* runtime.entries(
        { minEntryId: idFromNumber<EntryId>(seen + 1), order: "ascending" },
        256,
        cursor,
      )
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return found
  })

/**
 * Whether a session can go on past `entries`: nothing in them changed the context before them, as a reset, a
 * compaction or an edit does, and nothing came from another model.
 */
const continuable = (entries: readonly EntryRecord[], provider: string) =>
  entries.every((entry) => {
    if (entry.head !== undefined || (entry.edits?.length ?? 0) > 0) return false
    return (entry.model ?? []).every((message) => {
      const said = message as { role?: string; provider?: string }
      return said.role !== "assistant" || said.provider === provider
    })
  })

/**
 * Whether `entry` is what a stop recorded of the turn it cut off: the text Claude was writing, or a call's result. A live
 * process kept through a stop ended that turn itself, and its session holds both (F14).
 */
const stopped = (entry: EntryRecord) =>
  (entry.model ?? []).every((message) => {
    const said = message as { role?: string; stopReason?: string; content?: unknown }
    if (said.role === "assistant") return said.stopReason === "aborted"
    return said.role === "toolResult" && textOf(said.content) === INTERRUPTED
  }) && (entry.model?.length ?? 0) > 0

/**
 * What a live process that has seen the entries through `seen` is told: what came after them, or `undefined` when
 * they changed the context it holds, as for a resume (F12). What a stop recorded is not told: only a stop the process
 * itself went through leaves it after `seen`, since any other cut-off ends the process.
 */
const afterSeen = (runtime: Runtime, provider: string, seen: number) =>
  Effect.map(entriesAfter(runtime, seen), (missed) => {
    if (!continuable(missed, provider)) return undefined
    const told = unseen(missed.filter((entry) => !stopped(entry)))
    return told.length === 0 ? [CONTINUE] : told
  })

/** The id of the conversation's newest entry. */
const newest = (runtime: Runtime) => Effect.map(runtime.entries({}, 1), (page) => Number(page.items[0]?.id ?? 0))

/** Where Claude Code's session starts for this run, and what it is told first. */
const opening = (runtime: Runtime, api: TaskApi, provider: string, title: Title) =>
  Effect.gen(function* () {
    const current = (yield* runtime.snapshot(ClaudeSessionDoc, runtime.conversationId))?.current
    if (current !== undefined && current.provider === provider) {
      const missed = yield* entriesAfter(runtime, current.seen)
      if (continuable(missed, provider)) {
        const told = unseen(missed)
        const texts = told.length === 0 ? [CONTINUE] : told
        const start: Start =
          current.conversation === Number(runtime.conversationId)
            ? { _tag: "resume", session: current.session, at: current.at }
            : { _tag: "fork", from: current.session, at: current.at, session: crypto.randomUUID() }
        return { start, texts }
      }
    }
    return yield* fresh(runtime, api, title)
  })

/** A new session, told the conversation's context; one that already has answers is told it joins it. */
const fresh = (runtime: Runtime, api: TaskApi, title: Title) =>
  Effect.gen(function* () {
    const { messages } = yield* api.context(runtime.conversationId)
    const named = yield* title(runtime.conversationId)
    const told = history(messages as Message[])
    const joins = messages.some((message) => message.role !== "user")
    const start: Start = {
      _tag: "fresh",
      session: crypto.randomUUID(),
      ...(named === undefined || named === "" ? {} : { title: named }),
    }
    return { start, texts: joins ? [JOINING, ...told] : told }
  })

/**
 * Serves the run with the conversation's live process, or a new one `openings` starts. A run that answers leaves the
 * process live, having seen every entry before the run's end, unless Claude Code still has background work (D6). A
 * stopped run leaves it live too, once Claude Code ended the turn it cut off (D5).
 */
const converse = <E>(shared: Shared, config: ProcessConfig, run: RunContext, openings: Openings<E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime } = run
      const lease = yield* shared.options.processes.lease(
        runtime.conversationId,
        processKey(config),
        selectionOf(config.agent),
        openings,
        (start) => openProcess(config, start),
      )
      const ended = yield* lease.process.serve(run, lease.texts).pipe(
        // The run's commits are refused from here, but it still reads.
        Effect.onInterrupt(() =>
          Effect.ignore(
            Effect.gen(function* () {
              if (yield* lease.process.stop(shared.options.processes.stopWithin)) lease.keep(yield* newest(runtime))
            }),
          ),
        ),
      )
      // Read before the run's end commits, which may start the next run with inputs the process has not seen.
      if (ended._tag === "answered" && !ended.turnLimit && !lease.process.busy) lease.keep(yield* newest(runtime))
      return { ended, live: lease.live }
    }),
  )

/** Ends the run as `ended` says. */
const finish = (ctx: RunCtx & { readonly runtime: Runtime }, ended: Ended) =>
  ctx.runtime.commit((tx) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
      const { runtime, api } = ctx
      const answer = ended._tag === "answered" && !ended.turnLimit ? ended.answer : undefined
      const reset = ended._tag === "reset"
      const ends = answer !== undefined || reset
      const boundary = ends ? yield* prepareBoundary(tx, runtime.conversationId, api.settings()) : undefined
      const failure = ends ? undefined : yield* prepareFailure(tx, ctx)
      const live = yield* tx.doc(LiveDoc, runtime.conversationId)
      yield* convertPartial(tx, live, runtime.conversationId)
      yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
      if (answer !== undefined) {
        yield* endAnswered(tx, ctx, live, boundary!, answer)
        return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
      }
      if (reset) {
        // The queued reset cuts the run's context before an answer. The run ends before the boundary places it.
        yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" }, api.runOwner)
        const { users, first } = yield* applyBoundary(tx, boundary!, "postTools", runtime.now())
        if (users.length > 0) {
          yield* startRun(tx, runtime.conversationId, live, { inputs: users, first }, api.runTasks, {
            keepFailure: true,
          })
        }
        return { status: "terminal", outcome: { status: "completed", result: {} } }
      }
      const [reason, detail] =
        ended._tag === "failed" || ended._tag === "exited"
          ? (["model_error", ended.message] as const)
          : ended._tag === "gone"
            ? (["model_error", "Claude Code lost its session twice"] as const)
            : ended.turnLimit
              ? (["turn_limit", "Claude Code reached the conversation's turn limit"] as const)
              : (["nothing_to_answer", "Claude Code ended without an answer"] as const)
      yield* endFailedRun(tx, ctx, live, failure!, { status: "unanswered", reason, detail })
      return failed(detail, reason)
    }),
  )

/** Ends a run whose invocations were cut off `restartLimit` times in a row (spec 5.4). */
const endCutOff = (ctx: RunCtx & { readonly runtime: Runtime }, task: Running) =>
  ctx.runtime.commit((tx) =>
    Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
      const { runtime, api } = ctx
      const text = `The Claude Code run was interrupted ${cutOffCount(task)}`
      const failure = yield* prepareFailure(tx, ctx)
      const live = salvageable(task, api.settings().restartLimit)
        ? yield* interruptCalls(tx, runtime)
        : yield* tx.doc(LiveDoc, runtime.conversationId)
      yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "restart_limit", detail: text })
      return failed(text, "restart_limit")
    }),
  )

type Title = NonNullable<ClaudeRunOptions["title"]>

type Shared = { readonly options: ClaudeRunOptions; readonly links: SubagentLinks; subagent?: AnyTask<TaskServices> }

const makeRunTask = (shared: Shared): Task<Record<string, never>, ClaudeRunCheckpoint, ClaudeRunResult, TaskServices> =>
  defineTask<Record<string, never>, ClaudeRunCheckpoint, ClaudeRunResult, TaskServices>({
    name: CLAUDE_RUN_KIND,
    version: 1,
    initial: () => ({ phase: "converse" }),
    phases: {
      converse: (task, runtime) =>
        Effect.gen(function* () {
          const api = yield* TaskServices
          const ctx = { runtime, api }
          if (cutOffTooOften(task, api.settings().restartLimit)) return yield* endCutOff(ctx, task)
          // A call the last invocation left without a result was cut off, whether by a crash or by a stop, which the
          // kernel does not count as a restart; either ended its process.
          const slots = yield* runtime.snapshot(LiveDoc, runtime.conversationId)
          if (slots?.generation !== undefined || slots?.tools?.some((slot) => slot.entry === undefined)) {
            yield* runtime.commit((tx) => Effect.as(interruptCalls(tx, runtime), undefined as never))
          }
          const agent = yield* api.agent
          const provider = agent.model?.provider ?? ""
          const settings = shared.options.settings(provider)
          if (settings === undefined) {
            return yield* finish(ctx, { _tag: "failed", message: `Claude Code does not serve provider ${provider}` })
          }
          const config: ProcessConfig = {
            agent,
            settings,
            builtinExtensions: shared.options.builtinExtensions ?? new Set<string>(),
            withheldTools: shared.options.withheldTools?.() ?? [],
            rootConversation: String(runtime.conversationId),
          }
          const run: RunContext = { runtime, api, agent, links: shared.links, subagentTask: shared.subagent! }
          const title: Title = shared.options.title ?? (() => Effect.succeed(undefined))
          const cold = () => opening(runtime, api, provider, title)
          let { ended, live } = yield* converse(shared, config, run, {
            live: (seen) => afterSeen(runtime, provider, seen),
            cold,
          })
          // A live process lost while it waited costs a cold start and nothing else (D1).
          if (ended._tag === "exited" && live) ended = (yield* converse(shared, config, run, { cold })).ended
          if (ended._tag === "gone") {
            // The session is gone, or no longer holds the position (F12): start over, told the conversation.
            yield* runtime.commit((tx) =>
              Effect.map(tx.doc(ClaudeSessionDoc, runtime.conversationId), (doc) => {
                delete doc.current
                return undefined as never
              }),
            )
            ended = (yield* converse(shared, config, run, { cold: () => fresh(runtime, api, title) })).ended
          }
          return yield* finish(ctx, ended)
        }),
    },
    abort: (_task, runtime) =>
      Effect.gen(function* () {
        const api = yield* TaskServices
        const ctx = { runtime, api }
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next, never> {
            // An input submitted after the abort withdrew the queue, before this commit, is queued behind the run.
            const failure = yield* prepareFailure(tx, ctx)
            const live = yield* interruptCalls(tx, runtime)
            yield* endFailedRun(tx, ctx, live, failure, { status: "unanswered", reason: "aborted" })
            return { status: "terminal", outcome: { status: "aborted" } }
          }),
        )
      }),
  })

type SubagentInput = { call: string; title: string }
type SubagentCheckpoint = { phase: "wait" }
type SubagentRuntime = TaskRuntime<SubagentInput, SubagentCheckpoint, ClaudeRunResult>
type SubagentNext = NextTaskState<SubagentCheckpoint, ClaudeRunResult>

/** The newest entry of the subagent's conversation: what it answered. */
const latest = (runtime: SubagentRuntime) => Effect.map(runtime.entries({}, 1), (page) => page.items[0]?.id)

const makeSubagentTask = (shared: Shared) =>
  defineTask<SubagentInput, SubagentCheckpoint, ClaudeRunResult, TaskServices>({
    name: CLAUDE_SUBAGENT_KIND,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (_task, runtime) =>
        Effect.gen(function* () {
          const api = yield* TaskServices
          const link = shared.links.link(runtime.taskId)
          yield* Deferred.succeed(link.hookApi, api.hookApi)
          const ended = yield* Deferred.await(link.ended)
          const answer = yield* latest(runtime)
          yield* runtime.commit((tx) =>
            Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, SubagentNext, never> {
              const live = yield* tx.doc(LiveDoc, runtime.conversationId)
              shared.links.forget(runtime.taskId)
              if (ended.status === "completed" && answer !== undefined) {
                yield* endRun(tx, live, runtime.taskId, { status: "done", answer }, api.runOwner)
                return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } }
              }
              const detail = ended.summary ?? `The subagent ${ended.status === "stopped" ? "was stopped" : "failed"}`
              const reason = ended.status === "stopped" ? "aborted" : "model_error"
              yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason, detail }, api.runOwner)
              return {
                status: "terminal",
                outcome: { status: "failed", error: { message: detail, detail: { reason } } },
              }
            }),
          )
        }),
    },
    abort: (_task, runtime) =>
      Effect.gen(function* () {
        const api = yield* TaskServices
        const stop = shared.links.link(runtime.taskId).stop
        if (stop !== undefined) yield* Effect.ignore(Effect.tryPromise(stop))
        shared.links.forget(runtime.taskId)
        yield* runtime.commit((tx) =>
          Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, SubagentNext, never> {
            const live = yield* tx.doc(LiveDoc, runtime.conversationId)
            yield* expireApprovals(tx, runtime.conversationId, runtime.taskId)
            yield* endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" }, api.runOwner)
            return { status: "terminal", outcome: { status: "aborted" } }
          }),
        )
      }),
  })

/**
 * The run tasks of conversations whose model Claude Code serves: `claude.run`, and `claude.subagent` for the
 * conversations of its hosted subagents. `runTasks` is what the harness is opened with.
 */
export function claudeRunTasks(options: ClaudeRunOptions): {
  readonly run: AnyTask<TaskServices>
  readonly subagent: AnyTask<TaskServices>
  readonly runTasks: RunTasks
} {
  const shared: Shared = { options, links: new SubagentLinks() }
  const run = makeRunTask(shared)
  const subagent = makeSubagentTask(shared)
  shared.subagent = subagent
  return {
    run,
    subagent,
    runTasks: {
      kinds: new Set([CLAUDE_RUN_KIND, CLAUDE_SUBAGENT_KIND]),
      choose: (model: ModelRef | undefined) =>
        model !== undefined && options.settings(model.provider) !== undefined ? run : undefined,
    },
  }
}
