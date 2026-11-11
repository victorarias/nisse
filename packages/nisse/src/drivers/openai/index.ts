import type { CallId, Conversation, Entry } from "@nisse/protocol"
import {
  AUTH_BASE,
  BASE_URL,
  CALLBACK_PORT,
  DEFAULT_MODEL as MODEL,
  events,
  httpFailure,
  openChatGpt,
  responseFailure,
  SIGN_IN_REFUSED,
  type ChatGptOptions,
  type Credentials,
} from "@nisse/models/chatgpt"
import { Effect } from "effect"
import { ProviderError, type Call, type Driver, type Turn } from "../../provider.ts"
import { ApplyPatch } from "./code-mode/apply-patch.ts"
import {
  CELL,
  codeModeRun,
  codeModeTools,
  EXEC,
  Host,
  HOST_IDLE_MS,
  installedHost,
  isScriptReport,
  missingHost,
} from "./code-mode/index.ts"
import { mailText } from "../../agents.ts"
import type { Tool, ToolOutcome } from "../../tools/tool.ts"
import { agentsMd, agentTypes, skillsFor } from "../../workspace.ts"

export { AUTH_BASE, BASE_URL, CALLBACK_PORT, MODEL }

export interface OpenAiOptions extends ChatGptOptions {
  readonly home: string
  readonly claudeConfig: string
  readonly codeModeHost?: string
}

const failure = (message: string) => new ProviderError({ message })

const SKILLS = `# Skills

A skill is a folder of instructions for one kind of task, in a \`SKILL.md\` file. When a task matches a skill's description, \`Read\` its \`SKILL.md\` before you start, and follow it. When a message names a skill with \`/name\` or \`$name\`, the skill's \`SKILL.md\` comes with the message; follow it. Relative paths in a skill are relative to its folder.

`

const instructionsFor = (options: OpenAiOptions, conversation: Conversation) => {
  const cwd = conversation.cwd
  let text = `${options.instructions}\nThe working directory is ${cwd}.\n`
  for (const file of agentsMd(cwd, options.home)) {
    text += `\n# AGENTS.md instructions from ${file.path}\n\n${file.text.trimEnd()}\n`
  }
  if (conversation.instructions !== undefined) text += `\n${conversation.instructions.trimEnd()}\n`
  const skills = skillsFor(cwd, options.home)
  if (skills.length > 0) {
    text += `\n${SKILLS}${skills.map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.path})\n`).join("")}`
  }
  const wanted = conversation.lineage?.agentType
  const agentType = wanted ? agentTypes(cwd, options.claudeConfig).find((type) => type.name === wanted) : undefined
  if (agentType) text += `\n# You are a ${agentType.name} agent\n\n${agentType.instructions}\n`
  return text
}

const finishedCall = (tool: string, result: { output: string; error: boolean }) =>
  `- ${tool} (${result.error ? "failed" : "done"}): ${result.output.trimEnd()}`

const withFinishedCalls = (text: string, finished: ReadonlyArray<string>) =>
  finished.length === 0 ? text : `${text}\nThe calls it made that finished:\n${finished.join("\n")}`

const userItem = (body: Extract<Entry["body"], { _tag: "user" }>) => ({
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text: body.text },
    ...(body.skills ?? []).map((skill) => ({
      type: "input_text",
      text: `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${skill.text.trimEnd()}\n</skill>`,
    })),
  ],
})

const callItem = (body: Extract<Entry["body"], { _tag: "tool_call" }>) =>
  body.tool === EXEC && typeof body.input === "string"
    ? { type: "custom_tool_call", call_id: body.call, name: body.tool, input: body.input }
    : {
        type: "function_call",
        call_id: body.call,
        name: body.tool,
        arguments: typeof body.input === "string" ? body.input : JSON.stringify(body.input),
      }

const stoppedCellNote = (script: CallId, finished: ReadonlyArray<string>) => ({
  type: "message",
  role: "developer",
  content: [
    { type: "input_text", text: withFinishedCalls(`Cell ${script} stopped before its script finished.`, finished) },
  ],
})

const inputItems = (transcript: ReadonlyArray<Entry>): Array<unknown> => {
  const nested = new Map<CallId, { tool: string; script: CallId }>()
  const finishedIn = new Map<CallId, Array<string>>()
  const scripts = new Set<CallId>()
  const items: Array<() => unknown> = []
  let stopped: Array<CallId> = []
  const finished = (script: CallId) => finishedIn.get(script) ?? []
  const notes = () => stopped.map((script) => () => stoppedCellNote(script, finished(script)))
  const said = (item: unknown) => {
    items.push(...notes(), () => item)
    stopped = []
  }
  for (const { body } of transcript) {
    if (body._tag === "user")
      said(
        body.mail
          ? {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: mailText(body.mail, body.text) }],
            }
          : userItem(body),
      )
    else if (body._tag === "message")
      said({ type: "message", role: "assistant", content: [{ type: "output_text", text: body.text }] })
    else if (body._tag === "tool_call") {
      if (body.parent !== undefined) nested.set(body.call, { tool: body.tool, script: body.parent })
      else {
        const item = callItem(body)
        if (item.type === "custom_tool_call") scripts.add(body.call)
        said(item)
      }
    } else if (body._tag === "tool_result") {
      const inner = nested.get(body.call)
      const ended = !isScriptReport(body.output)
      if (inner?.tool === CELL) {
        if (ended) stopped.push(inner.script)
      } else if (inner !== undefined)
        finishedIn.set(inner.script, [...finished(inner.script), finishedCall(inner.tool, body)])
      else {
        const script = scripts.has(body.call)
        items.push(() => ({
          type: script ? "custom_tool_call_output" : "function_call_output",
          call_id: body.call,
          output: script && ended ? withFinishedCalls(body.output, finished(body.call)) : body.output,
        }))
      }
    }
  }
  return [...items, ...notes()].map((item) => item())
}

const messageText = (item: any): string =>
  (Array.isArray(item?.content) ? item.content : [])
    .map((part: any) =>
      typeof part?.text === "string" ? part.text : typeof part?.refusal === "string" ? part.refusal : "",
    )
    .join("")

const parsedArguments = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const toolCall = (item: any): Effect.Effect<Call, ProviderError> =>
  typeof item?.call_id === "string"
    ? Effect.succeed({
        call: item.call_id as CallId,
        tool: typeof item.name === "string" ? item.name : "",
        input: parsedArguments(typeof item.arguments === "string" ? item.arguments : "{}"),
      })
    : Effect.fail(failure("a function call without a call_id"))

const customToolCall = (item: any): Effect.Effect<Call, ProviderError> =>
  typeof item?.call_id === "string"
    ? Effect.succeed({
        call: item.call_id as CallId,
        tool: typeof item.name === "string" ? item.name : "",
        input: typeof item.input === "string" ? item.input : "",
      })
    : Effect.fail(failure("a custom tool call without a call_id"))

export const openAiDriver = Effect.fnUntraced(function* (options: OpenAiOptions) {
  const { account, auth, catalog: models } = yield* openChatGpt(options)
  const host = new Host(HOST_IDLE_MS)
  yield* Effect.addFinalizer(() => Effect.sync(() => host.stop()))

  const post = (turn: Turn, credentials: Credentials, body: unknown, signal: AbortSignal) =>
    Effect.tryPromise({
      try: () =>
        fetch(`${options.baseUrl}/codex/responses`, {
          method: "POST",
          signal,
          headers: {
            ...auth.headers(credentials, turn.conversation.id),
            "OpenAI-Beta": "responses=experimental",
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      catch: (error) => failure(`could not reach ChatGPT: ${String(error)}`),
    })

  const read = (turn: Turn, response: Response, signal: AbortSignal) =>
    Effect.gen(function* () {
      const calls: Array<Call> = []
      const stream = events(response.body!, signal)
      while (true) {
        const event: any = yield* Effect.tryPromise({
          try: () => stream.next(),
          catch: (error) => failure(`the response stream broke: ${String(error)}`),
        }).pipe(Effect.map((next) => (next.done ? undefined : next.value)))
        if (event === undefined) return yield* failure("the response stream ended before the response finished")
        const item = event.item
        switch (event.type) {
          case "response.output_text.delta":
          case "response.refusal.delta":
            yield* turn.say(typeof event.delta === "string" ? event.delta : "")
            break
          case "response.output_item.done":
            if (item?.type === "message") {
              const text = messageText(item)
              if (text !== "") yield* turn.message(text)
            } else if (item?.type === "function_call") {
              calls.push(yield* toolCall(item))
            } else if (item?.type === "custom_tool_call") {
              calls.push(yield* customToolCall(item))
            }
            break
          case "response.completed":
          case "response.done":
            return calls
          case "response.incomplete":
            return yield* failure(
              `the response stopped early: ${event.response?.incomplete_details?.reason ?? "no reason given"}`,
            )
          case "response.failed":
            return yield* failure(responseFailure(event.response?.error))
          case "error":
            return yield* failure(responseFailure(typeof event.error === "object" ? event.error : event))
        }
      }
    })

  const respond = (turn: Turn, body: unknown) =>
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      )
      let credentials = yield* auth.signedIn
      let retried = false
      while (true) {
        const response = yield* post(turn, credentials, body, controller.signal)
        if (response.ok) {
          auth.settle(undefined)
          return yield* read(turn, response, controller.signal)
        }
        const text = yield* Effect.promise(() => response.text().catch(() => ""))
        if (response.status === 401 && !retried) {
          credentials = yield* auth.afterRejection(credentials)
          retried = true
          continue
        }
        if (response.status === 401) auth.settle(SIGN_IN_REFUSED)
        let error: unknown = text
        try {
          error = JSON.parse(text)
        } catch {}
        return yield* failure(httpFailure(response.status, error))
      }
    }).pipe(Effect.scoped)

  const driver: Driver = {
    ...account,
    skills: (cwd) => skillsFor(cwd, options.home),
    agentTypes: (cwd) => agentTypes(cwd, options.claudeConfig),
    tools: (conversation) => (models.wantsCodeMode(conversation.model.model ?? MODEL) ? [ApplyPatch] : []),
    run: (turn) =>
      Effect.gen(function* () {
        const instructions = instructionsFor(options, turn.conversation)
        const { model = MODEL, effort } = turn.conversation.model
        const codeMode = models.wantsCodeMode(model)
        let runTool: (call: Call, offered: ReadonlyArray<Tool>) => Effect.Effect<ToolOutcome> = (call) =>
          turn.runTool(call)
        if (codeMode) {
          const program = installedHost(options.codeModeHost, options.home)
          if (program === undefined) return yield* failure(missingHost)
          runTool = yield* codeModeRun(host, program, turn)
        }
        const declared = (specs: ReadonlyArray<Tool>): ReadonlyArray<unknown> =>
          codeMode
            ? codeModeTools(specs)
            : specs.map(({ spec }) => ({
                type: "function",
                name: spec.name,
                description: spec.description,
                parameters: spec.parameters,
                strict: false,
              }))
        while (true) {
          const transcript = yield* turn.transcript
          const request = yield* turn.request(turn.tools.map(({ spec }) => spec.name))
          const offered = turn.tools.filter(({ spec }) => request.tools.includes(spec.name))
          const calls = yield* respond(turn, {
            model,
            ...(effort ? { reasoning: { effort } } : {}),
            instructions: instructions + request.instructions.map((text) => `\n${text.trimEnd()}\n`).join(""),
            input: inputItems(transcript),
            tools: declared(offered),
            tool_choice: "auto",
            parallel_tool_calls: true,
            store: false,
            stream: true,
            prompt_cache_key: turn.conversation.id,
          })
          if (calls.length === 0) return
          for (const call of calls) yield* runTool(call, offered)
          yield* turn.steers
        }
      }).pipe(Effect.scoped),
  }
  return driver
})
