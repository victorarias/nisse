// ChatGPT through a ChatGPT sign-in: the account (sign-in, token refresh, health, the model catalog) and the provider
// behind the `Models` seam, which sends each request to `/codex/responses` and streams its answer back.
import { Effect, Queue, Semaphore, Stream, type Scope } from "effect"
import { rmSync } from "node:fs"
import { ProviderError, type Health, type ProviderAccount, type ProviderInstance } from "../kind.ts"
import type { Provider } from "../models.ts"
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts"
import { catalog, CHATGPT_API, CLIENT_VERSION, type Catalog } from "./catalog.ts"
import { accountOf, isExpired, loadCredentials, refreshed, saveCredentials, type Credentials } from "./credentials.ts"
import { grammarInputs, requestBody } from "./request.ts"
import { httpFailure, ResponseReader, SIGN_IN_REFUSED, STREAM_CUT, ZERO_USAGE } from "./response.ts"
import { CALLBACK_PORT, signIn } from "./signin.ts"
import { events } from "./sse.ts"
import { getCurrentTools } from "../transcript.ts"

export { CALLBACK_PORT, CHATGPT_API, events, httpFailure, SIGN_IN_REFUSED }
export { NO_RESULT } from "./request.ts"
export { responseFailure } from "./response.ts"
export type { Catalog, Credentials }

export const BASE_URL = "https://chatgpt.com/backend-api"
export const AUTH_BASE = "https://auth.openai.com"
/** The model a conversation that names none gets. */
export const DEFAULT_MODEL = "gpt-5.5"
/** Who ChatGPT is told sent each request and sign-in. */
export const ORIGINATOR = "nisse"

export interface ChatGptOptions {
  /** Where this instance keeps its sign-in. */
  readonly authPath: string
  /** Where it keeps the model list ChatGPT last sent. */
  readonly modelsPath: string
  readonly authBase: string
  readonly baseUrl: string
  readonly callbackPort: number
  /** nisse's own instructions, sent before the conversation's. */
  readonly instructions: string
}

const failure = (message: string) => new ProviderError({ message })

/** One instance's sign-in: the credentials a request uses, refreshed when they expire or ChatGPT turns them down. */
export interface ChatGptAuth {
  readonly signedIn: Effect.Effect<Credentials, ProviderError>
  /** Fresh credentials after ChatGPT turned `turnedDown` away: another request's refresh, or a new one. */
  readonly afterRejection: (turnedDown: Credentials) => Effect.Effect<Credentials, ProviderError>
  /** Records how the last request's sign-in went: undefined when accepted, else why it was refused. */
  readonly settle: (refused: string | undefined) => void
  readonly headers: (credentials: Credentials, sessionId: string | undefined) => Record<string, string>
}

export interface ChatGpt {
  readonly account: ProviderAccount
  readonly auth: ChatGptAuth
  readonly catalog: Catalog
}

/** The account half of an instance: what a ChatGPT instance answers whatever runs its conversations. */
export const openChatGpt = Effect.fnUntraced(function* (options: Omit<ChatGptOptions, "instructions">) {
  const signingIn = yield* Semaphore.make(1)
  const models = catalog(options.modelsPath)
  let askedForModels = false
  let rejected: string | undefined

  const refresh = (credentials: Credentials) =>
    refreshed(credentials, options.authBase).pipe(
      Effect.tap((fresh) => saveCredentials(options.authPath, fresh)),
      Effect.tapError((error) => Effect.sync(() => (rejected = error.message))),
    )

  const auth: ChatGptAuth = {
    signedIn: signingIn.withPermits(1)(
      Effect.flatMap(loadCredentials(options.authPath), (credentials) =>
        isExpired(credentials) ? refresh(credentials) : Effect.succeed(credentials),
      ),
    ),
    afterRejection: (turnedDown) =>
      signingIn.withPermits(1)(
        Effect.flatMap(loadCredentials(options.authPath), (saved) =>
          saved.access_token !== turnedDown.access_token && !isExpired(saved) ? Effect.succeed(saved) : refresh(saved),
        ),
      ),
    settle: (refused) => {
      rejected = refused
    },
    headers: (credentials, sessionId) => ({
      authorization: `Bearer ${credentials.access_token}`,
      "chatgpt-account-id": credentials.account_id,
      originator: ORIGINATOR,
      ...(sessionId === undefined ? {} : { "session-id": sessionId, "x-client-request-id": sessionId }),
    }),
  }

  const fetchModels = Effect.gen(function* () {
    const credentials = yield* auth.signedIn
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${options.baseUrl}/codex/models?client_version=${CLIENT_VERSION}`, {
          signal,
          headers: auth.headers(credentials, undefined),
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

  const account: ProviderAccount = {
    kind: "openai",
    defaultModel: DEFAULT_MODEL,
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
  }
  return { account, auth, catalog: models } satisfies ChatGpt
})

// One POST to `/codex/responses`, signed in, refreshing the sign-in once when ChatGPT turns it down. Answers the
// response to read, or why the request failed.
const post = (chatgpt: ChatGpt, baseUrl: string, body: unknown, sessionId: string | undefined, signal: AbortSignal) =>
  Effect.gen(function* () {
    const { auth } = chatgpt
    let credentials = yield* auth.signedIn
    for (let retried = false; ; retried = true) {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${baseUrl}/codex/responses`, {
            method: "POST",
            signal,
            headers: {
              ...auth.headers(credentials, sessionId),
              "OpenAI-Beta": "responses=experimental",
              accept: "text/event-stream",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        catch: (error) => failure(`could not reach ChatGPT: ${String(error)}`),
      })
      if (response.ok) {
        auth.settle(undefined)
        return response
      }
      const text = yield* Effect.promise(() => response.text().catch(() => ""))
      if (response.status === 401 && !retried) {
        credentials = yield* auth.afterRejection(credentials)
        continue
      }
      if (response.status === 401) auth.settle(SIGN_IN_REFUSED)
      let error: unknown = text
      try {
        error = JSON.parse(text)
      } catch {}
      return yield* failure(httpFailure(response.status, error))
    }
  })

/** The provider behind the seam for one instance, named `id`. */
export const chatGptProvider = (id: string, chatgpt: ChatGpt, options: ChatGptOptions): Provider => ({
  id,
  get models() {
    return chatgpt.catalog.chatModels(id, options.baseUrl)
  },
  streamSimple: (model, context, request) =>
    Stream.callback<AssistantMessageEvent>((queue) =>
      Effect.gen(function* () {
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        )
        const template: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: "pending",
          timestamp: Date.now(),
        }
        let inputs: ReadonlyMap<string, string> = new Map()
        let body: unknown
        try {
          inputs = grammarInputs(getCurrentTools(context.messages))
          body = requestBody(
            {
              model: model.id,
              instructions: options.instructions,
              ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
              ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            },
            context,
          )
        } catch (error) {
          // A malformed grammar tool: the request is never sent, and the run ends saying which tool.
          const reader = new ResponseReader(template, inputs)
          yield* Queue.offer(queue, reader.fail(error instanceof Error ? error.message : String(error)))
          return yield* Queue.end(queue)
        }
        if (request.onPayload !== undefined) {
          const replaced = yield* Effect.promise(async () => request.onPayload!(body, model))
          if (replaced !== undefined) body = replaced
        }
        const reader = new ResponseReader(template, inputs)
        const answered = yield* Effect.result(
          post(chatgpt, options.baseUrl, body, request.sessionId, controller.signal),
        )
        if (answered._tag === "Failure") {
          yield* Queue.offer(queue, reader.fail(answered.failure.message))
          return yield* Queue.end(queue)
        }
        yield* Queue.offer(queue, reader.start())
        const stream = events(answered.success.body!, controller.signal)
        while (!reader.ended) {
          const next = yield* Effect.tryPromise({
            try: () => stream.next(),
            catch: (error) => String(error),
          }).pipe(Effect.result)
          if (next._tag === "Failure") {
            yield* Queue.offer(queue, reader.fail(`the response stream broke: ${next.failure}`))
            break
          }
          if (next.success.done) {
            yield* Queue.offer(queue, reader.fail(STREAM_CUT))
            break
          }
          for (const event of reader.push(next.success.value)) yield* Queue.offer(queue, event)
        }
        yield* Queue.end(queue)
      }),
    ),
})

/** A ChatGPT instance: its account, and the provider its conversations run on. */
export const chatGptInstance = (
  id: string,
  options: ChatGptOptions,
): Effect.Effect<ProviderInstance & { readonly chatgpt: ChatGpt }, never, Scope.Scope> =>
  Effect.map(openChatGpt(options), (chatgpt) => ({
    ...chatgpt.account,
    id,
    provider: chatGptProvider(id, chatgpt, options),
    chatgpt,
  }))
