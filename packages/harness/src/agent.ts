// A conversation's agent: the stored `pi.agent` document, changes to it, and its resolution against a registry
// snapshot and the settings (spec section 7.1).
import type { Draft } from "@nisse/delta"
import { copyJson } from "@nisse/delta/json"
import { type ConversationId, type ConversationRecord, defineDoc, type Tx, type DocError } from "@nisse/kernel"
import type { Api, Model } from "@nisse/models"
import { Effect } from "effect"
import type {
  Agent,
  AgentChange,
  AgentState,
  CompactionPolicy,
  CompactionSettings,
  ConversationRetryPolicy,
  Extension,
  HarnessSettings,
  ProgressPolicy,
  PromptSection,
  RegistrySnapshot,
  Settings,
  ToolRegistration,
} from "./types.ts"

export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
  maxAgentDelayMs: 60000,
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  backgroundTokens: 32768,
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
  partialIntervalMs: 100,
  outputIntervalMs: 100,
  persistWithinMs: 1_000,
}

/** Default `settings.restartLimit`. */
export const DEFAULT_RESTART_LIMIT = 5

/** Default `settings.contextRetentionMs` and `documentRetentionMs`: ten minutes. */
const DEFAULT_RETENTION_MS = 600_000

/** The reserved section key of the agent's `instructions`. */
export const INSTRUCTIONS_KEY = "instructions"

/** The built-in agent document; rewindable, so a fork starts from the agent at its fork entry. */
export const AgentDoc = defineDoc<AgentState>({
  kind: "pi.agent",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
})

/** A number of milliseconds `0` or more as given; anything else is the default. */
const retention = (ms: number | undefined, fallback: number): number =>
  typeof ms === "number" && ms >= 0 ? ms : fallback

/** A number of restarts `1` or more, rounded down (`Infinity`: none ends a task); anything else is the default. */
const restartLimit = (limit: number | undefined): number =>
  typeof limit === "number" && limit >= 1 ? Math.floor(limit) : DEFAULT_RESTART_LIMIT

/** The host settings with every field over its default, object fields merged. */
export function resolveSettings(settings: HarnessSettings | undefined): Settings {
  const extensions = settings?.extensions
  return {
    ...(extensions === undefined ? {} : { extensions }),
    stream: { ...settings?.stream },
    retry: { ...DEFAULT_RETRY_POLICY, ...settings?.retry },
    compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction },
    // Field by field, so an explicitly undefined interval keeps its default.
    progress: {
      partialIntervalMs: settings?.progress?.partialIntervalMs ?? DEFAULT_PROGRESS_POLICY.partialIntervalMs,
      outputIntervalMs: settings?.progress?.outputIntervalMs ?? DEFAULT_PROGRESS_POLICY.outputIntervalMs,
      persistWithinMs: retention(settings?.progress?.persistWithinMs, DEFAULT_PROGRESS_POLICY.persistWithinMs),
    },
    toolExecution: settings?.toolExecution ?? "parallel",
    steeringMode: settings?.steeringMode ?? "one-at-a-time",
    followUpMode: settings?.followUpMode ?? "one-at-a-time",
    contextRetentionMs: settings?.contextRetentionMs ?? DEFAULT_RETENTION_MS,
    documentRetentionMs: retention(settings?.documentRetentionMs, DEFAULT_RETENTION_MS),
    afterFailedRun: settings?.afterFailedRun ?? "keep",
    restartLimit: restartLimit(settings?.restartLimit),
  }
}

/**
 * Applies one change to `pi.agent`: a given field replaces the stored one, `null` clears it, `undefined` changes
 * nothing. An invalid `maxTurns` or compaction token count is a defect naming the field and the value.
 */
export const configure = (tx: Tx, conversationId: ConversationId, change: AgentChange): Effect.Effect<void, DocError> =>
  Effect.flatMap(tx.doc(AgentDoc, conversationId), (state) => Effect.sync(() => applyChange(state, change)))

function applyChange(state: Draft<AgentState>, change: AgentChange): void {
  const set = <K extends keyof AgentState>(key: K, value: AgentState[K] | null | undefined) => {
    if (value === undefined) return
    if (value === null) delete state[key]
    else state[key] = value as Draft<AgentState>[K]
  }
  set("model", change.model === undefined || change.model === null ? change.model : { ...change.model })
  set("thinkingLevel", change.thinkingLevel)
  const extensions = change.extensions
  set(
    "extensions",
    extensions === undefined || extensions === null
      ? extensions
      : isList(extensions)
        ? names(extensions)
        : {
            ...(extensions.add === undefined ? {} : { add: names(extensions.add) }),
            ...(extensions.remove === undefined ? {} : { remove: names(extensions.remove) }),
          },
  )
  const tools = change.tools
  set(
    "tools",
    tools === undefined || tools === null ? tools : isList(tools) ? names(tools) : { remove: names(tools.remove) },
  )
  const modelTools = change.modelTools
  set(
    "modelTools",
    modelTools === undefined || modelTools === null
      ? modelTools
      : isList(modelTools)
        ? names(modelTools)
        : {
            ...(modelTools.remove === undefined ? {} : { remove: names(modelTools.remove) }),
            ...(modelTools.add === undefined ? {} : { add: names(modelTools.add) }),
          },
  )
  set("instructions", change.instructions)
  set("cwd", change.cwd)
  const maxTurns = change.maxTurns
  if (maxTurns !== undefined && maxTurns !== null && !(Number.isSafeInteger(maxTurns) && maxTurns >= 1)) {
    throw new RangeError(`maxTurns must be an integer 1 or more, got ${String(maxTurns)}`)
  }
  set("maxTurns", maxTurns)
  const compaction = change.compaction
  set("compaction", compaction === undefined || compaction === null ? compaction : compactionSettings(compaction))
}

/** A stored copy of a conversation's compaction settings, without undefined fields. */
function compactionSettings(settings: CompactionSettings): CompactionSettings {
  const { modelOverrides, ...policy } = settings
  if (modelOverrides === undefined) return compactionFields(policy)
  const overrides = Object.entries(modelOverrides).map(([key, override]) => [key, compactionFields(override)])
  return { ...compactionFields(policy), modelOverrides: Object.fromEntries(overrides) }
}

const TOKEN_FIELDS = ["reserveTokens", "keepRecentTokens", "backgroundTokens"] as const

/** The set fields of `policy`; a token count that is not an integer `0` or more throws a `RangeError`. */
function compactionFields(policy: Partial<CompactionPolicy>): Partial<CompactionPolicy> {
  const fields: { -readonly [K in keyof CompactionPolicy]?: CompactionPolicy[K] } =
    policy.enabled === undefined ? {} : { enabled: policy.enabled }
  for (const key of TOKEN_FIELDS) {
    const value = policy[key]
    if (value === undefined) continue
    if (!(Number.isSafeInteger(value) && value >= 0)) {
      throw new RangeError(`compaction.${key} must be an integer 0 or more, got ${String(value)}`)
    }
    fields[key] = value
  }
  return fields
}

function isList<T>(value: readonly T[] | object): value is readonly T[] {
  return Array.isArray(value)
}

function names(items: readonly { readonly name: string }[]): string[] {
  return items.map((item) => item.name)
}

/**
 * The built-in part of every commit that creates or forks a conversation, for `pi.agent`: a fork keeps its `asOf`
 * copy; a new task-owned conversation copies the stored agent of its owner task's conversation; a new ownerless one
 * starts empty.
 */
export const createAgent = (tx: Tx, conversation: ConversationRecord): Effect.Effect<void, DocError> =>
  Effect.gen(function* () {
    if (conversation.parent !== undefined) return
    const agent = yield* tx.doc(AgentDoc, conversation.id)
    if (conversation.owner === undefined) return
    const owner = yield* tx.doc(AgentDoc, conversation.owner.conversationId)
    Object.assign(agent, copyJson(owner) as AgentState)
  })

/** Handlers of the selected extensions' hooks for a task name, in extension order. */
export function agentHooks(
  agent: Agent,
  taskName: string,
): { readonly extension: string; readonly handlers: object }[] {
  const handlers: { readonly extension: string; readonly handlers: object }[] = []
  for (const extension of agent.extensions) {
    for (const hook of extension.hooks ?? []) {
      if (hook.task === taskName) handlers.push({ extension: extension.name, handlers: hook.handlers })
    }
  }
  return handlers
}

/** The extension whose code a section of `agent` runs: the last selected one that provides or wraps it. */
export function sectionExtension(agent: Agent, key: string): string | undefined {
  let found: string | undefined
  for (const extension of agent.extensions) {
    const provides = extension.sections?.some((section) => section.key === key) === true
    const wraps = extension.wraps?.some((wrap) => "section" in wrap && wrap.section === key) === true
    if (provides || wraps) found = extension.name
  }
  return found
}

/** The extension whose code a tool of `agent` runs: the last selected one that provides or wraps it. */
export function toolExtension(agent: Agent, name: string): string | undefined {
  let found: string | undefined
  for (const extension of agent.extensions) {
    const provides = extension.tools?.some((tool) => tool.name === name) === true
    const wraps = extension.wraps?.some((wrap) => "tool" in wrap && wrap.tool === name) === true
    if (provides || wraps) found = extension.name
  }
  return found
}

/**
 * Resolves an agent from its stored state (absent: every field unset), a registry snapshot and resolved settings. A
 * wrapper that throws or renames drops its target and is reported; a wrapper without a target does nothing.
 */
export function resolveAgent<T extends ToolRegistration>(
  state: Readonly<AgentState> | undefined,
  snapshot: RegistrySnapshot<T>,
  settings: Settings,
  /** Gets a wrapper's failure with the name of the wrapper's extension. */
  report: (error: unknown, extension: string) => void,
): Agent<T> {
  const extensions = selectExtensions(state?.extensions, snapshot, settings)

  const composed = new Map<string, T>()
  for (const extension of extensions) for (const tool of extension.tools ?? []) composed.set(tool.name, tool)
  const sections = new Map<string, PromptSection<T>>()
  for (const extension of extensions) {
    for (const section of extension.sections ?? []) sections.set(section.key, section)
  }
  for (const extension of extensions) {
    for (const wrap of extension.wraps ?? []) {
      const wrapReport = (error: unknown) => report(error, extension.name)
      if ("tool" in wrap)
        applyWrap(
          composed,
          wrap.tool,
          (tool) => wrap.wrap(tool),
          (tool) => tool.name,
          wrapReport,
        )
      else
        applyWrap(
          sections,
          wrap.section,
          (section) => wrap.wrap(section),
          (section) => section.key,
          wrapReport,
        )
    }
  }

  const enabled = filterTools([...composed.values()], state?.tools)
  const callableBy = (caller: "model" | "tools") => (tool: T) =>
    tool.callers === undefined || tool.callers.includes(caller)
  const modelCallable = enabled.filter(callableBy("model"))
  const tools = offeredTools(modelCallable, state?.modelTools)
  const offered = new Set(tools)
  const deferred = modelCallable.filter((tool) => tool.deferred === true && !offered.has(tool))
  const callable = enabled.filter(callableBy("tools"))

  const instructions = state?.instructions
  const agentSections = [...sections.values()]
  if (instructions !== undefined) {
    agentSections.push({ key: INSTRUCTIONS_KEY, render: () => Effect.succeed(instructions) })
  }

  return {
    ...(state?.model === undefined ? {} : { model: state.model }),
    thinkingLevel: state?.thinkingLevel ?? "off",
    extensions,
    tools,
    callable,
    deferred,
    sections: agentSections,
    ...(instructions === undefined ? {} : { instructions }),
    ...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
    ...(state?.maxTurns === undefined ? {} : { maxTurns: state.maxTurns }),
    ...(state?.compaction === undefined ? {} : { compaction: state.compaction }),
  }
}

/**
 * The agent as a request to `model` offers it: a model that takes only code mode is offered just the `codeMode` tools,
 * any other model all tools but those.
 */
export const offeredTo = <T extends ToolRegistration>(agent: Agent<T>, model: Model<Api>): Agent<T> => {
  const codeMode = model.toolMode === "code_mode_only"
  return { ...agent, tools: agent.tools.filter((tool) => (tool.codeMode === true) === codeMode) }
}

/** The tools offered to the model, as `AgentState.modelTools` describes. */
function offeredTools<T extends ToolRegistration>(tools: T[], filter: AgentState["modelTools"]): T[] {
  if (Array.isArray(filter)) return filterTools(tools, filter)
  const removed = new Set(filter?.remove ?? [])
  const kept = tools.filter((tool) => tool.deferred !== true && !removed.has(tool.name))
  // Loaded deferred tools follow in load order, so loading one appends to the declared tools.
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const loaded = [...new Set(filter?.add ?? [])].flatMap((name) => {
    const tool = byName.get(name)
    return tool?.deferred === true && !removed.has(name) ? [tool] : []
  })
  return [...kept, ...loaded]
}

/** `tools` through a stored filter: an array selects exactly its names, in its order; `{ remove }` drops names. */
function filterTools<T extends ToolRegistration>(tools: T[], filter: AgentState["tools"]): T[] {
  if (filter === undefined) return tools
  if (Array.isArray(filter)) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    return [...new Set(filter)].flatMap((name) => {
      const tool = byName.get(name)
      return tool === undefined ? [] : [tool]
    })
  }
  const removed = new Set(filter.remove)
  return tools.filter((tool) => !removed.has(tool.name))
}

/** The selected installed extensions: the stored array, or the default selection edited by `{ add, remove }`. */
function selectExtensions<T extends ToolRegistration>(
  stored: AgentState["extensions"],
  snapshot: RegistrySnapshot<T>,
  settings: Settings,
): Extension<T>[] {
  let selected: string[]
  if (Array.isArray(stored)) selected = stored
  else {
    const base = settings.extensions?.map((extension) => extension.name) ?? snapshot.installed().map((e) => e.name)
    const removed = new Set(stored?.remove ?? [])
    selected = [...base, ...(stored?.add ?? [])].filter((name) => !removed.has(name))
  }
  const extensions: Extension<T>[] = []
  for (const name of new Set(selected)) {
    const extension = snapshot.extension(name)
    if (extension !== undefined) extensions.push(extension)
  }
  return extensions
}

function applyWrap<A>(
  items: Map<string, A>,
  target: string,
  wrap: (item: A) => A,
  nameOf: (item: A) => string,
  report: (error: unknown) => void,
): void {
  const item = items.get(target)
  if (item === undefined) return
  try {
    const wrapped = wrap(item)
    if (nameOf(wrapped) !== target) throw new Error(`Wrapper renamed ${target} to ${nameOf(wrapped)}`)
    items.set(target, wrapped)
  } catch (error) {
    items.delete(target)
    report(error)
  }
}

/** Adds the tools a tool result's `addTools` control names to the stored selection and the model's loadout (spec 8.5). */
export const addTools = (
  tx: Tx,
  conversationId: ConversationId,
  added: readonly string[],
): Effect.Effect<void, DocError> =>
  Effect.map(tx.doc(AgentDoc, conversationId), (state) => {
    const tools = state.tools
    if (Array.isArray(tools)) {
      for (const name of added) if (!tools.includes(name)) tools.push(name)
    } else if (tools?.remove.some((name) => added.includes(name))) {
      state.tools = { remove: tools.remove.filter((name) => !added.includes(name)) }
    }
    const modelTools = state.modelTools
    if (Array.isArray(modelTools)) {
      for (const name of added) if (!modelTools.includes(name)) modelTools.push(name)
      return
    }
    // Assigned whole; a document write of an equal value records no change.
    const remove = (modelTools?.remove ?? []).filter((name) => !added.includes(name))
    const add = [...(modelTools?.add ?? [])]
    for (const name of added) if (!add.includes(name)) add.push(name)
    state.modelTools = { ...(remove.length === 0 ? {} : { remove }), add }
  })
