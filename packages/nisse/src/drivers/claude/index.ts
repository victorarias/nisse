import {
  createSdkMcpServer,
  query,
  type EffortLevel,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { CallId, Entry } from "@nisse/protocol"
import { tmpdir } from "node:os"
import { Deferred, Effect, Semaphore, type Scope } from "effect"
import { z } from "zod"
import { toolEnv, type Tool } from "../../tools/index.ts"
import { failed, type ToolOutcome } from "../../tools/tool.ts"
import {
  nothingOfItsOwn,
  ProviderError,
  type Call,
  type Driver,
  type Hosted,
  type Saved,
  type Turn,
} from "../../provider.ts"
import { Inbox } from "./inbox.ts"
import { probe, type Probed } from "./probe.ts"

export interface ClaudeOptions {
  readonly executable?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
}

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

const RETOLD_CHARACTERS = 64_000

interface ClaudeState {
  readonly session: string
  readonly at: string
}

type Start = { readonly _tag: "fresh"; readonly session: string } | ({ readonly _tag: "resume" } & ClaudeState)

const JOINING =
  "This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it."
const DENIED = "the person did not allow this call"
const OWN_TOOL = "mcp__nisse__"
const SESSION_GONE = /No conversation found/

const failure = (message: string) => new ProviderError({ message })

const endings = { completed: "answered", failed: "failed", stopped: "interrupted" } as const

const isClaudeState = (state: unknown): state is ClaudeState =>
  typeof state === "object" &&
  state !== null &&
  typeof (state as ClaudeState).session === "string" &&
  typeof (state as ClaudeState).at === "string"

const toolsByCall = (transcript: ReadonlyArray<Entry>) =>
  new Map(transcript.flatMap((entry) => (entry.body._tag === "tool_call" ? [[entry.body.call, entry.body.tool]] : [])))

const unseen = (transcript: ReadonlyArray<Entry>, seenThrough: number) => {
  const tools = toolsByCall(transcript)
  return transcript.flatMap((entry): Array<string> => {
    if (entry.seq <= seenThrough) return []
    const body = entry.body
    switch (body._tag) {
      case "user":
        return [body.text]
      case "message":
        return [`You were cut off after writing: ${body.text}`]
      case "tool_result":
        return [`Your ${tools.get(body.call) ?? "tool"} call ${body.call} was cut off: ${body.output}`]
      default:
        return []
    }
  })
}

const retold = (transcript: ReadonlyArray<Entry>) => {
  const results = new Map(
    transcript.flatMap((entry) => (entry.body._tag === "tool_result" ? [[entry.body.call, entry.body.output]] : [])),
  )
  return transcript.map((entry): string | undefined => {
    const body = entry.body
    switch (body._tag) {
      case "user":
        return body.text
      case "message":
        return `You answered: ${body.text}`
      case "tool_call":
        return `You called ${body.tool} with ${JSON.stringify(body.input)} and got: ${results.get(body.call) ?? "no result"}`
      default:
        return undefined
    }
  })
}

const history = (transcript: ReadonlyArray<Entry>): Array<string> => {
  const told = retold(transcript)
  const current = transcript.findLastIndex((entry) => entry.body._tag !== "user") + 1
  const asked = told.slice(current).filter((text) => text !== undefined)
  const first = transcript.findIndex((entry) => entry.body._tag === "user")
  if (first < 0 || first >= current) return [...told.slice(0, current).filter((text) => text !== undefined), ...asked]
  const opening = told[first]!
  let room = RETOLD_CHARACTERS - opening.length - asked.reduce((total, text) => total + text.length, 0)
  let start = current
  while (start > first + 1) {
    const text = told[start - 1]
    if (text !== undefined && text.length > room) break
    room -= text?.length ?? 0
    start--
  }
  const kept = told.slice(start, current).filter((text) => text !== undefined)
  const skipped = told.slice(first + 1, start).filter((text) => text !== undefined).length
  return [opening, ...(skipped > 0 ? [`(${skipped} entries left out here)`] : []), ...kept, ...asked]
}

const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : ""

const toolName = (name: string) => (name.startsWith(OWN_TOOL) ? name.slice(OWN_TOOL.length) : name)

const toolUseOf = (extra: unknown) => {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta
  return meta?.["claudecode/toolUseId"] as CallId | undefined
}

interface Sighting {
  readonly call: Call
  readonly owner: Turn
  readonly at?: string
}

const userMessage = (texts: ReadonlyArray<string>, priority?: "next"): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: texts.map((text) => ({ type: "text" as const, text })) },
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: "",
  ...(priority ? { priority } : {}),
})

export const claudeDriver = (options: ClaudeOptions): Driver => {
  const executable = options.executable ?? bundledExecutable()
  const env = options.env ?? {}
  const probing = Semaphore.makeUnsafe(1)
  let probed: Probed | undefined
  const probedNow = (refresh: boolean) =>
    probing.withPermits(1)(
      Effect.suspend(() =>
        probed && !refresh
          ? Effect.succeed(probed)
          : Effect.tap(probe({ executable, env }), (found) => Effect.sync(() => (probed = found))),
      ),
    )

  const converse = (turn: Turn, start: Start, opening: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const serial = yield* Semaphore.make(1)
      const children = new Map<string, Hosted>()
      const arrivals = new Map<string, Deferred.Deferred<void>>()
      const arrival = (agent: string) => {
        let arrived = arrivals.get(agent)
        if (!arrived) arrivals.set(agent, (arrived = Deferred.makeUnsafe<void>()))
        return arrived
      }
      const sightings = new Map<string, Deferred.Deferred<Sighting>>()
      const sighting = (call: string) => {
        let seen = sightings.get(call)
        if (!seen) sightings.set(call, (seen = Deferred.makeUnsafe<Sighting>()))
        return seen
      }
      const sight = (seen: Sighting) => Deferred.succeed(sighting(seen.call.call), seen)
      const calls = new Map<string, Call>()
      const answered = new Set<string>()
      const denied = new Set<string>()
      const own = new Map(turn.addedTools.map((tool) => [tool.spec.name, tool]))
      const awaitingReplay = new Set<string>()
      const inbox = new Inbox<SDKUserMessage>()
      const abort = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (abort) =>
          Effect.sync(() => {
            inbox.close()
            abort.abort()
          }),
      )
      let saidAnything = false

      const send = (texts: ReadonlyArray<string>, priority?: "next") => {
        const message = userMessage(texts, priority)
        awaitingReplay.add(message.uuid!)
        inbox.push(message)
      }
      const saved = (at: string | undefined): Saved | undefined =>
        at !== undefined && awaitingReplay.size === 0
          ? { state: { session: start.session, at } satisfies ClaudeState }
          : undefined
      const recordNow = (seen: Sighting, input: unknown) =>
        Effect.suspend(() => {
          const known = calls.get(seen.call.call)
          if (known) return Effect.succeed(known)
          const call = { ...seen.call, input }
          calls.set(call.call, call)
          return Effect.as(seen.owner.recordCall(call, seen.owner === turn ? saved(seen.at) : undefined), call)
        })
      const record = (seen: Sighting, input = seen.call.input) => serial.withPermits(1)(recordNow(seen, input))
      const recordIfSighted = (id: string) =>
        Deferred.isDoneUnsafe(sighting(id))
          ? Effect.flatMap(Deferred.await(sighting(id)), (seen) =>
              Effect.map(recordNow(seen, seen.call.input), (call) => ({ seen, call })),
            )
          : Effect.succeed(undefined)
      const sighted = (call: Call, agent: string | undefined) =>
        Effect.gen(function* () {
          if (agent !== undefined) {
            yield* Deferred.await(arrival(agent))
            yield* sight({ call, owner: children.get(agent)!.turn })
          }
          return yield* Deferred.await(sighting(call.call))
        })

      const preToolUse: HookCallback = async (input, _toolUseID, { signal }) => {
        if (input.hook_event_name !== "PreToolUse") return {}
        const asked: Call = {
          call: input.tool_use_id as CallId,
          tool: toolName(input.tool_name),
          input: input.tool_input,
        }
        return Effect.runPromise(
          Effect.gen(function* () {
            const seen = yield* sighted(asked, input.agent_id)
            const checked = yield* seen.owner.before({ ...seen.call, input: asked.input })
            if ("refused" in checked) {
              yield* record(seen, asked.input)
              answered.add(asked.call)
              yield* seen.owner.recordResult(asked.call, failed(checked.refused))
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: checked.refused,
                },
              }
            }
            yield* record(seen, checked.input)
            return checked.input === asked.input
              ? {}
              : {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    updatedInput: checked.input as Record<string, unknown>,
                  },
                }
          }),
          { signal },
        )
      }

      const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, { signal, toolUseID, agentID }) => {
        const allow = { behavior: "allow" as const, updatedInput: input, toolUseID }
        if (turn.conversation.approvals === "auto" || own.get(toolName(tool))?.readOnly) return allow
        const asked: Call = { call: toolUseID as CallId, tool: toolName(tool), input }
        const allowed = await Effect.runPromise(
          Effect.gen(function* () {
            const seen = yield* sighted(asked, agentID)
            const call = yield* record(seen, input)
            return yield* seen.owner.approve({ ...call, input })
          }),
          { signal },
        )
        if (allowed) return allow
        denied.add(toolUseID)
        return { behavior: "deny", message: DENIED, toolUseID }
      }

      const runOwn = (tool: Tool) => async (input: unknown, extra: unknown) => {
        const id = toolUseOf(extra)
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            if (id === undefined) return failed(`Claude Code called ${tool.spec.name} without a call id`)
            const seen = yield* Deferred.await(sighting(id))
            const call = yield* record(seen, input)
            const conversation = seen.owner.conversation
            const ran = yield* tool.run(input, {
              call: id,
              cwd: conversation.cwd,
              env: toolEnv(conversation),
              output: (text) => seen.owner.toolOutput(id, text),
            })
            return yield* seen.owner.after(call, ran, true)
          }),
          { signal: (extra as { signal?: AbortSignal } | undefined)?.signal },
        )
        return { content: [{ type: "text" as const, text: outcome.output }], isError: outcome.error }
      }

      const ownServer =
        own.size === 0
          ? {}
          : {
              nisse: createSdkMcpServer({
                name: "nisse",
                tools: [...own.values()].map((tool) => ({
                  name: tool.spec.name,
                  description: tool.spec.description,
                  inputSchema: z.fromJSONSchema(tool.spec.parameters as z.core.JSONSchema.JSONSchema),
                  handler: runOwn(tool),
                })),
              }),
            }
      const withheld = [...turn.removedTools, ...own.keys()]

      const messages = query({
        prompt: inbox,
        options: {
          cwd: turn.conversation.cwd,
          abortController: abort,
          includePartialMessages: true,
          canUseTool,
          hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
          mcpServers: ownServer,
          ...(withheld.length === 0 ? {} : { disallowedTools: withheld }),
          settingSources: ["user", "project", "local"],
          extraArgs: { ...extraArgs(options.args ?? []), "replay-user-messages": null },
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(turn.conversation.instructions === undefined ? {} : { append: turn.conversation.instructions }),
          },
          env: { ...process.env, ...env, ...toolEnv(turn.conversation), CLAUDE_AGENT_SDK_CLIENT_APP: "nisse" },
          ...(turn.conversation.model.model ? { model: turn.conversation.model.model } : {}),
          ...(turn.conversation.model.effort ? { effort: turn.conversation.model.effort as EffortLevel } : {}),
          ...(start._tag === "resume"
            ? { resume: start.session, resumeSessionAt: start.at }
            : { sessionId: start.session }),
          ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
        },
      })
      send(opening)

      const handle = (message: SDKMessage): Effect.Effect<"next" | "done" | "gone", ProviderError, Scope.Scope> =>
        Effect.gen(function* () {
          switch (message.type) {
            case "stream_event": {
              const event = message.event
              if (
                message.parent_tool_use_id === null &&
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                saidAnything = true
                yield* turn.say(event.delta.text)
              }
              return "next"
            }
            case "assistant": {
              const content = message.message.content
              if (message.parent_tool_use_id !== null) {
                const child = children.get(message.parent_tool_use_id)
                if (!child) return "next"
                for (const block of content) {
                  if (block.type === "text") yield* child.turn.message(block.text)
                  else if (block.type === "tool_use")
                    yield* sight({
                      call: { call: block.id as CallId, tool: toolName(block.name), input: block.input },
                      owner: child.turn,
                    })
                }
                return "next"
              }
              if (message.error) {
                if (message.error === "authentication_failed") probed = undefined
                return yield* failure(resultText(content) || `Claude Code failed: ${message.error}`)
              }
              saidAnything = true
              for (const block of content) {
                if (block.type === "text") yield* turn.message(block.text, saved(message.uuid))
                else if (block.type === "tool_use") {
                  yield* sight({
                    call: { call: block.id as CallId, tool: toolName(block.name), input: block.input },
                    owner: turn,
                    at: message.uuid,
                  })
                }
              }
              return "next"
            }
            case "user": {
              if ("isReplay" in message && message.isReplay) {
                awaitingReplay.delete(message.uuid)
                return "next"
              }
              if (!Array.isArray(message.message.content)) return "next"
              const bySubagent = message.parent_tool_use_id !== null
              let anyResult = false
              for (const block of message.message.content) {
                if (block.type !== "tool_result") continue
                const id = block.tool_use_id
                if (answered.has(id)) {
                  anyResult = true
                  continue
                }
                const sighted = yield* recordIfSighted(id)
                if (!sighted) continue
                const { seen, call } = sighted
                anyResult = true
                answered.add(id)
                const outcome: ToolOutcome = { output: resultText(block.content), error: block.is_error === true }
                if (!denied.has(id) && !own.has(call.tool)) yield* seen.owner.after(call, outcome, false)
                yield* seen.owner.recordResult(
                  call.call,
                  outcome,
                  message.uuid && !bySubagent ? saved(message.uuid) : undefined,
                )
              }
              if (anyResult && !bySubagent) {
                const steers = yield* turn.steers
                if (steers.length > 0) send(steers, "next")
              }
              return "next"
            }
            case "system": {
              if (message.subtype === "task_started" && message.tool_use_id && message.task_type === "local_agent") {
                const parent = message.parent_task_id === undefined ? undefined : children.get(message.parent_task_id)
                const task = message.task_id
                yield* recordIfSighted(message.tool_use_id)
                const child = yield* (parent?.turn ?? turn).host({
                  call: message.tool_use_id as CallId,
                  title: message.description,
                  ...(message.subagent_type === undefined ? {} : { agentType: message.subagent_type }),
                  prompt: message.prompt ?? "",
                  stop: Effect.ignore(Effect.tryPromise(() => messages.stopTask(task))),
                })
                children.set(message.tool_use_id, child)
                children.set(task, child)
                yield* Deferred.succeed(arrival(task), undefined)
              } else if (message.subtype === "task_notification" && message.tool_use_id) {
                yield* children.get(message.tool_use_id)?.end(endings[message.status], message.summary) ?? Effect.void
              }
              return "next"
            }
            case "result": {
              if (message.subtype !== "success" || message.is_error) {
                const errors = "errors" in message ? message.errors : []
                if (!saidAnything && errors.some((error) => SESSION_GONE.test(error))) return "gone"
                const text = "result" in message && message.result ? message.result : errors.join("; ")
                return yield* failure(text || `Claude Code stopped: ${message.subtype}`)
              }
              return awaitingReplay.size === 0 ? "done" : "next"
            }
            default:
              return "next"
          }
        })

      const iterator = messages[Symbol.asyncIterator]()
      while (true) {
        const next = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (error) => failure(`Claude Code stopped: ${error instanceof Error ? error.message : String(error)}`),
        })
        if (next.done) return yield* failure("Claude Code exited before the turn finished")
        const outcome = yield* serial.withPermits(1)(handle(next.value))
        if (outcome !== "next") return outcome
      }
    }).pipe(Effect.scoped)

  const command = (args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn([executable, ...args], {
          cwd: tmpdir(),
          env: { ...process.env, ...env },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        })
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`)
      },
      catch: (error) =>
        failure(`\`claude ${args.join(" ")}\` failed: ${error instanceof Error ? error.message : String(error)}`),
    })

  return {
    kind: "claude",
    ...nothingOfItsOwn,
    health: (refresh) => Effect.map(probedNow(refresh), (found) => found.health),
    models: (refresh) => Effect.map(probedNow(refresh), (found) => found.models),
    signInMethods: ["terminal"],
    signIn: (_method, flow) =>
      Effect.gen(function* () {
        yield* flow.show({ _tag: "terminal", command: [executable, "auth", "login"], env })
        while (true) {
          const response = yield* flow.response
          if (response._tag !== "terminal_exited") continue
          if (!response.success) return yield* failure("`claude auth login` did not finish")
          probed = undefined
          return
        }
      }),
    signOut: Effect.tap(command(["auth", "logout"]), () => Effect.sync(() => (probed = undefined))),
    run: (turn) =>
      Effect.gen(function* () {
        const transcript = yield* turn.transcript
        const state = isClaudeState(turn.providerState) ? turn.providerState : undefined
        const start: Start = state ? { _tag: "resume", ...state } : { _tag: "fresh", session: crypto.randomUUID() }
        const joining = transcript.some((entry) => entry.body._tag !== "user")
        const opening = state
          ? unseen(transcript, turn.providerSeq)
          : joining
            ? [JOINING, ...history(transcript)]
            : history(transcript)
        const outcome = yield* converse(turn, start, opening)
        if (outcome === "gone") {
          yield* converse(turn, { _tag: "fresh", session: crypto.randomUUID() }, [JOINING, ...history(transcript)])
        }
      }),
  }
}
