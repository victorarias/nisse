import type { Conversation, ConversationId, ExtensionInfo } from "@nisse/protocol"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { readHomeConfig } from "../config.ts"
import type { Home } from "../home.ts"
import type { Call } from "../provider.ts"
import { Store } from "../store.ts"
import type { Tool, ToolOutcome } from "../tools/tool.ts"
import {
  Refused,
  type ConversationHandle,
  type Extension,
  type ToolCall,
  type ToolEditor,
  type ToolFailures,
  type ToolHooks,
  type ToolResult,
} from "./api.ts"
import { serveSharedModules } from "./modules.ts"

const LOAD_LIMIT = "10 seconds"
const HOOK_LIMIT = "10 seconds"
const NAME = /^[A-Za-z0-9_-]+$/

interface Registered<A> {
  readonly extension: string
  readonly value: A
}

type Hook<Name extends keyof ToolHooks> = (event: ToolHooks[Name]) => Effect.Effect<void, ToolFailures[Name]>

export interface ToolSet {
  readonly tools: ReadonlyArray<Tool>
  readonly added: ReadonlyArray<Tool>
  readonly removed: ReadonlyArray<string>
}

interface Loaded {
  readonly infos: ReadonlyArray<ExtensionInfo>
  readonly scopes: ReadonlyArray<Scope.Closeable>
  readonly transforms: Array<Registered<(tools: ToolEditor) => void>>
  readonly hooks: { readonly [Name in keyof ToolHooks]: Array<Registered<Hook<Name>>> }
}

interface Found {
  readonly name: string
  readonly path: string
}

const found = (dir: string): ReadonlyArray<Found> =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .flatMap((entry) => {
          const path = join(dir, entry)
          if (entry.endsWith(".ts") && statSync(path).isFile()) return [{ name: entry.slice(0, -".ts".length), path }]
          const index = join(path, "index.ts")
          return statSync(path).isDirectory() && existsSync(index) ? [{ name: entry, path: index }] : []
        })
    : []

const reason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

const forget = (dir: string) => {
  for (const path of Object.keys(require.cache)) if (path.startsWith(`${dir}/`)) delete require.cache[path]
}

export class Extensions extends Context.Service<
  Extensions,
  {
    readonly list: Effect.Effect<ReadonlyArray<ExtensionInfo>>
    readonly reload: Effect.Effect<ReadonlyArray<ExtensionInfo>>
    readonly tools: (conversation: Conversation, base: ReadonlyArray<Tool>) => Effect.Effect<ToolSet>
    readonly before: (conversation: Conversation, call: Call) => Effect.Effect<Call | { readonly refused: string }>
    readonly after: (
      conversation: Conversation,
      call: Call,
      outcome: ToolOutcome,
      changeable: boolean,
    ) => Effect.Effect<ToolOutcome>
  }
>()("nisse/Extensions") {
  static readonly layer = (home: Home) =>
    Layer.effect(
      Extensions,
      Effect.gen(function* () {
        serveSharedModules()
        const store = yield* Store

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

        const clearStatus = () => {
          for (const id of store.showingStatus()) {
            for (const name of Object.keys(store.extensionStatus(id))) {
              store.commit(id, { extensionStatus: { extension: name } })
            }
          }
        }

        const handle = (conversation: Conversation, extension: string, loaded: Loaded): ConversationHandle => ({
          id: conversation.id,
          cwd: conversation.cwd,
          model: conversation.model,
          ...(conversation.lineage === undefined ? {} : { lineage: conversation.lineage }),
          status: (text) =>
            Effect.sync(() => {
              const line = text === "" ? undefined : text
              if (loaded !== current || store.extensionStatus(conversation.id)[extension] === line) return
              store.commit(conversation.id, {
                extensionStatus: line === undefined ? { extension } : { extension, text: line },
              })
            }),
          toast: (text) => toast(conversation.id, extension, text),
        })

        const toast = (conversation: ConversationId, extension: string, text: string) =>
          Effect.sync(
            () =>
              void store.commit(conversation, {
                entries: [{ author: { _tag: "nisse" }, body: { _tag: "toast", extension, text } }],
              }),
          )

        const load = (into: Loaded, scope: Scope.Closeable, extension: Found, options: Record<string, unknown>) =>
          Effect.gen(function* () {
            const module = yield* Effect.tryPromise(() => import(extension.path))
            const define = module.default as Extension | undefined
            if (typeof define !== "function") {
              return yield* Effect.fail(new Error("it exports no extension; export default Extension.define(...)"))
            }
            yield* define({
              name: extension.name,
              options,
              tool: {
                transform: (edit) => register(into.transforms, { extension: extension.name, value: edit }),
                hook: (name, run) =>
                  register(into.hooks[name] as Array<Registered<typeof run>>, {
                    extension: extension.name,
                    value: run,
                  }),
              },
            })
          }).pipe(Effect.timeout(LOAD_LIMIT), Scope.provide(scope))

        const loadAll = Effect.gen(function* () {
          forget(home.extensions)
          const config = yield* Effect.result(readHomeConfig(home.dir))
          const loaded: Array<ExtensionInfo> = []
          const opened: Array<Scope.Closeable> = []
          const next: Loaded = {
            infos: loaded,
            scopes: opened,
            transforms: [],
            hooks: { "execute.before": [], "execute.after": [] },
          }
          for (const extension of found(home.extensions)) {
            const info = { name: extension.name, path: extension.path }
            if (config._tag === "Failure") {
              loaded.push({ ...info, state: "failed", message: `${config.failure.path}: ${config.failure.message}` })
              continue
            }
            const { enabled, ...options } = config.success.extensions?.[extension.name] ?? {}
            if (enabled === false) {
              loaded.push({ ...info, state: "disabled" })
              continue
            }
            if (!NAME.test(extension.name) || loaded.some((other) => other.name === extension.name)) {
              loaded.push({
                ...info,
                state: "failed",
                message: NAME.test(extension.name)
                  ? `another extension is named ${extension.name}`
                  : "an extension's name may use only letters, digits, - and _",
              })
              continue
            }
            const scope = yield* Scope.make()
            const exit = yield* Effect.exit(load(next, scope, extension, options))
            if (Exit.isSuccess(exit)) {
              opened.push(scope)
              loaded.push({ ...info, state: "loaded" })
            } else {
              yield* Scope.close(scope, exit)
              loaded.push({ ...info, state: "failed", message: reason(exit.cause) })
            }
          }
          return next
        })

        const unload = (loaded: Loaded) =>
          Effect.forEach(loaded.scopes, (scope) => Scope.close(scope, Exit.void), { discard: true })

        clearStatus()
        let current = yield* loadAll
        yield* Effect.addFinalizer(() => Effect.suspend(() => unload(current)))

        const hookFailed = (
          conversation: ConversationId,
          extension: string,
          hook: string,
          cause: Cause.Cause<unknown>,
        ) => toast(conversation, extension, `${hook} failed: ${reason(cause)}`)

        const runHook = <E>(
          conversation: ConversationId,
          extension: string,
          hook: string,
          run: Effect.Effect<void, E>,
        ) =>
          Effect.exit(Effect.timeout(run, HOOK_LIMIT)).pipe(
            Effect.tap((exit) =>
              Exit.isFailure(exit) && refusalOf(exit.cause) === undefined
                ? hookFailed(conversation, extension, hook, exit.cause)
                : Effect.void,
            ),
          )

        return Extensions.of({
          list: Effect.sync(() => current.infos),
          reload: Effect.gen(function* () {
            const next = yield* loadAll
            const previous = current
            yield* Effect.sync(() => {
              current = next
              clearStatus()
            })
            yield* unload(previous)
            return next.infos
          }),
          tools: (conversation, base) =>
            Effect.gen(function* () {
              let tools = [...base]
              let added = new Set<string>()
              let removed = new Set<string>()
              const editor: ToolEditor = {
                list: () => tools,
                get: (name) => tools.find((tool) => tool.spec.name === name),
                add: (tool) => {
                  tools = [...tools.filter((other) => other.spec.name !== tool.spec.name), tool]
                  added.add(tool.spec.name)
                  removed.delete(tool.spec.name)
                },
                update: (name, edit) => {
                  tools = tools.map((tool) => {
                    if (tool.spec.name !== name) return tool
                    const edited = { description: tool.spec.description, readOnly: tool.readOnly }
                    edit(edited)
                    return {
                      ...tool,
                      spec: { ...tool.spec, description: edited.description },
                      readOnly: edited.readOnly,
                    }
                  })
                },
                remove: (name) => {
                  tools = tools.filter((tool) => tool.spec.name !== name)
                  added.delete(name)
                  removed.add(name)
                },
              }
              for (const transform of [...current.transforms]) {
                const before = { tools, added: new Set(added), removed: new Set(removed) }
                try {
                  transform.value(editor)
                } catch (error) {
                  tools = before.tools
                  added = before.added
                  removed = before.removed
                  yield* toast(
                    conversation.id,
                    transform.extension,
                    `its tool transform failed: ${error instanceof Error ? error.message : String(error)}`,
                  )
                }
              }
              return {
                tools,
                added: tools.filter((tool) => added.has(tool.spec.name)),
                removed: [...removed],
              }
            }),
          before: (conversation, call) =>
            Effect.gen(function* () {
              let input = call.input
              const loaded = current
              for (const registered of [...loaded.hooks["execute.before"]]) {
                const event: ToolCall = {
                  conversation: handle(conversation, registered.extension, loaded),
                  call: call.call,
                  tool: call.tool,
                  input: structuredClone(input),
                }
                const exit = yield* runHook(
                  conversation.id,
                  registered.extension,
                  "execute.before",
                  Effect.suspend(() => registered.value(event)),
                )
                if (Exit.isFailure(exit)) {
                  const refusal = refusalOf(exit.cause)
                  return {
                    refused: `${registered.extension} refused this call: ${refusal ?? `it failed: ${reason(exit.cause)}`}`,
                  }
                }
                input = event.input
              }
              return JSON.stringify(input) === JSON.stringify(call.input) ? call : { ...call, input }
            }),
          after: (conversation, call, outcome, changeable) =>
            Effect.gen(function* () {
              let shown = outcome
              const loaded = current
              for (const registered of [...loaded.hooks["execute.after"]]) {
                const event: ToolResult = {
                  conversation: handle(conversation, registered.extension, loaded),
                  call: call.call,
                  tool: call.tool,
                  input: call.input,
                  outcome: { ...shown },
                }
                const exit = yield* runHook(
                  conversation.id,
                  registered.extension,
                  "execute.after",
                  Effect.suspend(() => registered.value(event)),
                )
                if (Exit.isFailure(exit)) continue
                const changed = { output: String(event.outcome.output), error: event.outcome.error === true }
                if (changeable) shown = changed
                else if (changed.output !== shown.output || changed.error !== shown.error) {
                  yield* toast(
                    conversation.id,
                    registered.extension,
                    `execute.after changed ${call.tool}'s result, but Claude Code keeps its own tools' results`,
                  )
                }
              }
              return shown
            }),
        })
      }),
    )
}

const refusalOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause)
  return error._tag === "Some" && error.value instanceof Refused ? error.value.message : undefined
}
