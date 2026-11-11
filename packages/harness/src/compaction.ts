// The built-in compaction task (spec 8.7): select an old prefix of the model context, summarize it, and place a summary
// entry whose `head` is the first kept entry. A compaction the generation owns blocks it and appends directly; a
// conversation-owned one places its summary through a write submission. From pi-durable's `src/harness/compaction.ts`
// at 7d073328e (MIT, see LICENSE).
import type { Draft } from "@nisse/delta"
import {
  type ConversationId,
  defineTask,
  type EntryDraft,
  type EntryId,
  type NextTaskState,
  type RunningTask,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@nisse/kernel"
import {
  calculateContextTokens,
  estimateMessageTokens,
  isRetryableAssistantError,
  retryDelayMs,
  type AssistantMessage,
  type Message,
  type ModelThinkingLevel,
  type RequestOptions,
} from "@nisse/models"
import { Effect } from "effect"
import { orderToolResults } from "./context.ts"
import { CompactionEntry, stored } from "./entries.ts"
import { providerSessionId } from "./documents.ts"
import {
  addCompactionStatus,
  compactionStatus,
  cutOffCount,
  cutOffTooOften,
  failCompactionStatus,
  LiveDoc,
  type LiveState,
  removeCompactionStatus,
} from "./live.ts"
import { type TaskApi, TaskServices } from "./services.ts"
import { admitSubmission } from "./submissions.ts"
import { recordUsage } from "./usage.ts"
import type {
  CompactionHooks,
  CompactionPolicy,
  CompactionReason,
  CompactionResult,
  CompactionSettings,
  ContextView,
  ModelRef,
  Settings,
} from "./types.ts"

export type CompactionInput = { reason: CompactionReason; instructions?: string }

/** The pinned summarization request. */
export type SummaryRequest = {
  attempt: number
  model: ModelRef
  thinkingLevel: ModelThinkingLevel
  streamOptions: Record<string, unknown>
  maxTokens: number
  /** Newest entry of the context the range was selected from. */
  tail: EntryId
  /** First entry kept verbatim; the summary's `head`. */
  firstKept: EntryId
}

export type CompactionCheckpoint =
  | { phase: "select" }
  | ({ phase: "summarize" } & SummaryRequest)
  | ({ phase: "retry"; until: number } & SummaryRequest)

type Runtime = TaskRuntime<CompactionInput, CompactionCheckpoint, CompactionResult>
type Next = NextTaskState<CompactionCheckpoint, CompactionResult>
type Current = RunningTask<CompactionInput, CompactionCheckpoint, CompactionResult>
type Phase<P extends CompactionCheckpoint["phase"]> = RunningTask<
  CompactionInput,
  Extract<CompactionCheckpoint, { phase: P }>,
  CompactionResult
>
type Ctx = { readonly runtime: Runtime; readonly api: TaskApi }

/** Longest tool result text a serialized summary source keeps. */
const TOOL_RESULT_MAX_CHARS = 2000

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
const SUMMARY_SUFFIX = "\n</summary>"

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

/** A phase handler with the harness's services. */
const phase =
  <P extends CompactionCheckpoint["phase"]>(body: (task: Phase<P>, ctx: Ctx) => Effect.Effect<void, unknown>) =>
  (task: Phase<P>, runtime: Runtime): Effect.Effect<void, unknown, TaskServices> =>
    Effect.gen(function* () {
      const api = yield* TaskServices
      return yield* body(task, { runtime, api })
    })

/** Built-in compaction task; see the file's header. */
export const CompactionTask: Task<CompactionInput, CompactionCheckpoint, CompactionResult, TaskServices> = defineTask<
  CompactionInput,
  CompactionCheckpoint,
  CompactionResult,
  TaskServices
>({
  name: "pi.compaction",
  version: 1,
  initial: () => ({ phase: "select" }),
  phases: {
    select: phase<"select">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* failCutOff(ctx, task)
        const agent = yield* api.agent
        const settings = api.settings()
        const ref = agent.model
        const model = ref === undefined ? undefined : api.models().getModel(ref.provider, ref.modelId)
        if (ref === undefined || model === undefined) return yield* failNoModel(ctx, ref)
        const policy = compactionPolicy(settings, ref, agent.compaction)
        const view = yield* api.context(runtime.conversationId)
        const cut = selectCut(view, policy.keepRecentTokens)
        if (cut === undefined) return yield* complete(ctx)
        const firstKept = view.entries[cut]!.id
        const { reason, instructions } = task.input
        const compaction = {
          reason,
          entries: view.entries.slice(0, cut),
          messages: summarizedMessages(view, cut),
          firstKept,
          ...(instructions === undefined ? {} : { instructions }),
        }
        let decision: { readonly decline: true } | { readonly summary: string } | undefined
        yield* api.hooks.each<CompactionHooks["beforeCompact"]>("beforeCompact", (hook) =>
          decision !== undefined
            ? Effect.void
            : Effect.map(hook(compaction, api.hookApi), (result) => {
                decision ??= result
              }),
        )
        if (decision !== undefined && "decline" in decision) return yield* complete(ctx)
        if (decision !== undefined) {
          const { summary } = decision
          return yield* runtime.commit((tx, current) =>
            Effect.flatMap(tx.doc(LiveDoc, runtime.conversationId), (live) =>
              placeSummary(tx, ctx, current, live, firstKept, summary),
            ),
          )
        }
        const request: SummaryRequest = {
          attempt: 1,
          model: ref,
          thinkingLevel: agent.thinkingLevel,
          streamOptions: settings.stream as Record<string, unknown>,
          maxTokens: Math.min(
            Math.floor(0.8 * policy.reserveTokens),
            model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
          ),
          tail: view.entries.reduce((tail, entry) => (entry.id > tail ? entry.id : tail), firstKept),
          firstKept,
        }
        yield* runtime.commit(() =>
          Effect.succeed<Next>({ status: "running", checkpoint: { phase: "summarize", ...request } }),
        )
      }),
    ),
    summarize: phase<"summarize">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* failCutOff(ctx, task)
        const { phase: _, ...request } = task.state.checkpoint
        const { model: ref, thinkingLevel, streamOptions, maxTokens, tail, firstKept, attempt } = request
        const model = api.models().getModel(ref.provider, ref.modelId)
        if (model === undefined) return yield* failNoModel(ctx, ref)
        // The context at `tail` is immutable, so this is the range `select` chose.
        const view = yield* api.context(runtime.conversationId, { at: tail })
        const cut = view.entries.findIndex((entry) => entry.id === firstKept)
        const now = runtime.now()
        const messages: Message[] = [
          { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT, timestamp: now } as unknown as Message,
          {
            role: "user",
            content: [{ type: "text", text: summaryPrompt(summarizedMessages(view, cut), task.input.instructions) }],
            timestamp: now,
          },
        ]
        const { deferred: _deferred, ...forwarded } = streamOptions
        const options: RequestOptions = {
          ...forwarded,
          cacheRetention: "none",
          maxTokens,
          sessionId: yield* providerSessionId(runtime),
          ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
        }
        const message = yield* api.models().completeSimple(model, { messages }, options)
        // An abort mark or close: the abort invocation or the reopened task handles the committed state.
        if (runtime.signal.aborted) return yield* Effect.interrupt
        const summary = summaryText(message)
        const policy = api.settings().retry
        const retry =
          message.stopReason === "error" &&
          isRetryableAssistantError(message) &&
          policy.enabled &&
          attempt <= policy.maxRetries
        const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0
        yield* runtime.commit((tx, current) =>
          Effect.gen(function* () {
            const key = `${message.provider}/${message.model}`
            yield* recordUsage(tx, runtime.conversationId, "models", key, message.usage)
            const live = yield* tx.doc(LiveDoc, runtime.conversationId)
            if (summary !== undefined) return yield* placeSummary(tx, ctx, current, live, firstKept, summary)
            if (retry) {
              const status = compactionStatus(live, runtime.taskId)
              if (status !== undefined) status.retry = { at: until, error: message.errorMessage ?? "" }
              return { status: "sleeping", checkpoint: { phase: "retry", ...request, until }, until } as Next
            }
            const text = summaryFailure(message)
            failCompactionStatus(live, runtime.taskId, text)
            return failed(text, "model_error")
          }),
        )
      }),
    ),
    /** After the backoff's sleep; a run before `until` (an early wake, or a record of an earlier version) sleeps again. */
    retry: phase<"retry">((task, ctx) =>
      Effect.gen(function* () {
        const { runtime, api } = ctx
        const { phase: _, until, ...request } = task.state.checkpoint
        if (cutOffTooOften(task, api.settings().restartLimit)) return yield* failCutOff(ctx, task)
        if (until > runtime.now()) return yield* runtime.sleepUntil(until, task.state.checkpoint)
        const attempt = request.attempt + 1
        yield* runtime.commit((tx) =>
          Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live): Next => {
            const status = compactionStatus(live, runtime.taskId)
            if (status !== undefined) {
              status.attempt = attempt
              delete status.retry
            }
            return { status: "running", checkpoint: { phase: "summarize", ...request, attempt } }
          }),
        )
      }),
    ),
  },
  abort: (_task, runtime) =>
    runtime.commit((tx) =>
      Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live): Next => {
        removeCompactionStatus(live, runtime.taskId)
        return { status: "terminal", outcome: { status: "aborted" } }
      }),
    ),
})

/**
 * Creates a compaction task with its status in this commit. `owner` is the generation that waits for it (a blocking
 * compaction); without one it is conversation-owned, and `background` unless it is manual.
 */
export const createCompaction = (tx: Tx, conversationId: ConversationId, input: CompactionInput, owner?: TaskId) =>
  Effect.gen(function* () {
    const ownership =
      owner === undefined ? ({ kind: "conversation" } as const) : { kind: "task" as const, taskId: owner }
    const background = owner === undefined && input.reason !== "manual"
    const taskId = yield* tx.createTask(CompactionTask, input, { ownership, conversationId, background })
    const status = { taskId, trigger: input.reason, blocking: owner !== undefined, attempt: 1 }
    addCompactionStatus(yield* tx.doc(LiveDoc, conversationId), status)
    return taskId as TaskId<CompactionResult>
  })

/**
 * The compaction policy for `model` in a conversation, field by field: the conversation's `modelOverrides` entry, the
 * harness's, the conversation's own fields, then the harness-wide policy. A model-specific value beats a general one,
 * and the conversation beats the harness at the same level. The exception: the conversation's own `enabled: false` also
 * beats the harness's model override, since turning compaction off for a conversation does not depend on the model.
 */
export function compactionPolicy(
  settings: Settings,
  model: ModelRef,
  conversation: CompactionSettings | undefined,
): CompactionPolicy {
  const key = `${model.provider}/${model.modelId}`
  const { modelOverrides, ...harness } = settings.compaction
  const conversationModel = conversation?.modelOverrides?.[key]
  const layers: readonly (Partial<CompactionPolicy> | undefined)[] = [
    conversationModel,
    modelOverrides?.[key],
    conversation,
  ]
  const field = <K extends keyof CompactionPolicy>(name: K): CompactionPolicy[K] =>
    layers.find((layer) => layer?.[name] !== undefined)?.[name] ?? harness[name]
  return {
    enabled: conversationModel?.enabled ?? (conversation?.enabled === false ? false : field("enabled")),
    reserveTokens: field("reserveTokens"),
    keepRecentTokens: field("keepRecentTokens"),
    backgroundTokens: field("backgroundTokens"),
  }
}

/**
 * Index in `view.entries` of the first entry a summary keeps, or `undefined` when there is nothing to compact
 * (spec 8.7). Walks back from the tail until `keepRecentTokens` are kept, then cuts at the first candidate at or after
 * that entry: an entry whose contribution starts with a user or assistant message, never a tool result, and never a
 * user entry that a result of the preceding assistant's calls still follows.
 */
export function selectCut(view: ContextView, keepRecentTokens: number): number | undefined {
  const { contributions } = view
  const start = view.head === undefined ? 0 : 1
  const candidates: number[] = []
  for (let index = start; index < contributions.length; index++) {
    if (isCandidate(contributions, index)) candidates.push(index)
  }
  let kept = 0
  let cut: number | undefined
  for (let index = contributions.length - 1; index >= start; index--) {
    for (const message of contributions[index]!) kept += estimateMessageTokens(message)
    if (kept < keepRecentTokens) continue
    cut = candidates.find((candidate) => candidate >= index) ?? candidates.at(-1)
    break
  }
  if (cut === undefined) return undefined
  for (let index = start; index < cut; index++) if (contributions[index]!.length > 0) return cut
  return undefined
}

function isCandidate(contributions: ContextView["contributions"], index: number): boolean {
  const first = contributions[index]![0]
  if (first?.role === "assistant") return true
  if (first?.role !== "user") return false
  // A result of the preceding assistant's calls that follows this entry, before the next assistant, belongs before it.
  let calls: ReadonlySet<string> = new Set()
  for (let before = index - 1; before >= 0; before--) {
    const assistant = contributions[before]!.findLast((message) => message.role === "assistant")
    if (assistant === undefined) continue
    calls = new Set(assistant.content.flatMap((content) => (content.type === "toolCall" ? [content.id] : [])))
    break
  }
  if (calls.size === 0) return true
  for (let after = index; after < contributions.length; after++) {
    for (const [position, message] of contributions[after]!.entries()) {
      if (message.role === "assistant" && (after > index || position > 0)) return true
      if (message.role === "toolResult" && calls.has(message.toolCallId)) return false
    }
  }
  return true
}

/** Model messages of the entries before `cut`: the head marker first, ordered like model context (spec 2.1). */
export function summarizedMessages(view: ContextView, cut: number): Message[] {
  return orderToolResults(view.contributions.slice(0, cut).flat())
}

/**
 * Size of a request over `view` followed by `extra` (spec 8.3): the usage of the newest assistant appended after the
 * head marker, whose request included the marker, plus estimates of the messages after it; without one, estimates of
 * every message.
 */
export function estimateContext(view: ContextView, extra: readonly Message[]): number {
  let measured: AssistantMessage | undefined
  const after = view.head?.id ?? Number.NEGATIVE_INFINITY
  for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
    if (view.entries[index]!.id <= after) continue
    measured = view.contributions[index]!.findLast(
      (message): message is AssistantMessage =>
        message.role === "assistant" && calculateContextTokens(message.usage) > 0,
    )
  }
  const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1
  let tokens = measured === undefined ? 0 : calculateContextTokens(measured.usage)
  for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message)
  for (const message of extra) tokens += estimateMessageTokens(message)
  return tokens
}

/** The summary of a clean `stop` with text and no tool call; anything else is not a summary. */
function summaryText(message: AssistantMessage): string | undefined {
  if (message.stopReason !== "stop" || message.content.some((content) => content.type === "toolCall")) return undefined
  const text = message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trim()
  return text.length === 0 ? undefined : text
}

function summaryFailure(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return `Summarization failed: ${message.errorMessage ?? message.stopReason}`
  }
  if (message.stopReason === "length") return "Summarization hit the token limit; the summary is incomplete"
  if (message.content.some((content) => content.type === "toolCall")) return "Summarization attempted to call a tool"
  return "Summarization produced no text"
}

/** The summarizer's user message: the serialized conversation, the prompt, and any instructions. */
function summaryPrompt(messages: readonly Message[], instructions: string | undefined): string {
  const focus = instructions === undefined ? "" : `\n\nAdditional focus: ${instructions}`
  return `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${SUMMARIZATION_PROMPT}${focus}`
}

/**
 * Messages as plain text, so the summarizer reads a transcript instead of continuing it. System messages are omitted.
 * Thinking is omitted too: providers return summaries of the real reasoning, and replayed thinking is often not part of
 * the live context (a block that does not match its request is dropped), so including it can make the request larger
 * than the context it summarizes. Visible text, tool calls, and tool results record what happened.
 */
export function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === "user") {
      const text = contentText(message.content)
      if (text.length > 0) parts.push(`[User]: ${text}`)
    } else if (message.role === "assistant") {
      const text = message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      const calls = message.content.flatMap((content) =>
        content.type === "toolCall"
          ? [
              `${content.name}(${Object.entries(content.arguments)
                .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                .join(", ")})`,
            ]
          : [],
      )
      if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`)
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`)
    } else if (message.role === "toolResult") {
      const text = contentText(message.content)
      if (text.length > 0) parts.push(`[Tool result]: ${truncate(text, TOOL_RESULT_MAX_CHARS)}`)
    }
  }
  return parts.join("\n\n")
}

function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === "string") return content
  return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n")
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

/**
 * Places the summary entry and completes (spec 8.7). A blocking compaction, owned by its generation, appends it: the
 * generation holds the run and waits. A conversation-owned one admits it as a write submission, placed at once when
 * idle, otherwise at the next boundary, or settled `stale`. Nothing else may append to a busy conversation, so every
 * non-blocking summary goes through admission.
 */
const placeSummary = (
  tx: Tx,
  ctx: Ctx,
  current: Current,
  live: Draft<LiveState>,
  firstKept: EntryId,
  summary: string,
): Effect.Effect<Next, unknown> =>
  Effect.gen(function* () {
    const { runtime, api } = ctx
    removeCompactionStatus(live, runtime.taskId)
    delete live.compactionFailure
    const text = `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`
    const message: Message = { role: "user", content: [{ type: "text", text }], timestamp: runtime.now() }
    const entry: EntryDraft = {
      kind: CompactionEntry.kind,
      head: firstKept,
      model: [stored(message)],
      data: { reason: current.input.reason },
    }
    let result: CompactionResult
    if (current.owner === undefined) {
      const draft = { type: "write", requestId: `compaction:${runtime.taskId}`, entry } as const
      const admission = yield* admitSubmission(
        tx,
        runtime.conversationId,
        draft,
        runtime.now(),
        api.settings(),
        api.runTasks,
      )
      result = { submissionId: admission.id }
    } else {
      result = { entryId: (yield* tx.appendEntry(runtime.conversationId, entry)).id }
    }
    return { status: "terminal", outcome: { status: "completed", result } }
  })

/** Removes the status and completes without a summary. */
const complete = ({ runtime }: Ctx) =>
  runtime.commit((tx) =>
    Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live): Next => {
      removeCompactionStatus(live, runtime.taskId)
      return { status: "terminal", outcome: { status: "completed", result: {} } }
    }),
  )

/** A failed terminal state with `message` and `reason` as its detail. */
const failed = (message: string, reason: string): Next => ({
  status: "terminal",
  outcome: { status: "failed", error: { message, detail: { reason } } },
})

/** Fails a compaction cut off `settings.restartLimit` times in a row (spec 5.4) instead of running it again. */
const failCutOff = ({ runtime }: Ctx, task: { readonly restarts?: number }) => {
  const message = `Compaction was interrupted ${cutOffCount(task)}`
  return runtime.commit((tx) =>
    Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live) => {
      failCompactionStatus(live, runtime.taskId, message)
      return failed(message, "restart_limit")
    }),
  )
}

const failNoModel = ({ runtime }: Ctx, ref: ModelRef | undefined) => {
  const message = ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`
  return runtime.commit((tx) =>
    Effect.map(tx.doc(LiveDoc, runtime.conversationId), (live) => {
      failCompactionStatus(live, runtime.taskId, message)
      return failed(message, "no_model")
    }),
  )
}
