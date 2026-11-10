// The harness's public shapes: extensions and what they contribute, the stored agent and its resolution, settings,
// and the context view (spec sections 2.1, 7.1 and 7.4). Extension code is Effect-shaped: a section renders as an
// Effect, and hook handlers return Effects.
import type {
  AnyDocToken,
  AnyTask,
  ConversationId,
  DocAddressArgs,
  DocValue,
  EntryRecord,
  ReadFailure,
} from "@nisse/kernel"
import type { Message, ModelThinkingLevel, Tool } from "@nisse/models"
import type { ExecutionEnv } from "@nisse/env"
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
  // biome-ignore lint: the tool task types the arguments and API
  readonly execute: (args: any, api: any) => Effect.Effect<unknown, unknown, any>
}

/** Committed document reads, for sections and environment builders. */
export interface DocumentReader {
  snapshot<K extends AnyDocToken>(
    token: K,
    ...address: DocAddressArgs<K>
  ): Effect.Effect<Readonly<DocValue<K>> | undefined, ReadFailure>
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
  readonly read: DocumentReader
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
