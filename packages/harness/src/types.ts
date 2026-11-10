// The harness's public shapes: extensions and what they contribute, the stored agent and its resolution, settings,
// and the context view (spec sections 2.1, 7.1 and 7.4). Extension code is Effect-shaped: a section renders as an
// Effect, and hook handlers return Effects.
import type {
  AnyDocToken,
  AnyTask,
  CommitError,
  ConversationId,
  Cursor,
  DocAddressArgs,
  DocValue,
  EntryDraft,
  EntryId,
  EntryQuery,
  EntryRecord,
  InvocationEnded,
  JsonObject,
  JsonValue,
  Page,
  ReadFailure,
  SubmissionId,
  SubmissionRecord,
  TaskId,
} from "@nisse/kernel"
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  Models,
  ModelThinkingLevel,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@nisse/models"
import type { ExecutionEnv } from "@nisse/env"
import type { OutputLimits } from "./output.ts"
import type { Effect } from "effect"
import type { TaskServices } from "./services.ts"

export type ModelRef = { readonly provider: string; readonly modelId: string }

/** Who may call a tool: the model, other tools, or both (the default). */
export type ToolCaller = "model" | "tools"

/**
 * A tool as an extension registers it. Only the declaration fields enter the transcript. Running it belongs to the
 * tool task, which gives `execute` its arguments and API.
 */
export type ToolRegistration = Tool & {
  /** Whether an interrupted execution may rerun on recovery. Default `unsafe`. */
  readonly replay?: "safe" | "unsafe"
  readonly executionMode?: "parallel" | "sequential"
  readonly callers?: readonly ToolCaller[]
  /** Not offered to the model until `modelTools` loads it; other tools can call it any time. */
  readonly deferred?: true
  /** Repairs the model's arguments before validation; a throw makes them invalid. */
  readonly prepareArguments?: (args: JsonObject) => JsonObject
  /** Bounds the output the model gets; unset fields take the defaults. */
  readonly outputLimits?: Partial<OutputLimits>
  // biome-ignore lint: the tool task types the arguments and API
  readonly execute: (args: any, api: any) => Effect.Effect<unknown, unknown, any>
}

/** Committed document reads, for sections, hooks and environment builders; a task's reads also fail once it ended. */
export interface DocumentReader<E = ReadFailure> {
  snapshot<K extends AnyDocToken>(
    token: K,
    ...address: DocAddressArgs<K>
  ): Effect.Effect<Readonly<DocValue<K>> | undefined, E>
}

/** Input to rendering the system prompt sections for one request. */
export type PromptInput<T extends ToolRegistration = ToolRegistration> = {
  readonly conversationId: ConversationId
  /** The request's resolution; `agent.tools` are the tools offered in this request. */
  readonly agent: Agent<T>
  /** Built for this preparation; `undefined` without an environment. */
  readonly env: ExecutionEnv | undefined
  /** Sections already in effect after replaying the active transcript. */
  readonly shown: Readonly<Record<string, string>>
  readonly read: DocumentReader<ReadFailure | InvocationEnded>
}

/** One system prompt section; the agent's sections render in order before each request. */
export type PromptSection<T extends ToolRegistration = ToolRegistration> = {
  readonly key: string
  /** `undefined` leaves the section out. */
  render(input: PromptInput<T>): Effect.Effect<string | undefined, unknown>
  /** Default true: the text is wrapped as `<key>\n...\n</key>`. */
  readonly tag?: boolean
}

/** Built by `hook()`; matches tasks by name. Each handler returns an Effect. */
export type HookRegistration = { readonly task: string; readonly handlers: object }

/** Built by `wrapTool()` and `wrapSection()`. Wrappers are pure. */
export type Wrap<T extends ToolRegistration = ToolRegistration> =
  | { readonly tool: string; wrap(tool: T): T }
  | { readonly section: string; wrap(section: PromptSection<T>): PromptSection<T> }

/** A named bundle of code, installed in a registry and selected by conversations by name. */
export interface Extension<T extends ToolRegistration = ToolRegistration> {
  readonly name: string
  readonly tools?: readonly T[]
  readonly sections?: readonly PromptSection<T>[]
  readonly hooks?: readonly HookRegistration[]
  /** Applied where this extension is selected, in order. */
  readonly wraps?: readonly Wrap<T>[]
  /** Resolved by name for every task, whichever conversations select this extension. */
  readonly tasks?: readonly AnyTask<TaskServices>[]
}

/** One published registry state; never changes. */
export interface RegistrySnapshot<T extends ToolRegistration = ToolRegistration> {
  installed(): readonly Extension<T>[]
  extension(name: string): Extension<T> | undefined
  /** Every installed tool with its extension, in install order. Names may repeat across extensions. */
  tools(): readonly { readonly extension: Extension<T>; readonly tool: T }[]
  sections(): readonly { readonly extension: Extension<T>; readonly section: PromptSection<T> }[]
  /** The built-in task definitions, then the installed ones. */
  tasks(): readonly AnyTask<TaskServices>[]
  task(name: string): AnyTask<TaskServices> | undefined
}

/** What a Harness reads of a registry. */
export interface RegistryReader<T extends ToolRegistration = ToolRegistration> {
  snapshot(): RegistrySnapshot<T>
  /** Called synchronously after every publication. */
  subscribe(listener: () => void): () => void
}

export interface Registry<T extends ToolRegistration = ToolRegistration> extends RegistryReader<T> {
  /** Installs `extension`, or replaces the installed one with its name in place. Publishes at once. */
  install(extension: Extension<T>): void
  /** Removes the installed extension with `extension.name`, whichever object it is. A later install appends. */
  uninstall(extension: Extension): void
}

export type CompactionPolicy = {
  readonly enabled: boolean
  readonly reserveTokens: number
  readonly keepRecentTokens: number
  readonly backgroundTokens: number
}

export type CompactionSettings = Partial<CompactionPolicy> & {
  /** Per model, keyed `provider/modelId`. */
  readonly modelOverrides?: Readonly<Record<string, Partial<CompactionPolicy>>>
}

/** A conversation's stored choices: names, not objects. Unset fields follow the host. */
export type AgentState = {
  model?: ModelRef
  thinkingLevel?: ModelThinkingLevel
  /** An array selects exactly these extensions, in order; an object edits the host's default selection. */
  extensions?: string[] | { add?: string[]; remove?: string[] }
  /** Filters the selected extensions' tools: an array enables exactly these, in order. */
  tools?: string[] | { remove: string[] }
  /** Filters the enabled tools the model may call, as spec 7.1 describes; never widens. */
  modelTools?: string[] | { remove?: string[]; add?: string[] }
  /** Rendered after every extension section, as the section `instructions`. */
  instructions?: string
  cwd?: string
  /** Tool rounds one run takes at most. */
  maxTurns?: number
  compaction?: CompactionSettings
}

/** A change to `pi.agent`: a given field replaces the stored one, `null` clears it, `undefined` changes nothing. */
export type AgentChange = {
  readonly model?: ModelRef | null
  readonly thinkingLevel?: ModelThinkingLevel | null
  readonly extensions?:
    | readonly { readonly name: string }[]
    | { readonly add?: readonly { readonly name: string }[]; readonly remove?: readonly { readonly name: string }[] }
    | null
  readonly tools?:
    | readonly { readonly name: string }[]
    | { readonly remove: readonly { readonly name: string }[] }
    | null
  readonly modelTools?:
    | readonly { readonly name: string }[]
    | { readonly remove?: readonly { readonly name: string }[]; readonly add?: readonly { readonly name: string }[] }
    | null
  readonly instructions?: string | null
  readonly cwd?: string | null
  /** An integer `1` or more. */
  readonly maxTurns?: number | null
  readonly compaction?: CompactionSettings | null
}

/** A conversation's agent resolved against a registry snapshot and the settings. */
export type Agent<T extends ToolRegistration = ToolRegistration> = {
  readonly model?: ModelRef
  readonly thinkingLevel: ModelThinkingLevel
  readonly extensions: readonly Extension<T>[]
  /** The tools a request offers, in order. */
  readonly tools: readonly T[]
  /** The tools nested calls resolve among, in order. */
  readonly callable: readonly T[]
  /** Enabled deferred tools the model may call and is not offered yet, in registry order. */
  readonly deferred: readonly T[]
  /** Extension sections, then `instructions` when set. */
  readonly sections: readonly PromptSection<T>[]
  readonly instructions?: string
  readonly cwd?: string
  readonly maxTurns?: number
  readonly compaction?: CompactionSettings
}

export type ConversationRetryPolicy = {
  readonly enabled: boolean
  readonly maxRetries: number
  readonly baseDelayMs: number
  readonly maxAgentDelayMs?: number
}

export type ProgressPolicy = {
  readonly partialIntervalMs: number
  readonly outputIntervalMs: number
  /** Kept for the settings' shape; partial output is committed state (D5). */
  readonly persistWithinMs: number
}

export type QueueMode = "all" | "one-at-a-time"
export type AfterFailedRun = "keep" | "continue" | "withdraw"

/** Harness-wide policy, read at every resolution and never copied. Synchronous: some readers run on the line. */
export type HarnessSettings = {
  /** Default extension selection; absent: every installed extension, in install order. */
  readonly extensions?: readonly { readonly name: string }[]
  readonly stream?: Readonly<Record<string, unknown>>
  readonly retry?: Partial<ConversationRetryPolicy>
  readonly compaction?: CompactionSettings
  readonly progress?: Partial<ProgressPolicy>
  readonly toolExecution?: "parallel" | "sequential"
  readonly steeringMode?: QueueMode
  readonly followUpMode?: QueueMode
  readonly contextRetentionMs?: number
  readonly documentRetentionMs?: number
  readonly afterFailedRun?: AfterFailedRun
  /** Restarts in a row without progress before a task ends instead of running again; default 5. */
  readonly restartLimit?: number
}

/** Settings with every field over its default, object fields merged. */
export type Settings = {
  readonly extensions?: readonly { readonly name: string }[]
  readonly stream: Readonly<Record<string, unknown>>
  readonly retry: ConversationRetryPolicy
  readonly compaction: CompactionPolicy & Pick<CompactionSettings, "modelOverrides">
  readonly progress: ProgressPolicy
  readonly toolExecution: "parallel" | "sequential"
  readonly steeringMode: QueueMode
  readonly followUpMode: QueueMode
  readonly contextRetentionMs: number
  readonly documentRetentionMs: number
  readonly afterFailedRun: AfterFailedRun
  readonly restartLimit: number
}

/** The raw active transcript and the model context derived from it (spec 2.1). */
export type ContextView = {
  /** The newest applicable head marker, if any. */
  readonly head: EntryRecord | undefined
  /** The head marker followed by the non-head entries from its head through the tail. */
  readonly entries: readonly EntryRecord[]
  /** Per entry, its model messages after edits and excluded stop reasons, before tool result ordering. */
  readonly contributions: readonly (readonly Message[])[]
  /** The model context of the next provider request. */
  readonly messages: readonly Message[]
}

export type ToolDiagnostic = {
  readonly severity: "info" | "warn" | "error"
  readonly message: string
  readonly code?: string
}

/** What started a compaction. */
export type CompactionReason = "manual" | "threshold" | "overflow"

/** What an input says: its user message's content. */
export type UserInput = UserMessage["content"]

/**
 * The entry an input is placed as, instead of `pi.user`: an application kind, and data the transcript shows, such as its
 * author. Its model message is still the input's user message.
 */
export type InputEntry = { readonly kind: string; readonly data?: JsonValue }

/**
 * Host submission (spec 6): user input that may start a run, a passive entry write, or a continue, a run without a new
 * user message for an idle conversation whose context the model still owes an answer.
 */
export type SubmissionDraft = { readonly requestId?: string } & (
  | {
      readonly type: "input"
      readonly content: UserInput
      readonly whenBusy?: "steer" | "followUp" | "reject"
      /** An idle conversation rejects the input with `ConversationIdle` and writes nothing. */
      readonly whenIdle?: "reject"
      /** Place the input as this entry; default `pi.user` without data. The kind must not start with `pi.`. */
      readonly entry?: InputEntry
    }
  | { readonly type: "write"; readonly entry: EntryDraft }
  /** Only when idle: a busy conversation rejects it with `ConversationBusy`, and it never queues. */
  | { readonly type: "continue" }
)

export type SettledSubmissionRecord = SubmissionRecord & { readonly status: "done" | "unanswered" }

/** Post-tools controls requested by a tool result. */
export type ToolControl = {
  readonly addTools?: readonly string[]
  /** End the run without another model request when every result of the round sets it to `true`. */
  readonly terminate?: boolean
  /** Start a new context with this text as its user message and continue the run there; the last one wins. */
  readonly handoff?: string
}

/** What a tool returns: `output` for the model, `structuredOutput` for programs, `details` for UIs. */
export type ToolExecutionResult = {
  /** For the model. Omitted: the retained `output()` text. */
  readonly output?: ToolResultMessage["content"]
  readonly structuredOutput?: JsonValue
  readonly isError?: boolean
  /** Omitted: the last `details()` value becomes the details. */
  readonly details?: JsonValue
  /** Added after those recorded through `api.diagnostic()`. */
  readonly diagnostics?: readonly ToolDiagnostic[]
  /** Spend of the execution itself, such as a model call; stored on the result and in `pi.usage.tools`. */
  readonly usage?: Usage
  readonly control?: ToolControl
}

/** A compaction's result: its summary entry, or none when it found nothing to compact or was declined. */
export type CompactionResult = { entryId?: EntryId; submissionId?: SubmissionId }

/** How a run ended, for `afterRun` hooks. */
export type RunSummary = {
  /** A final answer, or a tool round whose every call asked to `terminate`. */
  readonly reason: "answer" | "terminate"
  /** The run's first entry; the answer itself for a run that has none. */
  readonly first: EntryId
  /** The answer, or the terminating round's tool-calling answer. */
  readonly answer: EntryId
  /** The run's last entry: the answer; for a `terminate` round its newest result, or the reset of its handoff. */
  readonly last: EntryId
}

/** A task an `afterRun` hook asks for. */
export type RunEndTask = { readonly task: AnyTask<TaskServices>; readonly input: JsonValue }

/** A call as tool hooks see it; `parent` is set for a nested call. */
export type ToolHookCall = ToolCall & { readonly parent?: { readonly taskId: TaskId; readonly callId: string } }

/**
 * What a hook may use: committed reads and the asking task's memos. Hooks run off the Session line, so reads see what
 * is committed when they run; a hook rerun after a crash may see more. Every operation fails once the invocation ended.
 */
export interface HookApi extends DocumentReader<ReadFailure | InvocationEnded> {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
  /** Aborts when the asking task's invocation ends. */
  readonly signal: AbortSignal
  /** The host's models, read at each call. */
  models(): Models
  memo<T extends JsonValue>(name: string): Effect.Effect<T | undefined, InvocationEnded>
  memo<T extends JsonValue>(name: string, candidate: T): Effect.Effect<T, InvocationEnded | CommitError>
  entry(id: EntryId): Effect.Effect<EntryRecord | undefined, InvocationEnded | ReadFailure>
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor?: Cursor,
  ): Effect.Effect<Page<EntryRecord>, InvocationEnded | ReadFailure>
}

/** Hooks of the built-in generation task; each handler returns an Effect. */
export interface GenerationHooks {
  /** Before every request attempt, including recovery; the result is used for that request only. */
  beforeRequest(
    request: { readonly messages: readonly Message[] },
    api: HookApi,
  ): Effect.Effect<{ readonly messages: readonly Message[] } | undefined, unknown>
  /** After the provider request body is built; the result replaces the body for that request only. */
  beforeProviderRequest(
    request: { readonly model: Model<Api>; readonly payload: unknown },
    api: HookApi,
  ): Effect.Effect<{ readonly payload: unknown } | undefined, unknown>
  /** Every terminal provider message, before classification. */
  afterResponse(message: AssistantMessage, api: HookApi): Effect.Effect<void, unknown>
  /** A final answer; the first `continue` appends a user message and continues the run. */
  onYield(answer: AssistantMessage, api: HookApi): Effect.Effect<{ readonly continue: UserInput } | undefined, unknown>
  /** After every tool of the round is terminal; `results` are the round's result entries in call order. */
  afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi): Effect.Effect<void, unknown>
  /** After a run answered; the tasks asked for run as children of the generation, which keeps the run until they end. */
  afterRun(run: RunSummary, api: HookApi): Effect.Effect<{ readonly tasks: readonly RunEndTask[] } | undefined, unknown>
}

/** Hooks of the built-in tool task, for model-issued and nested calls. */
export interface ToolHooks {
  /** Before intent; the first `block` wins, otherwise `arguments` replace the call's arguments. A failure blocks. */
  beforeTool(
    call: ToolHookCall,
    api: HookApi,
  ): Effect.Effect<{ readonly arguments?: JsonObject; readonly block?: string } | undefined, unknown>
  /** Before the result is committed; replaces the result. Runs on every result the tool task writes. */
  afterTool(
    call: ToolHookCall,
    result: ToolExecutionResult,
    api: HookApi,
  ): Effect.Effect<ToolExecutionResult | undefined, unknown>
}
