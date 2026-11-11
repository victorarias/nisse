// The providers of a home served on the kernel: every instance its config names, opened from its kind, with the
// sign-ins, health and model lists over them, and how a new conversation's model is chosen.
import { type Agent, type AgentLimits, DEFAULT_AGENT_LIMITS } from "@nisse/harness"
import { defineDoc } from "@nisse/kernel"
import { type ProviderInstance, THINKING_LEVELS, type ThinkingLevel } from "@nisse/models"
import { type ModelSelection, UnknownEffort, UnknownProvider } from "@nisse/wire"
import { Context, Effect, Layer } from "effect"
import { chooseModel, type ModelAsk } from "../config.ts"
import { claudeInstances, openInstances, type ProviderOptions } from "../drivers/index.ts"
import type { ClaudeOptions } from "../drivers/claude/index.ts"
import { type AgentType, agentTypes } from "../workspace.ts"
import { taskOfRequest } from "./agents.ts"

/** The model a conversation of this home started with last; a new one without a default of its own takes it. */
export const LastModelDoc = defineDoc<{ selection?: ModelSelection }>({
  kind: "nisse.last_model",
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

export class KernelProviders extends Context.Service<
  KernelProviders,
  {
    readonly instances: ReadonlyMap<string, ProviderInstance>
    /** How deep subagents nest and how many run at once: `[agents]` in `config.toml`, over the defaults. */
    readonly agents: AgentLimits
    /**
     * The agent types `spawn_agent` takes in a conversation on `provider` working in `cwd`: a ChatGPT instance reads
     * them from Claude Code's agent files; Claude Code has its own subagents, and a script reads nothing.
     */
    readonly agentTypes: (provider: string, cwd: string) => ReadonlyArray<AgentType>
    /** How the Claude Code of each instance Claude Code serves is started; their runs are `claude.run` tasks. */
    readonly claude: ReadonlyMap<string, ClaudeOptions>
    /** The model a conversation in `cwd` starts with when it asks for `ask`, given the model chosen last. */
    readonly choose: (
      cwd: string,
      ask: ModelAsk,
      last: ModelSelection | undefined,
    ) => Effect.Effect<{ readonly selection: ModelSelection; readonly instance: ProviderInstance }, UnknownProvider>
  }
>()("nisse/KernelProviders") {
  static readonly layer = (options: ProviderOptions) =>
    Layer.effect(
      KernelProviders,
      Effect.gen(function* () {
        // A subagent's script requests take the steps of its task path.
        const instances = yield* openInstances(options, (context) => taskOfRequest(context.messages))
        const home = options.config.default_model
        const agents = options.config.agents
        return KernelProviders.of({
          instances,
          agents: {
            maxDepth: agents?.max_depth ?? DEFAULT_AGENT_LIMITS.maxDepth,
            maxThreads: agents?.max_threads ?? DEFAULT_AGENT_LIMITS.maxThreads,
          },
          claude: claudeInstances(options),
          agentTypes: (provider, cwd) =>
            instances.get(provider)?.kind === "openai" ? agentTypes(cwd, options.openai(provider).claudeConfig) : [],
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
