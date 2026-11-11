// The providers of a home served on the kernel: every instance its config names, opened from its kind, with the
// sign-ins, health and model lists over them, and how a new conversation's model is chosen.
import { defineDoc } from "@nisse/kernel"
import { type ProviderInstance, THINKING_LEVELS, type ThinkingLevel } from "@nisse/models"
import { type ModelSelection, UnknownEffort, UnknownProvider } from "@nisse/wire"
import { Context, Effect, Layer } from "effect"
import { chooseModel, type ModelAsk } from "../config.ts"
import { openInstances, type ProviderOptions } from "../drivers/index.ts"
import { Setup } from "../setup.ts"

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

export class KernelProviders extends Context.Service<
  KernelProviders,
  {
    readonly instances: ReadonlyMap<string, ProviderInstance>
    readonly setup: Setup["Service"]
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
        const instances = yield* openInstances(options)
        const setup = yield* Setup.make(instances)
        const home = options.config.default_model
        return KernelProviders.of({
          instances,
          setup,
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
