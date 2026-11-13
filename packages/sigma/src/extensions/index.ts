// The extension host: the home's extensions, loaded from disk with the `@sigma/extension` API, and run as harness extensions. Their tool transforms edit sigma's own tool extensions once per load;
// `execute.before` and `execute.after` run as the tool task's `beforeTool` and `afterTool` hooks, and request hooks as the
// generation task's `beforeProviderRequest` on ChatGPT's requests; status lines are a
// committed conversation document the view carries, and toasts are `sigma.toast` entries.
import {
  defineExtension,
  GenerationTask,
  type Extension as HarnessExtension,
  type Harness,
  hook,
  type HookApi,
  type Registry,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolRegistration,
  ToolTask,
} from "@sigma/harness"
import { type ConversationId, defineDoc, type JsonObject, type Tx } from "@sigma/kernel"
import type { Api, Model } from "@sigma/models"
import { CHATGPT_API } from "@sigma/models/chatgpt"
import { rootConversation } from "@sigma/tools"
import { Cause, Effect, Exit, Scope, Semaphore } from "effect"
import type { ModelSelection } from "@sigma/protocol"
import { STATUS_LINES_KIND, TOAST_KIND } from "@sigma/protocol"
import type { Home } from "../home.ts"
import {
  type Extension,
  type ModelRequest,
  Refused,
  type ToolCall,
  type ToolEditor,
  type ToolFailures,
  type ToolHooks,
  type ToolResult,
} from "./api.ts"
import {
  type ExtensionInfo,
  failureReason,
  forgetExtensions,
  HOOK_LIMIT,
  importExtension,
  LOAD_LIMIT,
  planExtensions,
} from "./discover.ts"
import { serveSharedModules } from "./modules.ts"
import type { Tool as ExtensionTool } from "../tools/tool.ts"
import { lineageOf, wireId } from "../conversations.ts"
import { selectionOf } from "../providers.ts"

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
  kind: "sigma.status_shown",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: [] }),
  checkpointWhen: () => true,
})

/** The name the host's own harness extension takes: the extensions' added tools and their hooks. */
const HOST = "sigma-extensions"

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

type RequestHook = (request: ModelRequest) => Effect.Effect<void, unknown>

interface Loaded {
  readonly infos: Array<ExtensionInfo>
  readonly hooks: { readonly [Name in keyof ToolHooks]: Array<Registered<Hook<Name>>> }
  readonly requests: Array<Registered<RequestHook>>
}

/** What a request hook may change of a ChatGPT request body. */
interface ChatGptPayload {
  readonly instructions: string
  readonly tools: ReadonlyArray<{ readonly name: string }>
}

export interface Extensions {
  readonly list: Effect.Effect<ReadonlyArray<ExtensionInfo>>
  readonly reload: Effect.Effect<ReadonlyArray<ExtensionInfo>>
  /** The tool names the loaded extensions' transforms removed, including names of tools sigma does not have. */
  readonly removed: () => ReadonlyArray<string>
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
        env: { SIGMA_ROOT_CONVERSATION: String(root) },
        output: (text) => Effect.sync(() => api.output(text)),
      })
      return {
        output: outcome.output === "" ? [] : [{ type: "text", text: outcome.output }],
        isError: outcome.error,
      } satisfies ToolExecutionResult
    }),
})

/**
 * Loads the home's extensions into `registry`, over `base`, sigma's own tool extensions, which it installs edited by
 * the extensions' transforms. `harness` is read when a hook runs, after the Harness opened.
 */
export const openExtensions = (
  home: Home,
  registry: Registry,
  base: ReadonlyArray<HarnessExtension>,
  harness: () => Harness,
): Effect.Effect<Extensions, never, Scope.Scope> =>
  Effect.gen(function* () {
    serveSharedModules()
    let current: Loaded = { infos: [], hooks: { "execute.before": [], "execute.after": [] }, requests: [] }
    let scopes: ReadonlyArray<Scope.Closeable> = []
    let removed: ReadonlyArray<string> = []

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

    const handle = (conversation: ConversationId, about: About, extension: string, loaded: Loaded) =>
      Effect.map(
        Effect.all([wireId(harness(), conversation), lineageOf(harness(), conversation)]),
        ([id, lineage]) => ({
          id,
          cwd: about.cwd,
          model: about.model,
          ...(lineage === undefined ? {} : { lineage }),
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
        }),
      )

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
          model: agent === undefined ? { provider: "" } : selectionOf(agent),
        }),
      )

    /**
     * The input `execute.before` gave each call that it changed, by conversation and call, until its `execute.after`
     * runs: the harness hands `afterTool` the model's own arguments, and an extension's after hook must see what ran.
     */
    const rewritten = new Map<string, unknown>()
    const callKey = (conversation: ConversationId, call: ToolHookCall) => `${conversation}:${call.id}`

    const beforeTool = (call: ToolHookCall, api: { readonly conversationId: ConversationId }) =>
      Effect.gen(function* () {
        const loaded = current
        if (loaded.hooks["execute.before"].length === 0) return undefined
        const conversation = yield* about(api)
        let input: unknown = call.arguments
        for (const registered of [...loaded.hooks["execute.before"]]) {
          const event: ToolCall = {
            conversation: yield* handle(api.conversationId, conversation, registered.extension, loaded),
            call: call.id,
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
        if (JSON.stringify(input) === JSON.stringify(call.arguments)) return undefined
        rewritten.set(callKey(api.conversationId, call), input)
        return { arguments: input as JsonObject }
      })

    const afterTool = (
      call: ToolHookCall,
      result: ToolExecutionResult,
      api: { readonly conversationId: ConversationId },
    ) =>
      Effect.gen(function* () {
        const key = callKey(api.conversationId, call)
        const input = rewritten.has(key) ? rewritten.get(key) : call.arguments
        rewritten.delete(key)
        const loaded = current
        if (loaded.hooks["execute.after"].length === 0) return undefined
        if (result.diagnostics?.some((diagnostic) => NOT_RUN.has(diagnostic.code ?? ""))) return undefined
        const conversation = yield* about(api)
        const before = { output: textOf(result), error: result.isError === true }
        let shown = before
        for (const registered of [...loaded.hooks["execute.after"]]) {
          const event: ToolResult = {
            conversation: yield* handle(api.conversationId, conversation, registered.extension, loaded),
            call: call.id,
            tool: call.name,
            input,
            outcome: { ...shown },
          }
          const exit = yield* runHook(
            api.conversationId,
            registered.extension,
            "execute.after",
            Effect.suspend(() => registered.value(event)),
          )
          if (Exit.isFailure(exit)) continue
          const changed = { output: String(event.outcome.output), error: event.outcome.error === true }
          if (changed.output === shown.output && changed.error === shown.error) continue
          // A change the model never gets would vanish without a word, so the extension is told.
          if (result.final === true) {
            yield* toast(
              api.conversationId,
              registered.extension,
              `execute.after changed ${call.name}'s result, but the model gets ${call.name}'s own result`,
            )
          } else shown = changed
        }
        if (shown.output === before.output && shown.error === before.error) return undefined
        return {
          ...result,
          output: shown.output === "" ? [] : [{ type: "text" as const, text: shown.output }],
          isError: shown.error,
        }
      })

    /**
     * The request hooks over one ChatGPT request: each may add instructions, sent after the request's own, and narrow
     * the tools offered. A hook that fails is skipped with a toast. Only ChatGPT's requests are shaped.
     */
    const beforeProviderRequest = (request: { readonly model: Model<Api>; readonly payload: unknown }, api: HookApi) =>
      Effect.gen(function* () {
        const loaded = current
        if (loaded.requests.length === 0 || request.model.api !== CHATGPT_API) return undefined
        const payload = request.payload as ChatGptPayload
        const offered = payload.tools.map((tool) => tool.name)
        const conversation = yield* about(api)
        let instructions: ReadonlyArray<string> = []
        let tools = offered
        for (const registered of [...loaded.requests]) {
          const event: ModelRequest = {
            conversation: yield* handle(api.conversationId, conversation, registered.extension, loaded),
            instructions: [...instructions],
            tools: [...tools],
          }
          const exit = yield* runHook(
            api.conversationId,
            registered.extension,
            "request",
            Effect.suspend(() => registered.value(event)),
          )
          if (Exit.isFailure(exit)) continue
          instructions = event.instructions.map(String)
          tools = offered.filter((name) => event.tools.includes(name))
        }
        if (instructions.length === 0 && tools.length === offered.length) return undefined
        return {
          payload: {
            ...payload,
            instructions: payload.instructions + instructions.map((text) => `\n${text.trimEnd()}\n`).join(""),
            tools: payload.tools.filter((tool) => tools.includes(tool.name)),
          },
        }
      })

    const hooks = [hook(ToolTask, { beforeTool, afterTool }), hook(GenerationTask, { beforeProviderRequest })]

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
      let removed = new Set<string>()
      const editor: ToolEditor = {
        list: () => tools,
        get: (name) => tools.find((tool) => tool.spec.name === name),
        add: (tool) => {
          tools = [...tools.filter((other) => other.spec.name !== tool.spec.name), tool]
          removed.delete(tool.spec.name)
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
          removed.add(name)
        },
      }
      // A transform that throws fails its extension, so none of that extension's edits may stay: run the others
      // again from the base tools, until a pass runs without a new failure.
      const failed = new Set<string>()
      let again = true
      while (again) {
        again = false
        tools = baseTools
        removed = new Set()
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
      registry.install(defineExtension({ name: HOST, tools: added, hooks }))
      return { failed, removed: [...removed] }
    }

    const loadAll = Effect.gen(function* () {
      forgetExtensions(home.extensions)
      const infos: Array<ExtensionInfo> = []
      const opened = new Map<string, Scope.Closeable>()
      const transforms: Array<Registered<(tools: ToolEditor) => void>> = []
      const next: Loaded = { infos, hooks: { "execute.before": [], "execute.after": [] }, requests: [] }
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
              request: { hook: (run) => register(next.requests, { extension: planned.name, value: run }) },
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
      const { failed, removed: nowRemoved } = install(transforms, next.infos)
      removed = nowRemoved
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
      removed: () => removed,
    }
  })
