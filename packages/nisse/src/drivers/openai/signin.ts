import type { AuthMethod } from "@nisse/protocol"
import { Deferred, Effect } from "effect"
import { ProviderError, type SignInFlow } from "../../provider.ts"
import { CLIENT_ID, errorReason, fromTokens, requestTokens, saveCredentials } from "./credentials.ts"

export const CALLBACK_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
const SCOPE = "openid profile email offline_access"
const DEVICE_CODE_LIFETIME_MS = 15 * 60 * 1000
const SHORTEST_POLL_MS = 1000
const ANSWER_GRACE = "1 second"

export interface SignInServer {
  readonly authBase: string
  readonly callbackPort: number
  readonly originator: string
}

const failure = (message: string) => new ProviderError({ message })

const randomText = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")

const page = (status: number, message: string) =>
  new Response(
    `<!doctype html><meta charset=utf-8><title>Nisse</title><p style="font-family:sans-serif">${message}</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  )

type Callback =
  | { readonly _tag: "ignored"; readonly status: number; readonly message: string }
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "code"; readonly code: string }

const callback = (url: URL | undefined, state: string): Callback => {
  if (!url) return { _tag: "ignored", status: 400, message: "Not a sign-in answer." }
  if (url.pathname !== CALLBACK_PATH) return { _tag: "ignored", status: 404, message: "Not found." }
  const param = (name: string) => url.searchParams.get(name) ?? undefined
  if (param("state") !== state) {
    return { _tag: "ignored", status: 400, message: "This answer is for another sign-in." }
  }
  const error = param("error")
  if (error !== undefined) return { _tag: "refused", reason: param("error_description") ?? error }
  const code = param("code")
  return code === undefined
    ? { _tag: "ignored", status: 400, message: "The answer carried no code." }
    : { _tag: "code", code }
}

const parsed = (text: string) => {
  try {
    return new URL(text.trim())
  } catch {
    return undefined
  }
}

const exchange = (server: SignInServer, code: string, verifier: string, redirectUri: string) =>
  requestTokens(
    server.authBase,
    {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    },
    "exchange",
  )

const browser = (server: SignInServer, flow: SignInFlow) =>
  Effect.gen(function* () {
    const verifier = randomText(32)
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")
    const state = randomText(16)
    const answered = yield* Deferred.make<string, ProviderError>()
    const settled: Array<PromiseWithResolvers<boolean>> = []
    const listener = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: server.callbackPort,
            fetch: async (request) => {
              const seen = callback(parsed(request.url), state)
              if (seen._tag === "ignored") return page(seen.status, seen.message)
              if (seen._tag === "refused") {
                Deferred.doneUnsafe(answered, Effect.fail(failure(`ChatGPT refused the sign-in: ${seen.reason}`)))
                return page(400, seen.reason)
              }
              const signedIn = Promise.withResolvers<boolean>()
              Deferred.doneUnsafe(answered, Effect.succeed(seen.code))
              settled.push(signedIn)
              return (await signedIn.promise)
                ? page(200, "Signed in to ChatGPT. You can close this tab.")
                : page(502, "Signing in failed.")
            },
          }),
        catch: () =>
          failure(
            `could not listen on 127.0.0.1:${server.callbackPort} for the browser's answer (is another sign-in running?); a device code sign-in needs no port`,
          ),
      }),
      (listener) =>
        Effect.promise(() => listener.stop()).pipe(
          Effect.timeoutOrElse({ duration: ANSWER_GRACE, orElse: () => Effect.promise(() => listener.stop(true)) }),
        ),
    )
    const redirectUri = `http://localhost:${listener.port}${CALLBACK_PATH}`
    const url = new URL(`${server.authBase}/oauth/authorize`)
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: server.originator,
    })) {
      url.searchParams.set(key, value)
    }
    yield* flow.show({ _tag: "browser", url: url.toString() })

    const pasted = Effect.gen(function* () {
      while (true) {
        const response = yield* flow.response
        if (response._tag !== "callback") continue
        const seen = callback(parsed(response.url), state)
        if (seen._tag === "refused") return yield* failure(`ChatGPT refused the sign-in: ${seen.reason}`)
        if (seen._tag === "code") return seen.code
      }
    })
    const code = yield* Effect.raceFirst(Deferred.await(answered), pasted)
    return yield* exchange(server, code, verifier, redirectUri).pipe(
      Effect.onExit((exit) => Effect.sync(() => settled.forEach((page) => page.resolve(exit._tag === "Success")))),
    )
  }).pipe(Effect.scoped)

const post = (url: string, body: unknown) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    catch: (error) => failure(`could not reach ChatGPT's sign-in: ${String(error)}`),
  })

const deviceCode = (server: SignInServer, flow: SignInFlow) =>
  Effect.gen(function* () {
    const asked = yield* post(`${server.authBase}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID })
    if (asked.status === 404) {
      return yield* failure("this server offers no device code sign-in; sign in through a browser")
    }
    const text = yield* Effect.promise(() => asked.text())
    if (!asked.ok) return yield* failure(`asking for a device code failed (${asked.status}${errorReason(text)})`)
    const device = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => failure("the device code answer is not JSON"),
    })
    const deviceAuthId = device?.device_auth_id
    const userCode = device?.user_code
    if (typeof deviceAuthId !== "string" || typeof userCode !== "string") {
      return yield* failure("the device code answer is missing fields")
    }
    const interval = Math.max(SHORTEST_POLL_MS, Number(String(device.interval ?? "").trim()) * 1000 || 0)
    yield* flow.show({ _tag: "device_code", url: `${server.authBase}/codex/device`, code: userCode })

    const deadline = Date.now() + DEVICE_CODE_LIFETIME_MS
    while (Date.now() < deadline) {
      yield* Effect.sleep(interval)
      const polled = yield* post(`${server.authBase}/api/accounts/deviceauth/token`, {
        device_auth_id: deviceAuthId,
        user_code: userCode,
      })
      if (polled.status === 403 || polled.status === 404) continue
      const body = yield* Effect.promise(() => polled.text())
      if (!polled.ok) return yield* failure(`the device code sign-in failed (${polled.status}${errorReason(body)})`)
      const granted = yield* Effect.try({
        try: () => JSON.parse(body),
        catch: () => failure("the device code grant is not JSON"),
      })
      if (typeof granted?.authorization_code !== "string" || typeof granted?.code_verifier !== "string") {
        return yield* failure("the device code grant is missing fields")
      }
      return yield* exchange(
        server,
        granted.authorization_code,
        granted.code_verifier,
        `${server.authBase}/deviceauth/callback`,
      )
    }
    return yield* failure("the device code expired before anyone entered it")
  })

export const signIn = (server: SignInServer, authPath: string, method: AuthMethod, flow: SignInFlow) =>
  Effect.gen(function* () {
    const tokens =
      method === "browser"
        ? yield* browser(server, flow)
        : method === "device_code"
          ? yield* deviceCode(server, flow)
          : yield* failure("ChatGPT has no sign-in command to run")
    yield* saveCredentials(authPath, yield* fromTokens(tokens))
  })
