// The providers of a home: every instance its config names, opened from its kind, with the sign-ins, health and model
// lists over them, and how a new conversation's model is chosen.
import { claudeAccount, type ClaudeProcessSettings } from "@sigma/claude"
import { type Agent, type AgentLimits, DEFAULT_AGENT_LIMITS } from "@sigma/harness"
import { defineDoc } from "@sigma/kernel"
import {
  type ProviderInstance,
  type ProviderKind,
  ScriptStep,
  scriptInstance,
  THINKING_LEVELS,
  type ThinkingLevel,
  type TranscriptContext,
} from "@sigma/models"
import { AUTH_BASE, BASE_URL, CALLBACK_PORT, type ChatGptOptions, chatGptInstance } from "@sigma/models/chatgpt"
import { type ModelSelection, UnknownEffort, UnknownProvider } from "@sigma/protocol"
import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { chooseModel, expandHome, type HomeConfig, type Instance, type ModelAsk } from "./config.ts"
import type { Home } from "./home.ts"
import instructions from "./instructions.md" with { type: "text" }
import { type AgentType, agentTypes } from "./workspace.ts"
import { taskOfRequest } from "./agents.ts"

/**
 * Where a ChatGPT instance keeps its sign-in and models, the URLs it reaches, and the Claude Code config directory
 * whose agent types it can spawn; sigma adds its instructions.
 */
export type OpenAiOptions = Omit<ChatGptOptions, "instructions"> & { readonly claudeConfig: string }

export interface ProviderOptions {
  readonly script?: ReadonlyArray<ScriptStep>
  readonly openai: (id: string) => OpenAiOptions
  readonly claude: ClaudeProcessSettings
  readonly preferred: string
  readonly config: HomeConfig
}

/** The steps of the script at `path`, the format of `SIGMA_MODEL_SCRIPT`; none for an empty path. */
export const readScript = (path: string | undefined): Effect.Effect<ReadonlyArray<ScriptStep>> =>
  path === undefined
    ? Effect.succeed([])
    : Effect.promise(() => Bun.file(path).json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ScriptStep))),
        Effect.orDie,
      )

/** Where each ChatGPT instance of `home` keeps its sign-in and models, and the URLs it reaches. */
export const openAiOptions =
  (home: Home) =>
  (id: string): OpenAiOptions => ({
    authPath: join(home.dir, "auth", `${id}.json`),
    modelsPath: join(home.dir, "cache", `${id}-models.json`),
    authBase: process.env.SIGMA_OPENAI_URL ?? AUTH_BASE,
    baseUrl: process.env.SIGMA_OPENAI_URL ?? BASE_URL,
    callbackPort: CALLBACK_PORT,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  })

const claudeInstance = (base: ClaudeProcessSettings, instance: Instance): ClaudeProcessSettings => {
  const executable = instance.binary === undefined ? base.executable : expandHome(instance.binary)
  const args = instance.args ?? base.args
  return {
    ...(executable === undefined ? {} : { executable }),
    env: {
      ...base.env,
      ...instance.env,
      ...(instance.config_dir === undefined ? {} : { CLAUDE_CONFIG_DIR: expandHome(instance.config_dir) }),
    },
    ...(args === undefined ? {} : { args }),
  }
}

/** The instances a home has: the built-in `claude` and `openai`, then those its `config.toml` names. */
const configured = (config: HomeConfig): Record<string, Instance> => ({
  claude: { driver: "claude" },
  openai: { driver: "openai" },
  ...config.providers,
})

/** Claude Code: its account here; its conversations run as `claude.run` tasks, so it gives no `Models` provider. */
const claudeKind = (base: ClaudeProcessSettings): ProviderKind<Instance> => ({
  kind: "claude",
  open: (id, settings) => Effect.succeed({ ...claudeAccount(claudeInstance(base, settings)), id }),
})

/** ChatGPT, told sigma's instructions, which name the tools sigma gives it. */
const openAiKind = (options: (id: string) => OpenAiOptions): ProviderKind<Instance> => ({
  kind: "openai",
  open: (id) => chatGptInstance(id, { ...options(id), instructions: instructions.trimEnd() }),
})

/** How each Claude Code instance of a home is started, by instance id. */
const claudeInstances = (options: ProviderOptions): ReadonlyMap<string, ClaudeProcessSettings> =>
  new Map(
    Object.entries(configured(options.config)).flatMap(([id, instance]) =>
      instance.driver === "claude" ? [[id, claudeInstance(options.claude, instance)] as const] : [],
    ),
  )

/**
 * Every provider instance of a home, by id: `script` when there is a script, then each one configured. `scriptAgent`
 * names the agent a script request is for, from its context.
 */
const openInstances = (options: ProviderOptions, scriptAgent?: (context: TranscriptContext) => string | undefined) =>
  Effect.gen(function* () {
    const kinds = { claude: claudeKind(options.claude), openai: openAiKind(options.openai) }
    const instances = new Map<string, ProviderInstance>()
    if (options.script) instances.set("script", scriptInstance(options.script, scriptAgent))
    for (const [id, settings] of Object.entries(configured(options.config)))
      instances.set(id, yield* kinds[settings.driver].open(id, settings))
    return instances as ReadonlyMap<string, ProviderInstance>
  })

/** The model a conversation of this home started with last; a new one without a default of its own takes it. */
export const LastModelDoc = defineDoc<{ selection?: ModelSelection }>({
  kind: "sigma.last_model",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
})

const isThinkingLevel = (effort: string): effort is ThinkingLevel =>
  (THINKING_LEVELS as ReadonlyArray<string>).includes(effort)

/** A selection as the conversation's agent holds it. */
export const agentModel = (selection: ModelSelection, instance: ProviderInstance) =>
  Effect.gen(function* () {
    if (selection.effort !== undefined && !isThinkingLevel(selection.effort)) {
      return yield* new UnknownEffort({ effort: selection.effort, efforts: [...THINKING_LEVELS] })
    }
    return {
      // An empty id is the provider's own choice, as Claude Code makes it.
      model: { provider: selection.provider, modelId: selection.model ?? instance.defaultModel ?? "" },
      ...(selection.effort === undefined ? {} : { thinkingLevel: selection.effort }),
    }
  })

/** The model an agent runs, as a selection: an empty model id is the provider's own choice. */
export const selectionOf = (agent: Pick<Agent, "model"> & { readonly thinkingLevel?: string }): ModelSelection => ({
  provider: agent.model?.provider ?? "",
  ...(agent.model?.modelId ? { model: agent.model.modelId } : {}),
  ...(agent.thinkingLevel === undefined || agent.thinkingLevel === "off" ? {} : { effort: agent.thinkingLevel }),
})

export class Providers extends Context.Service<
  Providers,
  {
    readonly instances: ReadonlyMap<string, ProviderInstance>
    /** How deep subagents nest and how many run at once: `[agents]` in `config.toml`, over the defaults. */
    readonly agents: AgentLimits
    /** How the Claude Code of each instance Claude Code serves is started; their runs are `claude.run` tasks. */
    readonly claude: ReadonlyMap<string, ClaudeProcessSettings>
    /**
     * The agent types a conversation on `provider` in `cwd` can spawn: a ChatGPT instance's, from `.claude/agents` and
     * its Claude Code config directory; none for the rest, which find their own or have none.
     */
    readonly agentTypes: (provider: string | undefined, cwd: string) => ReadonlyArray<AgentType>
    /** The model a conversation in `cwd` starts with when it asks for `ask`, given the model chosen last. */
    readonly choose: (
      cwd: string,
      ask: ModelAsk,
      last: ModelSelection | undefined,
    ) => Effect.Effect<{ readonly selection: ModelSelection; readonly instance: ProviderInstance }, UnknownProvider>
  }
>()("sigma/Providers") {
  static readonly layer = (options: ProviderOptions) =>
    Layer.effect(
      Providers,
      Effect.gen(function* () {
        // A subagent's script requests take the steps of its task path.
        const instances = yield* openInstances(options, (context) => taskOfRequest(context.messages))
        const home = options.config.default_model
        const agents = options.config.agents
        return Providers.of({
          instances,
          agents: {
            maxDepth: agents?.max_depth ?? DEFAULT_AGENT_LIMITS.maxDepth,
            maxThreads: agents?.max_threads ?? DEFAULT_AGENT_LIMITS.maxThreads,
          },
          claude: claudeInstances(options),
          agentTypes: (provider, cwd) =>
            provider !== undefined && instances.get(provider)?.kind === "openai"
              ? agentTypes(cwd, options.openai(provider).claudeConfig)
              : [],
          choose: (cwd, ask, last) =>
            Effect.suspend(() => {
              const selection = chooseModel(cwd, ask, {
                ...(home ? { home } : {}),
                ...(last ? { last } : {}),
                preferred: options.preferred,
                has: (provider) => instances.has(provider),
              })
              const instance = instances.get(selection.provider)
              return instance
                ? Effect.succeed({ selection, instance })
                : Effect.fail(new UnknownProvider({ provider: selection.provider }))
            }),
        })
      }),
    )
}
