// One Claude Code process of a `claude.run` invocation: started through the Claude Agent SDK, fed the run's opening and
// its steers, and every frame it sends turned into commits. A call Claude Code runs itself is committed before its
// PreToolUse hook is answered, so the intent is durable before the effect; an extension's tool reached through nisse's
// MCP server runs as a `pi.tool` task; a question for a person waits on `nisse.approvals`; each subagent is a
// conversation of its own (F7).
import {
  createSdkMcpServer,
  type EffortLevel,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { copyJson } from "@nisse/delta/json"
import {
  type Agent,
  agentHooks,
  APPROVALS_KIND,
  ApprovalsDoc,
  appendToolResult,
  applyBoundary,
  approveAutomatically,
  AssistantEntry,
  CompactionEntry,
  finishSlot,
  LiveDoc,
  type LiveState,
  prepareBoundary,
  removeApproval,
  recordUsage,
  type TaskApi,
  ToolTask,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolHooks,
  type ToolTaskResult,
  UserEntry,
} from "@nisse/harness"
import type { Draft } from "@nisse/delta"
import type {
  AnyTask,
  ConversationId,
  EntryId,
  EntryRecord,
  JsonObject,
  NextTaskState,
  TaskId,
  TaskRuntime,
  Tx,
} from "@nisse/kernel"
import type { AssistantMessage, ToolCall, Usage } from "@nisse/models"
import { Cause, Deferred, Effect, Option, Semaphore, Stream } from "effect"
import { z } from "zod"
import { Inbox } from "./inbox.ts"
import type { SubagentLinks } from "./links.ts"
import { textOf } from "./retell.ts"
import { ClaudeSessionDoc } from "./session.ts"

/** How a Claude Code instance is started: its executable, environment and extra arguments. */
export interface ClaudeProcessSettings {
  /** Default: the SDK's bundled Claude Code. */
  readonly executable?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
}

/** Where a process starts in Claude Code's session. */
export type Start =
  | { readonly _tag: "fresh"; readonly session: string }
  | { readonly _tag: "resume"; readonly session: string; readonly at: string }
  /** A fork of a conversation whose parent held the session: a new session continuing the parent's at `at`. */
  | { readonly _tag: "fork"; readonly from: string; readonly at: string; readonly session: string }

/** How a process ended: the run answered, the session is gone, or Claude Code failed. */
export type Ended =
  | { readonly _tag: "answered"; readonly answer: EntryId | undefined; readonly turnLimit: boolean }
  | { readonly _tag: "gone" }
  | { readonly _tag: "failed"; readonly message: string }

export type ClaudeRunCheckpoint = { phase: "converse"; at?: string }

type Runtime = TaskRuntime<Record<string, never>, ClaudeRunCheckpoint, { entryId?: EntryId }>
type Next = NextTaskState<ClaudeRunCheckpoint, { entryId?: EntryId }>

/** What one process works with. */
export type ProcessContext = {
  readonly runtime: Runtime
  readonly api: TaskApi
  readonly agent: Agent
  readonly settings: ClaudeProcessSettings
  readonly links: SubagentLinks
  /** The task kind that holds a hosted subagent's run. */
  readonly subagentTask: AnyTask<any>
  /** Extensions whose tools Claude Code has its own of; the rest reach it through nisse's MCP server. */
  readonly builtinExtensions: ReadonlySet<string>
  /** The id of the conversation people started, for the `NISSE_ROOT_CONVERSATION` its commands see. */
  readonly rootConversation: string
}

/** The entry that places a hosted subagent's conversation in its parent's transcript. */
export const SUBAGENT_ENTRY_KIND = "nisse.subagent"

export type SubagentEntry = { call: string; conversation: number; title: string; agentType?: string }

/** One model's running totals in one Claude Code process, as it reports them (`modelUsage`). */
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

/** What a call Claude Code asked a person about gets when they deny it. */
export const DENIED = "the person did not allow this call"

const OWN_TOOL = "mcp__nisse__"
/** Claude Code's errors for a session it does not have, or a position its session does not hold (F12). */
const SESSION_GONE = /No conversation found|No message found with message\.uuid/

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const toolName = (name: string) => (name.startsWith(OWN_TOOL) ? name.slice(OWN_TOOL.length) : name)

const bundledExecutable = () => {
  for (const variant of ["", "-musl"]) {
    try {
      return Bun.resolveSync(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${variant}/claude`,
        import.meta.dir,
      )
    } catch {}
  }
  return "claude"
}

/** `--flag value`, `--flag=value` and bare `--flag` arguments as the SDK's `extraArgs`. */
const extraArgs = (args: ReadonlyArray<string>) => {
  const extra: Record<string, string | null> = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (!flag.startsWith("--")) continue
    const [name, joined] = flag.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    const next = args[i + 1]
    if (joined !== undefined) extra[name] = joined
    else if (next !== undefined && !next.startsWith("--")) extra[name] = args[++i]!
    else extra[name] = null
  }
  return extra
}

const userMessage = (texts: ReadonlyArray<string>, priority?: "next"): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: texts.map((text) => ({ type: "text" as const, text })) },
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: "",
  ...(priority ? { priority } : {}),
})

const toolUseOf = (extra: unknown) => {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta
  return meta?.["claudecode/toolUseId"] as string | undefined
}

/** A conversation the process writes to: the run's own, or a hosted subagent's. */
type Owner = {
  readonly conversationId: ConversationId
  /** The task that waits in this conversation: the run, or the subagent's lifecycle task; it keys its approvals. */
  readonly task: TaskId
  readonly main: boolean
  /** The response whose calls the conversation's slots show. */
  response?: string
}

/** A call seen in an assistant frame or a hook, before it is committed. */
type Sighting = { readonly call: ToolCall; readonly owner: Owner; readonly response: string; readonly at?: string }

const failure = (message: string): Ended => ({ _tag: "failed", message })

/** Runs one Claude Code process from `start` with `opening` as its first message, until the run ends. */
export const converse = (ctx: ProcessContext, start: Start, opening: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, api, agent, settings } = ctx
      const conversationId = runtime.conversationId
      const provider = agent.model?.provider ?? ""
      const modelId = agent.model?.modelId ?? ""
      const serial = yield* Semaphore.make(1)
      const main: Owner = { conversationId, task: runtime.taskId, main: true }
      const children = new Map<string, Owner>()
      const arrivals = new Map<string, Deferred.Deferred<void>>()
      const sightings = new Map<string, Deferred.Deferred<Sighting>>()
      const recorded = new Map<string, { readonly call: ToolCall; readonly owner: Owner }>()
      const answered = new Set<string>()
      const denied = new Set<string>()
      const awaitingReplay = new Set<string>()
      const inbox = new Inbox<SDKUserMessage>()
      let session = start.session
      let resetting = false
      let saidAnything = false
      let lastEntry: EntryId | undefined
      let partial = ""
      let flushedAt = 0
      // `modelUsage` at this process's previous result: a process reports its own running totals, which a resumed
      // session does not carry over (died_while_idle's second process reports a first turn's cache read again).
      let totals: Record<string, UsageTotals> | undefined

      const arrival = (agentId: string) => {
        let arrived = arrivals.get(agentId)
        if (!arrived) arrivals.set(agentId, (arrived = Deferred.makeUnsafe<void>()))
        return arrived
      }
      const sighting = (id: string) => {
        let seen = sightings.get(id)
        if (!seen) sightings.set(id, (seen = Deferred.makeUnsafe<Sighting>()))
        return seen
      }
      const sight = (seen: Sighting) => Deferred.succeed(sighting(seen.call.id), seen)

      // Own tools: those of extensions other than nisse's built-in ones, offered to Claude Code over MCP.
      const builtin = new Set(
        agent.extensions
          .filter((extension) => ctx.builtinExtensions.has(extension.name))
          .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
      )
      const own = new Map(agent.tools.filter((tool) => !builtin.has(tool.name)).map((tool) => [tool.name, tool]))
      const allToolHooks = agentHooks(agent, ToolTask.definition.name).map(({ extension, handlers }) => ({
        extension,
        handlers: handlers as Partial<ToolHooks>,
      }))
      const toolHooks = allToolHooks.filter(({ handlers }) => typeof handlers.beforeTool === "function")
      const afterHooks = allToolHooks.filter(({ handlers }) => typeof handlers.afterTool === "function")

      const abort = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const controller = new AbortController()
          const stop = () => controller.abort()
          runtime.signal.addEventListener("abort", stop, { once: true })
          return { controller, stop }
        }),
        ({ controller, stop }) =>
          Effect.gen(function* () {
            runtime.signal.removeEventListener("abort", stop)
            inbox.close()
            controller.abort()
            // A subagent lives in its process: one Claude Code did not say ended, such as one left in the background,
            // ends with it.
            for (const child of new Set(children.values())) {
              yield* Deferred.succeed(ctx.links.link(child.task).ended, {
                status: "stopped",
                summary: "Claude Code ended before the subagent did",
              })
            }
          }),
      )

      /** A commit returning nothing, or the checkpoint a moved position records as progress. */
      const commit = (body: (tx: Tx) => Effect.Effect<Next | undefined, unknown>) =>
        runtime.commit((tx) => body(tx) as Effect.Effect<Next | undefined, never>)

      /** Moves the position to `at`, through the entry `seen`, unless a sent message has not come back yet. */
      const position = (tx: Tx, at: string | undefined, seen: EntryId) =>
        Effect.gen(function* (): Generator<Effect.Effect<any, any, never>, Next | undefined, never> {
          lastEntry = seen
          if (at === undefined || awaitingReplay.size > 0 || resetting) return undefined
          const doc = yield* tx.doc(ClaudeSessionDoc, conversationId)
          doc.current = {
            conversation: Number(conversationId),
            provider,
            session,
            at,
            seen: Number(seen),
          }
          return { status: "running", checkpoint: { phase: "converse", at } }
        })

      const assistant = (content: AssistantMessage["content"], response: string, stop: "stop" | "toolUse") =>
        copyJson(
          {
            role: "assistant",
            content,
            api: "claude-code",
            provider,
            model: modelId,
            responseId: response,
            usage: ZERO_USAGE,
            stopReason: stop,
            timestamp: runtime.now(),
          },
          { omitUndefinedProperties: true },
        ) as unknown as JsonObject

      /** Starts a new response's slots: the calls of the response before it are done, so they go. */
      const respond = (live: Draft<LiveState>, owner: Owner, response: string) => {
        if (owner.response === response) return
        owner.response = response
        if (live.tools !== undefined) {
          live.tools = live.tools.filter((slot) => slot.status !== "done")
          if (live.tools.length === 0) delete live.tools
        }
      }

      /** Commits one text block of a response. */
      const recordText = (owner: Owner, text: string, response: string, at: string | undefined) =>
        commit((tx) =>
          Effect.gen(function* () {
            const live = yield* tx.doc(LiveDoc, owner.conversationId)
            respond(live, owner, response)
            const entry = yield* tx.appendEntry(AssistantEntry, owner.conversationId, {
              model: [assistant([{ type: "text", text }], response, "stop")],
            })
            if (!owner.main) return undefined
            partial = ""
            delete live.generation
            return yield* position(tx, at, entry.id)
          }),
        )

      /** Commits a call once, with the arguments it runs with; an own tool's call also gets its tool task. */
      const recordNow = (seen: Sighting, input: unknown) =>
        Effect.suspend(() => {
          const known = recorded.get(seen.call.id)
          if (known) return Effect.succeed({ ...known, task: undefined as TaskId<ToolTaskResult> | undefined })
          const call: ToolCall = { ...seen.call, arguments: (input ?? {}) as ToolCall["arguments"] }
          const { owner } = seen
          let task: TaskId<ToolTaskResult> | undefined
          return Effect.as(
            commit((tx) =>
              Effect.gen(function* () {
                const live = yield* tx.doc(LiveDoc, owner.conversationId)
                respond(live, owner, seen.response)
                const entry = yield* tx.appendEntry(AssistantEntry, owner.conversationId, {
                  model: [assistant([call], seen.response, "toolUse")],
                })
                if (own.has(call.name)) {
                  task = yield* tx.createTask(
                    ToolTask,
                    { kind: "model", assistant: entry.id, callId: call.id },
                    // Owned in the conversation the call is in, where the tool task finds it and adds its result.
                    { ownership: { kind: "task", taskId: owner.task }, abandonOnRestart: true },
                  )
                  answered.add(call.id)
                }
                // Assigned whole: a draft records an array it is given, not what is pushed to it afterwards.
                live.tools = [
                  ...(live.tools ?? []),
                  {
                    callId: call.id,
                    name: call.name,
                    status: "running",
                    ...(task === undefined ? {} : { taskId: task }),
                  },
                ]
                if (owner.main && live.run?.taskId === runtime.taskId && owner.response === seen.response) {
                  live.run.first ??= entry.id
                }
                return owner.main ? yield* position(tx, seen.at, entry.id) : undefined
              }),
            ),
            undefined,
          ).pipe(
            Effect.map(() => {
              recorded.set(call.id, { call, owner })
              return { call, owner, task }
            }),
          )
        })
      const record = (seen: Sighting, input: unknown = seen.call.arguments) =>
        serial.withPermits(1)(recordNow(seen, input))

      /** Commits a call's result as Claude Code reported it. */
      const recordResult = (owner: Owner, call: ToolCall, text: string, isError: boolean, at: string | undefined) =>
        commit((tx) =>
          Effect.gen(function* () {
            const entry = yield* appendToolResult(
              tx,
              owner.conversationId,
              call,
              { output: [{ type: "text", text }], isError },
              { timestamp: runtime.now() },
            )
            const live = yield* tx.doc(LiveDoc, owner.conversationId)
            const slot = live.tools?.find((each) => each.callId === call.id)
            if (slot !== undefined) {
              finishSlot(slot)
              slot.entry = entry.id
            }
            yield* removeApproval(tx, owner.conversationId, `${owner.task}/${call.id}`)
            return owner.main ? yield* position(tx, at, entry.id) : undefined
          }),
        )

      /** The call as sighted, waiting for the subagent that makes it to be hosted first. */
      const sighted = (call: ToolCall, agentId: string | undefined) =>
        Effect.gen(function* () {
          if (agentId !== undefined) {
            yield* Deferred.await(arrival(agentId))
            const owner = children.get(agentId)!
            yield* sight({ call, owner, response: owner.response ?? call.id })
          }
          return yield* Deferred.await(sighting(call.id))
        })

      const autoApproved = (owner: Owner) =>
        Effect.map(runtime.snapshot(ApprovalsDoc, owner.conversationId), (doc) => doc?.auto === true)

      /** Asks a person about the call in its conversation's `nisse.approvals`, and waits for the first answer. */
      const approve = (owner: Owner, call: ToolCall) =>
        Effect.scoped(
          Effect.gen(function* () {
            const key = `${owner.task}/${call.id}`
            yield* commit((tx) =>
              Effect.map(tx.doc(ApprovalsDoc, owner.conversationId), (doc) => {
                if (!Object.hasOwn(doc.requests, key)) {
                  doc.requests[key] = {
                    callId: call.id,
                    tool: call.name,
                    arguments: call.arguments as JsonObject,
                    at: runtime.now(),
                  }
                }
                return undefined
              }),
            )
            const watch = yield* api.watchDoc(ApprovalsDoc, owner.conversationId)
            if (watch === undefined) return yield* Effect.die(new Error(`${APPROVALS_KIND} is missing`))
            const now = watch.value.requests[key]?.answer
            if (now !== undefined) return now.allow
            const next = yield* watch.changes.pipe(
              Stream.map((change) => change.value.requests[key]?.answer),
              Stream.filter((answer) => answer !== undefined),
              Stream.runHead,
            )
            if (Option.isNone(next)) return yield* Effect.interrupt
            return next.value!.allow
          }),
        )

      /** The `beforeTool` chain of the conversation's extensions: the first block wins, otherwise arguments chain. */
      const beforeTool = (call: ToolHookCall) =>
        Effect.gen(function* () {
          let args = call.arguments as JsonObject
          for (const { extension, handlers } of toolHooks) {
            const decided = yield* Effect.exit(handlers.beforeTool!({ ...call, arguments: args }, api.hookApi))
            if (decided._tag === "Failure") {
              if (runtime.signal.aborted || Cause.hasInterruptsOnly(decided.cause)) {
                return yield* Effect.failCause(decided.cause)
              }
              const error = Cause.squash(decided.cause)
              api.report(error, { kind: "extension", extension })
              // A failing hook blocks the call, as in nisse's own tool task.
              return { block: error instanceof Error ? error.message : String(error) }
            }
            if (decided.value?.block !== undefined) return { block: decided.value.block }
            if (decided.value?.arguments !== undefined) args = decided.value.arguments
          }
          return { arguments: args }
        })

      const run = <A>(effect: Effect.Effect<A, unknown>, signal: AbortSignal | undefined) =>
        Effect.runPromise(effect, signal === undefined ? undefined : { signal })

      const preToolUse: HookCallback = async (input, _toolUseID, { signal }) => {
        if (input.hook_event_name !== "PreToolUse") return {}
        // An own tool's task runs the hooks and asks, as in nisse's own loop.
        if (own.has(toolName(input.tool_name)) && input.tool_name.startsWith(OWN_TOOL)) return {}
        const asked: ToolCall = {
          type: "toolCall",
          id: input.tool_use_id,
          name: toolName(input.tool_name),
          arguments: input.tool_input as ToolCall["arguments"],
        }
        return run(
          Effect.gen(function* () {
            const seen = yield* sighted(asked, input.agent_id)
            const checked = yield* beforeTool({ ...seen.call, arguments: asked.arguments })
            if ("block" in checked) {
              const { call, owner } = yield* record(seen, asked.arguments)
              answered.add(asked.id)
              const refused = `Tool call blocked: ${checked.block}`
              yield* serial.withPermits(1)(recordResult(owner, call, refused, true, undefined))
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: refused,
                },
              }
            }
            yield* record(seen, checked.arguments)
            return JSON.stringify(checked.arguments) === JSON.stringify(asked.arguments)
              ? {}
              : {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    updatedInput: checked.arguments as Record<string, unknown>,
                  },
                }
          }),
          signal,
        )
      }

      /**
       * The `afterTool` chain over what one of Claude Code's own tools returned, each hook given the result before it. A
       * failing hook is reported and leaves the result as it was.
       */
      const afterTool = (call: ToolHookCall, result: ToolExecutionResult) =>
        Effect.gen(function* () {
          let current = result
          for (const { extension, handlers } of afterHooks) {
            const changed = yield* Effect.exit(handlers.afterTool!(call, current, api.hookApi))
            if (changed._tag === "Failure") {
              if (runtime.signal.aborted || Cause.hasInterruptsOnly(changed.cause)) {
                return yield* Effect.failCause(changed.cause)
              }
              api.report(Cause.squash(changed.cause), { kind: "extension", extension })
            } else if (changed.value !== undefined) current = changed.value
          }
          return current
        })

      /**
       * Hands what Claude Code's own tool returned to the extensions' `afterTool`. Claude Code takes a changed output
       * only as the tool's own result object; for `Read`, whose object carries the file's text, nisse swaps that text
       * (F15). Another tool's change cannot reach Claude, and is reported as such.
       */
      const postToolUse: HookCallback = async (input, _toolUseID, { signal }) => {
        if (input.hook_event_name !== "PostToolUse" || input.tool_name.startsWith(OWN_TOOL)) return {}
        const response = input.tool_response as { type?: string; file?: { content?: unknown } } | string | undefined
        const read = typeof response === "object" && typeof response?.file?.content === "string"
        const text =
          typeof response === "string"
            ? response
            : read
              ? (response!.file!.content as string)
              : JSON.stringify(response)
        const call: ToolHookCall = {
          type: "toolCall",
          id: input.tool_use_id,
          name: input.tool_name,
          arguments: input.tool_input as ToolCall["arguments"],
        }
        const after = await run(afterTool(call, { output: [{ type: "text", text }] }), signal)
        const changed = textOf(after.output ?? [])
        if (changed === text) return {}
        if (!read) {
          api.report(new Error(`afterTool changed ${input.tool_name}'s result, but Claude Code keeps its own result`), {
            kind: "extension",
          })
          return {}
        }
        const updated = { ...(response as object), file: { ...(response as { file: object }).file, content: changed } }
        return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: updated } }
      }

      /** Claude Code's summary of its own compaction, mirrored as a compaction entry that starts a new context. */
      const postCompact: HookCallback = async (input, _toolUseID, { signal }) => {
        if (input.hook_event_name !== "PostCompact") return {}
        await run(
          serial.withPermits(1)(
            commit((tx) =>
              Effect.gen(function* () {
                const summary = { role: "user", content: input.compact_summary, timestamp: runtime.now() }
                const entry = yield* tx.appendEntry(CompactionEntry, conversationId, {
                  head: "self",
                  model: [summary as unknown as JsonObject],
                  data: { reason: input.trigger === "manual" ? "manual" : "threshold" },
                })
                lastEntry = entry.id
                // The session holds its compaction: only what comes after it is news to a resume.
                const doc = yield* tx.doc(ClaudeSessionDoc, conversationId)
                if (doc.current?.session === session) doc.current.seen = Number(entry.id)
                return undefined
              }),
            ),
          ),
          signal,
        )
        return {}
      }

      const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, { signal, toolUseID, agentID }) => {
        const allow = { behavior: "allow" as const, updatedInput: input, toolUseID }
        if (tool.startsWith(OWN_TOOL)) return allow
        const asked: ToolCall = {
          type: "toolCall",
          id: toolUseID,
          name: toolName(tool),
          arguments: input as ToolCall["arguments"],
        }
        const allowed = await run(
          Effect.gen(function* () {
            const seen = yield* sighted(asked, agentID)
            if (yield* autoApproved(seen.owner)) return true
            const { call, owner } = yield* record(seen, input)
            return yield* approve(owner, { ...call, arguments: input as ToolCall["arguments"] })
          }),
          signal,
        )
        if (allowed) return allow
        denied.add(toolUseID)
        return { behavior: "deny", message: DENIED, toolUseID }
      }

      const runOwn = (name: string) => async (input: unknown, extra: unknown) => {
        const id = toolUseOf(extra)
        const outcome = await run(
          Effect.gen(function* () {
            if (id === undefined) return { text: `Claude Code called ${name} without a call id`, isError: true }
            const seen = yield* Deferred.await(sighting(id))
            const { task } = yield* record(seen, input)
            if (task === undefined) return { text: `${name} is already running`, isError: true }
            const settled = yield* runtime.waitForTask(task)
            const outcome = settled.state.outcome
            // A subagent's result is in its own conversation, which only a commit reads; one that writes nothing is not stored.
            let entry: EntryRecord | undefined
            if (outcome.status === "completed" && outcome.result.kind === "model") {
              const id = outcome.result.entryId
              yield* commit((tx) => Effect.map(tx.entry(id), (found) => void (entry = found)))
            }
            const message = entry?.model?.[0] as { content?: unknown; isError?: boolean } | undefined
            return {
              text: message === undefined ? `${name} ended ${outcome.status}` : textOf(message.content),
              isError: message?.isError ?? true,
            }
          }),
          (extra as { signal?: AbortSignal } | undefined)?.signal,
        )
        return { content: [{ type: "text" as const, text: outcome.text }], isError: outcome.isError }
      }

      const mcpServers =
        own.size === 0
          ? {}
          : {
              nisse: createSdkMcpServer({
                name: "nisse",
                tools: [...own.values()].map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: z.fromJSONSchema(tool.parameters as z.core.JSONSchema.JSONSchema),
                  handler: runOwn(tool.name),
                })),
              }),
            }

      const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
        PreToolUse: [{ hooks: [preToolUse] }],
        PostCompact: [{ hooks: [postCompact] }],
        ...(afterHooks.length === 0 ? {} : { PostToolUse: [{ hooks: [postToolUse] }] }),
      }
      const effort =
        agent.thinkingLevel === "off" || agent.thinkingLevel === undefined ? undefined : agent.thinkingLevel
      const messages = query({
        prompt: inbox,
        options: {
          ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
          abortController: abort.controller,
          includePartialMessages: true,
          canUseTool,
          hooks,
          mcpServers,
          ...(own.size === 0 ? {} : { disallowedTools: [...own.keys()] }),
          settingSources: ["user", "project", "local"],
          extraArgs: { ...extraArgs(settings.args ?? []), "replay-user-messages": null },
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(agent.instructions === undefined ? {} : { append: agent.instructions }),
          },
          env: {
            ...process.env,
            ...settings.env,
            NISSE_ROOT_CONVERSATION: ctx.rootConversation,
            CLAUDE_AGENT_SDK_CLIENT_APP: "nisse",
          },
          ...(modelId === "" ? {} : { model: modelId }),
          ...(effort === undefined ? {} : { effort: effort as EffortLevel }),
          ...(agent.maxTurns === undefined ? {} : { maxTurns: agent.maxTurns }),
          ...(start._tag === "fresh" ? { sessionId: start.session } : {}),
          ...(start._tag === "resume" ? { resume: start.session, resumeSessionAt: start.at } : {}),
          ...(start._tag === "fork"
            ? { resume: start.from, resumeSessionAt: start.at, forkSession: true, sessionId: start.session }
            : {}),
          pathToClaudeCodeExecutable: settings.executable ?? bundledExecutable(),
        },
      })

      const send = (texts: ReadonlyArray<string>, priority?: "next") => {
        const message = userMessage(texts, priority)
        awaitingReplay.add(message.uuid!)
        inbox.push(message)
      }
      send(opening)

      /** Places the steers waiting in the inbox after a round of results, and hands them to Claude Code. */
      const steer = commit((tx) =>
        Effect.gen(function* () {
          const boundary = yield* prepareBoundary(tx, conversationId, api.settings())
          const texts = new Map(
            boundary.inbox.items.flatMap((item) =>
              item.mode === "steer" ? [[item.id, textOf(item.content as unknown)] as const] : [],
            ),
          )
          const { users } = yield* applyBoundary(tx, boundary, "postTools", runtime.now())
          if (users.length === 0) return undefined
          const live = yield* tx.doc(LiveDoc, conversationId)
          if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users)
          send(
            users.flatMap((id) => [texts.get(id) ?? ""]).filter((text) => text !== ""),
            "next",
          )
          return undefined
        }),
      )

      /** Adds what the process spent since its last result to `pi.usage`, keyed by provider and model (F16). */
      const spent = (
        modelUsage: Record<
          string,
          {
            inputTokens: number
            outputTokens: number
            cacheReadInputTokens: number
            cacheCreationInputTokens: number
            costUSD: number
          }
        >,
      ) =>
        commit((tx) =>
          Effect.gen(function* () {
            const before = totals ?? {}
            const now: Record<string, UsageTotals> = {}
            for (const [model, usage] of Object.entries(modelUsage)) {
              now[model] = {
                input: usage.inputTokens,
                output: usage.outputTokens,
                cacheRead: usage.cacheReadInputTokens,
                cacheWrite: usage.cacheCreationInputTokens,
                cost: usage.costUSD,
              }
            }
            for (const [model, total] of Object.entries(now)) {
              const previous = before[model]
              // A total that went down started over, as after `/clear`.
              const continues =
                previous !== undefined &&
                (["input", "output", "cacheRead", "cacheWrite", "cost"] as const).every(
                  (key) => total[key] >= previous[key],
                )
              const base = continues ? previous : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
              const added: Usage = {
                input: total.input - base.input,
                output: total.output - base.output,
                cacheRead: total.cacheRead - base.cacheRead,
                cacheWrite: total.cacheWrite - base.cacheWrite,
                totalTokens:
                  total.input +
                  total.output +
                  total.cacheRead +
                  total.cacheWrite -
                  (base.input + base.output + base.cacheRead + base.cacheWrite),
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.cost - base.cost },
              }
              if (added.totalTokens > 0 || added.cost.total > 0) {
                yield* recordUsage(tx, conversationId, "models", `${provider}/${model}`, added)
              }
            }
            totals = now
            return undefined
          }),
        )

      /** Hosts a subagent Claude Code started as a conversation of its own, owned by the run or its parent subagent. */
      const host = (frame: {
        task_id: string
        tool_use_id: string
        description: string
        subagent_type?: string
        prompt?: string
        parent_task_id?: string
      }) =>
        Effect.gen(function* () {
          const parent = (frame.parent_task_id === undefined ? undefined : children.get(frame.parent_task_id)) ?? main
          const auto = yield* autoApproved(main)
          let hosted: { conversation: ConversationId; task: TaskId } | undefined
          yield* commit((tx) =>
            Effect.gen(function* () {
              const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: parent.task } })
              const task = yield* tx.createTask(
                ctx.subagentTask,
                { call: frame.tool_use_id, title: frame.description },
                { ownership: { kind: "conversation" }, conversationId: created.id, abandonOnRestart: true },
              )
              hosted = { conversation: created.id, task }
              const live = yield* tx.doc(LiveDoc, created.id)
              live.run = { taskId: task, inputs: [], turns: 0 }
              if (auto) yield* approveAutomatically(tx, created.id)
              const prompt = { role: "user", content: frame.prompt ?? "", timestamp: runtime.now() }
              yield* tx.appendEntry(UserEntry, created.id, { model: [prompt as unknown as JsonObject] })
              const data: SubagentEntry = {
                call: frame.tool_use_id,
                conversation: Number(created.id),
                title: frame.description,
                ...(frame.subagent_type === undefined ? {} : { agentType: frame.subagent_type }),
              }
              yield* tx.appendEntry(parent.conversationId, { kind: SUBAGENT_ENTRY_KIND, data })
              return undefined
            }),
          )
          const child: Owner = { conversationId: hosted!.conversation, task: hosted!.task, main: false }
          ctx.links.link(child.task).stop = () => messages.stopTask(frame.task_id)
          children.set(frame.tool_use_id, child)
          children.set(frame.task_id, child)
          yield* Deferred.succeed(arrival(frame.task_id), undefined)
        })

      const endings = { completed: "completed", failed: "failed", stopped: "stopped", killed: "stopped" } as const

      /** Commits the partial text of the response Claude Code is writing, at most every `partialIntervalMs`. */
      const say = (text: string) =>
        Effect.suspend(() => {
          partial += text
          const now = runtime.now()
          if (now - flushedAt < api.settings().progress.partialIntervalMs) return Effect.void
          flushedAt = now
          const message = assistant([{ type: "text", text: partial }], "partial", "stop")
          return Effect.asVoid(
            commit((tx) =>
              Effect.map(tx.doc(LiveDoc, conversationId), (live) => {
                live.generation = { attempt: 1, message: message as never }
                return undefined
              }),
            ),
          )
        })

      const handle = (message: SDKMessage): Effect.Effect<Ended | undefined, unknown> =>
        Effect.gen(function* () {
          if (resetting && "session_id" in message && message.session_id && message.session_id !== session) {
            session = message.session_id
            resetting = false
          }
          switch (message.type) {
            case "stream_event": {
              const event = message.event
              if (
                message.parent_tool_use_id === null &&
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                saidAnything = true
                yield* say(event.delta.text)
              }
              return undefined
            }
            case "assistant": {
              const content = message.message.content
              const response = message.message.id
              if (message.parent_tool_use_id !== null) {
                const child = children.get(message.parent_tool_use_id)
                if (!child) return undefined
                for (const block of content) {
                  if (block.type === "text") yield* recordText(child, block.text, response, undefined)
                  else if (block.type === "tool_use")
                    yield* sight({
                      call: {
                        type: "toolCall",
                        id: block.id,
                        name: toolName(block.name),
                        arguments: block.input as ToolCall["arguments"],
                      },
                      owner: child,
                      response,
                    })
                }
                return undefined
              }
              if (message.error) {
                const text = content.map((block) => (block.type === "text" ? block.text : "")).join("")
                return failure(text || `Claude Code failed: ${message.error}`)
              }
              saidAnything = true
              for (const block of content) {
                if (block.type === "text") yield* recordText(main, block.text, response, message.uuid)
                else if (block.type === "tool_use") {
                  yield* sight({
                    call: {
                      type: "toolCall",
                      id: block.id,
                      name: toolName(block.name),
                      arguments: block.input as ToolCall["arguments"],
                    },
                    owner: main,
                    response,
                    at: message.uuid,
                  })
                }
              }
              return undefined
            }
            case "user": {
              if ("isReplay" in message && message.isReplay) {
                awaitingReplay.delete(message.uuid)
                return undefined
              }
              if (!Array.isArray(message.message.content)) return undefined
              const bySubagent = message.parent_tool_use_id !== null
              let anyResult = false
              for (const block of message.message.content) {
                if (block.type !== "tool_result") continue
                const id = block.tool_use_id
                if (answered.has(id)) {
                  anyResult = true
                  continue
                }
                if (!Deferred.isDoneUnsafe(sighting(id))) continue
                const seen = yield* Deferred.await(sighting(id))
                const { call, owner } = yield* recordNow(seen, seen.call.arguments)
                anyResult = true
                answered.add(id)
                yield* recordResult(
                  owner,
                  call,
                  textOf(block.content),
                  block.is_error === true,
                  message.uuid && !bySubagent ? message.uuid : undefined,
                )
              }
              if (anyResult && !bySubagent) yield* steer
              return undefined
            }
            case "system": {
              if (message.subtype === "task_started" && message.tool_use_id && message.task_type === "local_agent") {
                if (Deferred.isDoneUnsafe(sighting(message.tool_use_id))) {
                  yield* recordNow(yield* Deferred.await(sighting(message.tool_use_id)), undefined)
                }
                yield* host({
                  task_id: message.task_id,
                  tool_use_id: message.tool_use_id,
                  description: message.description,
                  ...(message.subagent_type === undefined ? {} : { subagent_type: message.subagent_type }),
                  ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
                  ...(message.parent_task_id === undefined ? {} : { parent_task_id: message.parent_task_id }),
                })
              } else if (message.subtype === "task_notification" && message.tool_use_id) {
                const child = children.get(message.tool_use_id)
                if (child !== undefined) {
                  const status = endings[message.status as keyof typeof endings] ?? "failed"
                  // Claude Code reports a subagent's final answer only here, so it becomes the answer in its conversation.
                  if (status === "completed" && message.summary) {
                    yield* recordText(child, message.summary, `${message.task_id}/summary`, undefined)
                  }
                  yield* Deferred.succeed(ctx.links.link(child.task).ended, {
                    status,
                    ...(message.summary === undefined ? {} : { summary: message.summary }),
                  })
                }
              }
              return undefined
            }
            case "conversation_reset": {
              // `/clear`: the session goes on under the id the next frames carry (F13); a new context starts.
              resetting = true
              yield* commit((tx) =>
                Effect.map(tx.appendEntry(conversationId, { kind: "pi.reset", head: "self" }), (entry) => {
                  lastEntry = entry.id
                  return undefined
                }),
              )
              return undefined
            }
            case "result": {
              if (message.subtype !== "success" || message.is_error) {
                const errors = "errors" in message ? message.errors : []
                if (!saidAnything && errors.some((error) => SESSION_GONE.test(error))) return { _tag: "gone" }
                const text = "result" in message && message.result ? message.result : errors.join("; ")
                return failure(text || `Claude Code stopped: ${message.subtype}`)
              }
              yield* spent(message.modelUsage)
              if (awaitingReplay.size > 0) return undefined
              return {
                _tag: "answered",
                answer: lastEntry,
                turnLimit: (message as { terminal_reason?: string }).terminal_reason === "max_turns",
              }
            }
            default:
              return undefined
          }
        })

      const iterator = messages[Symbol.asyncIterator]()
      for (;;) {
        const next = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            runtime.signal.aborted
              ? Effect.interrupt
              : Effect.succeed({
                  done: true as const,
                  value: failure(`Claude Code stopped: ${error instanceof Error ? error.message : String(error)}`),
                }),
          ),
        )
        if (next.done) {
          if (runtime.signal.aborted) return yield* Effect.interrupt
          return next.value ?? failure("Claude Code exited before the turn finished")
        }
        const ended = yield* serial.withPermits(1)(handle(next.value))
        if (ended !== undefined) return ended
      }
    }),
  )
