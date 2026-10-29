import type { CallId, Conversation, Entry } from "@nisse/protocol"
import { Effect, Semaphore } from "effect"
import { rmSync } from "node:fs"
import { ProviderError, type Call, type Driver, type Health, type Turn } from "../../provider.ts"
import { catalog, CLIENT_VERSION } from "./catalog.ts"
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
import { accountOf, isExpired, loadCredentials, refreshed, saveCredentials, type Credentials } from "./credentials.ts"
import { CALLBACK_PORT, signIn } from "./signin.ts"
import { events } from "./sse.ts"
import { mailText } from "../../agents.ts"
import { agentsMd, agentTypes, skillsFor } from "../../workspace.ts"

export const BASE_URL = "https://chatgpt.com/backend-api"
export const AUTH_BASE = "https://auth.openai.com"
export const MODEL = "gpt-5.5"
const ORIGINATOR = "nisse"
const LONGEST_ERROR_BODY = 1000

export { CALLBACK_PORT }

export interface OpenAiOptions {
  readonly authPath: string
  readonly modelsPath: string
  readonly authBase: string
  readonly baseUrl: string
  readonly callbackPort: number
  readonly instructions: string
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

const isUsageLimit = (error: any) =>
  ["usage_limit_reached", "usage_not_included", "rate_limit_exceeded"].includes(error?.code ?? error?.type)

const usageLimit = (error: any) => {
  const plan = typeof error?.plan_type === "string" ? ` (${error.plan_type.toLowerCase()} plan)` : ""
  const when =
    typeof error?.resets_at === "number"
      ? ` Try again in about ${Math.max(0, Math.floor((error.resets_at * 1000 - Date.now()) / 60_000))} min.`
      : ""
  return `You have hit your ChatGPT usage limit${plan}.${when}`
}

const responseFailure = (error: any) => {
  if (isUsageLimit(error)) return usageLimit(error)
  const code = error?.code ?? error?.type
  const message = typeof error?.message === "string" ? error.message : "no details given"
  return typeof code === "string" ? `the response failed (${code}): ${message}` : `the response failed: ${message}`
}

const httpFailure = (status: number, body: any) => {
  const error = body?.error
  if (isUsageLimit(error) || status === 429) return usageLimit(error)
  if (status === 401) return "ChatGPT turned the sign-in down; sign in again"
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof body?.detail === "string"
        ? body.detail
        : (typeof body === "string" ? body : JSON.stringify(body)).slice(0, LONGEST_ERROR_BODY)
  return `ChatGPT answered ${status}: ${message}`
}

export const openAiDriver = Effect.fnUntraced(function* (options: OpenAiOptions) {
  const signingIn = yield* Semaphore.make(1)
  const models = catalog(options.modelsPath)
  const host = new Host(HOST_IDLE_MS)
  yield* Effect.addFinalizer(() => Effect.sync(() => host.stop()))
  let askedForModels = false
  let rejected: string | undefined

  const refresh = (credentials: Credentials) =>
    refreshed(credentials, options.authBase).pipe(
      Effect.tap((fresh) => saveCredentials(options.authPath, fresh)),
      Effect.tapError((error) => Effect.sync(() => (rejected = error.message))),
    )

  const signedIn = signingIn.withPermits(1)(
    Effect.flatMap(loadCredentials(options.authPath), (credentials) =>
      isExpired(credentials) ? refresh(credentials) : Effect.succeed(credentials),
    ),
  )

  const refreshedAfterRejection = (turnedDown: Credentials) =>
    signingIn.withPermits(1)(
      Effect.flatMap(loadCredentials(options.authPath), (saved) =>
        saved.access_token !== turnedDown.access_token && !isExpired(saved) ? Effect.succeed(saved) : refresh(saved),
      ),
    )

  const post = (turn: Turn, credentials: Credentials, body: unknown, signal: AbortSignal) =>
    Effect.tryPromise({
      try: () =>
        fetch(`${options.baseUrl}/codex/responses`, {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${credentials.access_token}`,
            "chatgpt-account-id": credentials.account_id,
            "OpenAI-Beta": "responses=experimental",
            originator: ORIGINATOR,
            "session-id": turn.conversation.id,
            "x-client-request-id": turn.conversation.id,
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
      let credentials = yield* signedIn
      let retried = false
      while (true) {
        const response = yield* post(turn, credentials, body, controller.signal)
        if (response.ok) {
          rejected = undefined
          return yield* read(turn, response, controller.signal)
        }
        const text = yield* Effect.promise(() => response.text().catch(() => ""))
        if (response.status === 401 && !retried) {
          credentials = yield* refreshedAfterRejection(credentials)
          retried = true
          continue
        }
        if (response.status === 401) rejected = "ChatGPT turned the sign-in down; sign in again"
        let error: unknown = text
        try {
          error = JSON.parse(text)
        } catch {}
        return yield* failure(httpFailure(response.status, error))
      }
    }).pipe(Effect.scoped)

  const fetchModels = Effect.gen(function* () {
    const credentials = yield* signedIn
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${options.baseUrl}/codex/models?client_version=${CLIENT_VERSION}`, {
          signal,
          headers: {
            authorization: `Bearer ${credentials.access_token}`,
            "chatgpt-account-id": credentials.account_id,
            originator: ORIGINATOR,
          },
        }),
      catch: (error) => failure(`could not reach ChatGPT: ${String(error)}`),
    })
    if (!response.ok) return yield* failure(`ChatGPT answered ${response.status} when asked for its models`)
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => failure("ChatGPT sent a model list that is not JSON"),
    })
    yield* Effect.try({
      try: () => models.fetched(body),
      catch: (error) => failure(`ChatGPT sent a model list nisse can't read: ${String(error)}`),
    })
  })

  const health: Effect.Effect<Health> = Effect.match(signingIn.withPermits(1)(loadCredentials(options.authPath)), {
    onFailure: (): Health => ({ status: "signed_out", message: "not signed in to ChatGPT" }),
    onSuccess: (credentials): Health => {
      const account = accountOf(credentials)
      if (rejected) return { status: "signed_out", message: rejected, ...(account ? { account } : {}) }
      return { status: "ready", ...(account ? { account } : {}) }
    },
  })

  const driver: Driver = {
    kind: "openai",
    defaultModel: MODEL,
    health: () => health,
    models: (refresh) =>
      Effect.gen(function* () {
        if (refresh || !askedForModels) {
          askedForModels = true
          yield* Effect.ignore(fetchModels)
        }
        return models.listed()
      }),
    signInMethods: ["browser", "device_code"],
    skills: (cwd) => skillsFor(cwd, options.home),
    agentTypes: (cwd) => agentTypes(cwd, options.claudeConfig),
    tools: (conversation) => (models.wantsCodeMode(conversation.model.model ?? MODEL) ? [ApplyPatch] : []),
    signIn: (method, flow) =>
      Effect.gen(function* () {
        const credentials = yield* signIn(
          { authBase: options.authBase, callbackPort: options.callbackPort, originator: ORIGINATOR },
          method,
          flow,
        )
        yield* signingIn.withPermits(1)(saveCredentials(options.authPath, credentials))
        rejected = undefined
        askedForModels = false
      }),
    signOut: signingIn.withPermits(1)(
      Effect.try({
        try: () => rmSync(options.authPath, { force: true }),
        catch: (error) => failure(`could not sign out: ${String(error)}`),
      }),
    ),
    run: (turn) =>
      Effect.gen(function* () {
        const instructions = instructionsFor(options, turn.conversation)
        const { model = MODEL, effort } = turn.conversation.model
        const codeMode = models.wantsCodeMode(model)
        let runTool = (call: Call) => turn.runTool(call)
        if (codeMode) {
          const program = installedHost(options.codeModeHost, options.home)
          if (program === undefined) return yield* failure(missingHost)
          runTool = yield* codeModeRun(host, program, turn)
        }
        const offered = (names: ReadonlyArray<string>): ReadonlyArray<unknown> => {
          const specs = turn.tools.filter(({ spec }) => names.includes(spec.name))
          return codeMode
            ? codeModeTools(specs)
            : specs.map(({ spec }) => ({
                type: "function",
                name: spec.name,
                description: spec.description,
                parameters: spec.parameters,
                strict: false,
              }))
        }
        while (true) {
          const transcript = yield* turn.transcript
          const request = yield* turn.request(turn.tools.map(({ spec }) => spec.name))
          const calls = yield* respond(turn, {
            model,
            ...(effort ? { reasoning: { effort } } : {}),
            instructions: instructions + request.instructions.map((text) => `\n${text.trimEnd()}\n`).join(""),
            input: inputItems(transcript),
            tools: offered(request.tools),
            tool_choice: "auto",
            parallel_tool_calls: true,
            store: false,
            stream: true,
            prompt_cache_key: turn.conversation.id,
          })
          if (calls.length === 0) return
          for (const call of calls) yield* runTool(call)
          yield* turn.steers
        }
      }).pipe(Effect.scoped),
  }
  return driver
})
