// The kernel server's extension host: the home's extensions, loaded from disk with the `@nisse/extension` API both
// servers serve, and run as harness extensions. Their tool transforms edit nisse's own tool extensions once per load;
// `execute.before` and `execute.after` run as the tool task's `beforeTool` and `afterTool` hooks; status lines are a
// committed conversation document the view carries, and toasts are `nisse.toast` entries.
import {
  defineExtension,
  type Extension as HarnessExtension,
  type Harness,
  hook,
  type Registry,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolRegistration,
  ToolTask,
} from "@nisse/harness"
import { type ConversationId, defineDoc, type JsonObject, type Tx } from "@nisse/kernel"
import { rootConversation } from "@nisse/tools"
import { Cause, Effect, Exit, Scope, Semaphore } from "effect"
import type { ModelSelection } from "@nisse/protocol"
import { STATUS_LINES_KIND, TOAST_KIND } from "@nisse/wire"
import type { Home } from "../home.ts"
import {
  type Extension,
  Refused,
  type ToolCall,
  type ToolEditor,
  type ToolFailures,
  type ToolHooks,
  type ToolResult,
} from "../extensions/api.ts"
import {
  type ExtensionInfo,
  failureReason,
  forgetExtensions,
  HOOK_LIMIT,
  importExtension,
  LOAD_LIMIT,
  planExtensions,
} from "../extensions/discover.ts"
import { serveSharedModules } from "../extensions/modules.ts"
import type { Tool as ExtensionTool } from "../tools/tool.ts"
import { ConversationIdsDoc } from "./ids.ts"

/** Each extension's status line in one conversation, by extension name. */
export const StatusLinesDoc = defineDoc<{ lines: Record<string, string> }>({
  kind: STATUS_LINES_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A line belongs to the code that set it, which a fork does not run.
  fork: "initial",
  initial: () => ({ lines: {} }),
  checkpointWhen: () => true,
})

/** The conversations that show a status line, so a start or a reload can clear them all. */
const StatusShownDoc = defineDoc<{ conversations: number[] }>({
  kind: "nisse.status_shown",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: [] }),
  checkpointWhen: () => true,
})

/** The name the host's own harness extension takes: the extensions' added tools and their hooks. */
const HOST = "nisse-extensions"

/** The results the harness writes without running the tool; `execute.after` sees only calls that ran. */
const NOT_RUN = new Set(["blocked", "denied", "tool_unavailable", "invalid_arguments", "aborted", "interrupted"])

interface Registered<A> {
  readonly extension: string
  readonly value: A
}

type Hook<Name extends keyof ToolHooks> = (event: ToolHooks[Name]) => Effect.Effect<void, ToolFailures[Name]>

interface About {
  readonly cwd: string
  readonly model: ModelSelection
}

interface Loaded {
  readonly infos: Array<ExtensionInfo>
  readonly hooks: { readonly [Name in keyof ToolHooks]: Array<Registered<Hook<Name>>> }
}

export interface KernelExtensions {
  readonly list: Effect.Effect<ReadonlyArray<ExtensionInfo>>
  readonly reload: Effect.Effect<ReadonlyArray<ExtensionInfo>>
}

const refusalOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause)
  return error._tag === "Some" && error.value instanceof Refused ? error.value.message : undefined
}

const textOf = (result: ToolExecutionResult) =>
  (result.output ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")

/** An extension's tool as the harness runs it: it asks first unless it is read-only. */
const fromExtensionTool = (tool: ExtensionTool): ToolRegistration => ({
  name: tool.spec.name,
  description: tool.spec.description,
  parameters: tool.spec.parameters as object,
  ...(tool.readOnly ? {} : { asks: true as const }),
  execute: (args: unknown, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const root = yield* Effect.orDie(rootConversation(api))
      const outcome = yield* tool.run(args, {
        call: api.callId as never,
        cwd: api.env?.cwd ?? process.cwd(),
        env: { NISSE_ROOT_CONVERSATION: String(root) },
        output: (text) => Effect.sync(() => api.output(text)),
      })
      return {
        output: outcome.output === "" ? [] : [{ type: "text", text: outcome.output }],
        isError: outcome.error,
      } satisfies ToolExecutionResult
    }),
})

/**
 * Loads the home's extensions into `registry`, over `base`, nisse's own tool extensions, which it installs edited by
 * the extensions' transforms. `harness` is read when a hook runs, after the Harness opened.
 */
export const openKernelExtensions = (
  home: Home,
  registry: Registry,
  base: ReadonlyArray<HarnessExtension>,
  harness: () => Harness,
): Effect.Effect<KernelExtensions, never, Scope.Scope> =>
  Effect.gen(function* () {
    serveSharedModules()
    let current: Loaded = { infos: [], hooks: { "execute.before": [], "execute.after": [] } }
    let scopes: ReadonlyArray<Scope.Closeable> = []

    const commit = (body: (tx: Tx) => Effect.Effect<void, unknown>) => Effect.ignore(harness().session.commit(body))

    /** Clears every status line, in one commit. */
    const clearStatus = commit((tx) =>
      Effect.gen(function* () {
        const shown = yield* tx.doc(StatusShownDoc)
        for (const id of shown.conversations) {
          const doc = yield* tx.doc(StatusLinesDoc, id as ConversationId)
          doc.lines = {}
        }
        shown.conversations = []
      }),
    )

    const toast = (conversation: ConversationId, extension: string, text: string) =>
      commit((tx) => Effect.asVoid(tx.appendEntry(conversation, { kind: TOAST_KIND, data: { extension, text } })))

    /** The id clients name the conversation by: the one a client chose, or its number. */
    const wireId = (conversation: ConversationId) =>
      Effect.map(Effect.orDie(harness().session.snapshot(ConversationIdsDoc)), (chosen) => {
        const pair = Object.entries(chosen?.ids ?? {}).find(([, number]) => number === Number(conversation))
        return pair?.[0] ?? String(conversation)
      })

    const handle = (conversation: ConversationId, about: About, extension: string, loaded: Loaded) =>
      Effect.map(wireId(conversation), (id) => ({
        id: id as never,
        cwd: about.cwd,
        model: about.model,
        // A status set by code that a reload replaced since is dropped in the commit, so none outlives its code.
        status: (text?: string) =>
          commit((tx) =>
            Effect.gen(function* () {
              if (loaded !== current) return
              const doc = yield* tx.doc(StatusLinesDoc, conversation)
              const line = text === undefined || text === "" ? undefined : text
              if (doc.lines[extension] === line) return
              if (line === undefined) delete doc.lines[extension]
              else doc.lines[extension] = line
              const shown = yield* tx.doc(StatusShownDoc)
              if (!shown.conversations.includes(Number(conversation))) shown.conversations.push(Number(conversation))
            }),
          ),
        toast: (text: string) => toast(conversation, extension, text),
      }))

    const runHook = <E>(conversation: ConversationId, extension: string, name: string, run: Effect.Effect<void, E>) =>
      Effect.exit(Effect.timeout(run, HOOK_LIMIT)).pipe(
        Effect.tap((exit) =>
          Exit.isFailure(exit) && refusalOf(exit.cause) === undefined
            ? toast(conversation, extension, `${name} failed: ${failureReason(exit.cause)}`)
            : Effect.void,
        ),
      )

    /** What a hook's `conversation` says of where it works and on which model. */
    const about = (api: { readonly conversationId: ConversationId }): Effect.Effect<About> =>
      Effect.map(
        Effect.orDie(
          Effect.flatMap(harness().conversation(api.conversationId), (c) =>
            c === undefined ? Effect.succeed(undefined) : c.agent,
          ),
        ),
        (agent) => ({
          cwd: agent?.cwd ?? home.dir,
          model:
            agent?.model === undefined
              ? { provider: "" }
              : { provider: agent.model.provider, model: agent.model.modelId },
        }),
      )

    const beforeTool = (call: ToolHookCall, api: { readonly conversationId: ConversationId }) =>
      Effect.gen(function* () {
        const loaded = current
        if (loaded.hooks["execute.before"].length === 0) return undefined
        const conversation = yield* about(api)
        let input: unknown = call.arguments
        for (const registered of [...loaded.hooks["execute.before"]]) {
          const event: ToolCall = {
            conversation: yield* handle(api.conversationId, conversation, registered.extension, loaded),
            call: call.id as never,
            tool: call.name,
            input: structuredClone(input),
          }
          const exit = yield* runHook(
            api.conversationId,
            registered.extension,
            "execute.before",
            Effect.suspend(() => registered.value(event)),
          )
          if (Exit.isFailure(exit)) {
            const refusal = refusalOf(exit.cause) ?? `it failed: ${failureReason(exit.cause)}`
            return { block: `${registered.extension} refused this call: ${refusal}` }
          }
          input = event.input
        }
        return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input as JsonObject }
      })

    const afterTool = (
      call: ToolHookCall,
      result: ToolExecutionResult,
      api: { readonly conversationId: ConversationId },
    ) =>
      Effect.gen(function* () {
        const loaded = current
        if (loaded.hooks["execute.after"].length === 0) return undefined
        if (result.diagnostics?.some((diagnostic) => NOT_RUN.has(diagnostic.code ?? ""))) return undefined
        const conversation = yield* about(api)
        const before = { output: textOf(result), error: result.isError === true }
        let shown = before
        for (const registered of [...loaded.hooks["execute.after"]]) {
          const event: ToolResult = {
            conversation: yield* handle(api.conversationId, conversation, registered.extension, loaded),
            call: call.id as never,
            tool: call.name,
            input: call.arguments,
            outcome: { ...shown },
          }
          const exit = yield* runHook(
            api.conversationId,
            registered.extension,
            "execute.after",
            Effect.suspend(() => registered.value(event)),
          )
          if (Exit.isFailure(exit)) continue
          shown = { output: String(event.outcome.output), error: event.outcome.error === true }
        }
        if (shown.output === before.output && shown.error === before.error) return undefined
        return {
          ...result,
          output: shown.output === "" ? [] : [{ type: "text" as const, text: shown.output }],
          isError: shown.error,
        }
      })

    const hooks = hook(ToolTask, { beforeTool, afterTool })

    /** Runs the transforms over `base`'s tools, then installs the edited base and the extensions' own tools. */
    const install = (transforms: ReadonlyArray<Registered<(tools: ToolEditor) => void>>, infos: ExtensionInfo[]) => {
      const origin = new Map<ExtensionTool, ToolRegistration>()
      const view = (tool: ToolRegistration): ExtensionTool => {
        const shown: ExtensionTool = {
          spec: { name: tool.name, description: tool.description, parameters: tool.parameters },
          readOnly: tool.asks !== true,
          run: () => Effect.succeed({ output: `${tool.name} runs only when the model calls it`, error: true }),
        }
        origin.set(shown, tool)
        return shown
      }
      const baseTools = base.flatMap((extension) => (extension.tools ?? []).map(view))
      let tools: ExtensionTool[] = baseTools
      const editor: ToolEditor = {
        list: () => tools,
        get: (name) => tools.find((tool) => tool.spec.name === name),
        add: (tool) => {
          tools = [...tools.filter((other) => other.spec.name !== tool.spec.name), tool]
        },
        update: (name, edit) => {
          tools = tools.map((tool) => {
            if (tool.spec.name !== name) return tool
            const edited = { description: tool.spec.description, readOnly: tool.readOnly }
            edit(edited)
            const next = { ...tool, spec: { ...tool.spec, description: edited.description }, readOnly: edited.readOnly }
            const from = origin.get(tool)
            if (from !== undefined) origin.set(next, from)
            return next
          })
        },
        remove: (name) => {
          tools = tools.filter((tool) => tool.spec.name !== name)
        },
      }
      // A transform that throws fails its extension, so none of that extension's edits may stay: run the others
      // again from the base tools, until a pass runs without a new failure.
      const failed = new Set<string>()
      let again = true
      while (again) {
        again = false
        tools = baseTools
        for (const transform of transforms) {
          if (failed.has(transform.extension)) continue
          try {
            transform.value(editor)
          } catch (error) {
            failed.add(transform.extension)
            const at = infos.findIndex((info) => info.name === transform.extension)
            infos[at] = {
              ...infos[at]!,
              state: "failed",
              message: `its tool transform failed: ${error instanceof Error ? error.message : String(error)}`,
            }
            again = true
            break
          }
        }
      }
      for (const extension of base) {
        const kept = new Set(extension.tools ?? [])
        const edited = tools.flatMap((tool) => {
          const from = origin.get(tool)
          if (from === undefined || !kept.has(from)) return []
          const { asks: _asks, ...rest } = from
          return [{ ...rest, description: tool.spec.description, ...(tool.readOnly ? {} : { asks: true as const }) }]
        })
        registry.install({ ...extension, tools: edited })
      }
      const added = tools.filter((tool) => !origin.has(tool)).map(fromExtensionTool)
      registry.install(defineExtension({ name: HOST, tools: added, hooks: [hooks] }))
      return failed
    }

    const loadAll = Effect.gen(function* () {
      forgetExtensions(home.extensions)
      const infos: Array<ExtensionInfo> = []
      const opened = new Map<string, Scope.Closeable>()
      const transforms: Array<Registered<(tools: ToolEditor) => void>> = []
      const next: Loaded = { infos, hooks: { "execute.before": [], "execute.after": [] } }
      const register = <A>(list: Array<Registered<A>>, entry: Registered<A>) =>
        Effect.andThen(
          Effect.sync(() => void list.push(entry)),
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              const at = list.indexOf(entry)
              if (at >= 0) list.splice(at, 1)
            }),
          ),
        )
      for (const planned of yield* planExtensions(home.dir, home.extensions)) {
        if ("info" in planned) {
          infos.push(planned.info)
          continue
        }
        const info = { name: planned.name, path: planned.path }
        const scope = yield* Scope.make()
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const define: Extension = yield* importExtension(planned.path)
            yield* define({
              name: planned.name,
              options: planned.options,
              tool: {
                transform: (edit) => register(transforms, { extension: planned.name, value: edit }),
                hook: (name, run) =>
                  register(next.hooks[name] as Array<Registered<typeof run>>, { extension: planned.name, value: run }),
              },
              // Shaping requests is ChatGPT's, which the kernel does not run yet.
              request: { hook: () => Effect.void },
            })
          }).pipe(Effect.timeout(LOAD_LIMIT), Scope.provide(scope)),
        )
        if (Exit.isSuccess(exit)) {
          opened.set(planned.name, scope)
          infos.push({ ...info, state: "loaded" })
        } else {
          yield* Scope.close(scope, exit)
          infos.push({ ...info, state: "failed", message: failureReason(exit.cause) })
        }
      }
      return { next, opened, transforms }
    })

    /** Loads every extension, swaps them in, clears every status line, and unloads the ones they replace. */
    const swap = Effect.gen(function* () {
      const { next, opened, transforms } = yield* loadAll
      const previous = scopes
      const failed = install(transforms, next.infos)
      // A transform that threw fails its extension, whose hooks then end with it.
      for (const name of failed) yield* Scope.close(opened.get(name)!, Exit.void)
      for (const name of failed) opened.delete(name)
      current = next
      scopes = [...opened.values()]
      yield* clearStatus
      yield* Effect.forEach(previous, (scope) => Scope.close(scope, Exit.void), { discard: true })
      return next.infos
    })

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true })),
    )
    // One at a time: a reload's swap must not interleave with another's.
    const lock = yield* Semaphore.make(1)
    yield* swap
    return {
      list: Effect.sync(() => current.infos),
      reload: lock.withPermits(1)(swap),
    }
  })
