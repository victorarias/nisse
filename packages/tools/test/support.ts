// A real Harness over SQLite whose model is the faux provider, scripted per test, with this package's tools working in
// a temporary directory through a local environment.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecutionEnv } from "@nisse/env"
import { LocalExecutionEnv } from "@nisse/env/local"
import {
  type Conversation,
  createRegistry,
  defineExtension,
  type Extension,
  type Harness,
  type HarnessSettings,
  openHarness,
  type ToolRegistration,
} from "@nisse/harness"
import { openSqliteStorage } from "@nisse/kernel"
import { fromProviders, type Message, type ToolResultMessage, type UserMessage } from "@nisse/models"
import { type FauxResponseStep, fauxProvider } from "@nisse/models/faux"
import { Effect, type Scope } from "effect"

const directories: string[] = []

/** A new directory under the system's temporary directory, removed by `removeDirectories`. */
export const temporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

export const removeDirectories = (): void => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
}

export type Chat = {
  readonly harness: Harness
  readonly root: Conversation
  /** The directory every conversation's environment works in. */
  readonly workspace: string
  /** The messages of each model request, in order. */
  readonly requests: Message[][]
  /** Submits `text` to `conversation` (default the root) and waits until its run settles. */
  ask(text: UserMessage["content"], conversation?: Conversation): Effect.Effect<void, unknown>
  /** The tool results in `conversation`'s context (default the root's), oldest first. */
  toolResults(conversation?: Conversation): Effect.Effect<ToolResultMessage[], unknown>
}

/** A Harness with `tools` installed and the faux model answering with `responses`, closed with the scope. */
export const openChat = (options: {
  readonly tools: readonly ToolRegistration[]
  readonly tasks?: Extension["tasks"]
  readonly responses: readonly FauxResponseStep[]
  readonly settings?: HarnessSettings
  readonly vision?: boolean
  /** Wraps the environment each conversation gets. */
  readonly env?: (env: ExecutionEnv) => ExecutionEnv
}): Effect.Effect<Chat, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const workspace = temporaryDirectory("nisse-tools-")
    const requests: Message[][] = []
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: options.vision === false ? ["text"] : ["text", "image"] }],
    })
    faux.setResponses(
      options.responses.map((step) => (context, requestOptions, state, model) => {
        requests.push(structuredClone(context.messages))
        return typeof step === "function" ? step(context, requestOptions, state, model) : step
      }),
    )
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: "tools-under-test",
        tools: [...options.tools],
        ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
      }),
    )
    const storage = yield* openSqliteStorage(join(temporaryDirectory("nisse-tools-home-"), "kernel.sqlite"))
    const harness = yield* Effect.acquireRelease(
      openHarness(storage, {
        registry,
        models: fromProviders([faux.provider]),
        settings: options.settings ?? {},
        env: () => {
          const env = new LocalExecutionEnv({ cwd: workspace })
          return Effect.succeed(options.env === undefined ? env : options.env(env))
        },
      }),
      (harness) => Effect.ignore(harness.close),
    )
    const root = yield* harness.root({ agent: { model: { provider: faux.provider.id, modelId: "faux-1" } } })
    return {
      harness,
      root,
      workspace,
      requests,
      ask: (text, conversation = root) =>
        Effect.gen(function* () {
          const submission = yield* conversation.submit({ type: "input", content: text })
          yield* submission.wait
          yield* conversation.waitForIdle
        }),
      toolResults: (conversation = root) =>
        Effect.map(conversation.context(), (view) =>
          view.messages.filter((message): message is ToolResultMessage => message.role === "toolResult"),
        ),
    } satisfies Chat
  })

/** `env` with some methods replaced; the others call `env` itself. */
export const overriding = (env: ExecutionEnv, overrides: Partial<ExecutionEnv>): ExecutionEnv => {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(env)).filter(
    (name) => name !== "constructor" && typeof (env as never)[name] === "function",
  )
  const bound = Object.fromEntries(
    methods.map((name) => [name, (env as never as Record<string, Function>)[name]!.bind(env)]),
  )
  return { ...bound, id: env.id, cwd: env.cwd, ...overrides } as ExecutionEnv
}

/** The text of a tool result's content. */
export const resultText = (result: ToolResultMessage): string =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")

export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))
