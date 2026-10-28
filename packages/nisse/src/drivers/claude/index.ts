import {
  query,
  type EffortLevel,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { CallId, Entry } from "@nisse/protocol"
import { tmpdir } from "node:os"
import { Deferred, Effect, Semaphore } from "effect"
import { ProviderError, type Call, type Driver, type Saved, type Turn } from "../../provider.ts"
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
const SESSION_GONE = /No conversation found/

const failure = (message: string) => new ProviderError({ message })

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
  const configDirEnv = (): Record<string, string> =>
    env.CLAUDE_CONFIG_DIR === undefined ? {} : { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR }

  const converse = (turn: Turn, start: Start, opening: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const serial = yield* Semaphore.make(1)
      const known = new Set<string>()
      const recorded = new Map<string, Deferred.Deferred<void>>()
      const recording = (call: string) => {
        let done = recorded.get(call)
        if (!done) recorded.set(call, (done = Deferred.makeUnsafe<void>()))
        return done
      }
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
      const saved = (at: string): Saved | undefined =>
        awaitingReplay.size === 0 ? { state: { session: start.session, at } satisfies ClaudeState } : undefined
      const record = (call: Call, at: string) =>
        Effect.suspend(() => {
          known.add(call.call)
          return Effect.andThen(turn.recordCall(call, saved(at)), Deferred.succeed(recording(call.call), undefined))
        })
      const recordSubagentCall = (call: Call) =>
        Effect.suspend(() => {
          if (known.has(call.call)) return Effect.void
          known.add(call.call)
          return turn.recordCall(call)
        })

      const canUseTool: NonNullable<Options["canUseTool"]> = async (tool, input, { signal, toolUseID, agentID }) => {
        const call: Call = { call: toolUseID as CallId, tool, input }
        if (turn.conversation.approvals === "auto") return { behavior: "allow", updatedInput: input, toolUseID }
        const asked =
          agentID === undefined ? Deferred.await(recording(toolUseID)) : serial.withPermits(1)(recordSubagentCall(call))
        const allowed = await Effect.runPromise(Effect.andThen(asked, turn.approve(call)), { signal })
        return allowed
          ? { behavior: "allow", updatedInput: input, toolUseID }
          : { behavior: "deny", message: DENIED, toolUseID }
      }

      const messages = query({
        prompt: inbox,
        options: {
          cwd: turn.conversation.cwd,
          abortController: abort,
          includePartialMessages: true,
          canUseTool,
          settingSources: ["user", "project", "local"],
          extraArgs: { ...extraArgs(options.args ?? []), "replay-user-messages": null },
          env: { ...process.env, ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "nisse" },
          ...(turn.conversation.model.model ? { model: turn.conversation.model.model } : {}),
          ...(turn.conversation.model.effort ? { effort: turn.conversation.model.effort as EffortLevel } : {}),
          ...(start._tag === "resume"
            ? { resume: start.session, resumeSessionAt: start.at }
            : { sessionId: start.session }),
          ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
        },
      })
      send(opening)

      const handle = (message: SDKMessage): Effect.Effect<"next" | "done" | "gone", ProviderError> =>
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
                for (const block of content) {
                  if (block.type === "tool_use")
                    yield* recordSubagentCall({ call: block.id as CallId, tool: block.name, input: block.input })
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
                  yield* record({ call: block.id as CallId, tool: block.name, input: block.input }, message.uuid)
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
              let answered = false
              for (const block of message.message.content) {
                if (block.type !== "tool_result" || !known.has(block.tool_use_id)) continue
                answered = true
                yield* turn.recordResult(
                  block.tool_use_id as CallId,
                  { output: resultText(block.content), error: block.is_error === true },
                  message.uuid && !bySubagent ? saved(message.uuid) : undefined,
                )
              }
              if (answered && !bySubagent) {
                const steers = yield* turn.steers
                if (steers.length > 0) send(steers, "next")
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
    health: (refresh) => Effect.map(probedNow(refresh), (found) => found.health),
    models: (refresh) => Effect.map(probedNow(refresh), (found) => found.models),
    signInMethods: ["terminal"],
    signIn: (_method, flow) =>
      Effect.gen(function* () {
        yield* flow.show({ _tag: "terminal", command: [executable, "auth", "login"], env: configDirEnv() })
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
