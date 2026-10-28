import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Schema } from "effect"
import { ProviderError } from "../../provider.ts"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ACCOUNT_CLAIM = "https://api.openai.com/auth"

const Credentials = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_at_ms: Schema.Number,
  account_id: Schema.String,
})
export type Credentials = typeof Credentials.Type

const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Number,
})

const failure = (message: string) => new ProviderError({ message })

export const isExpired = (credentials: Credentials) => Date.now() >= credentials.expires_at_ms

const claims = (accessToken: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"))
  } catch {
    return undefined
  }
}

const accountId = (accessToken: string) => {
  const id = claims(accessToken)?.[ACCOUNT_CLAIM]?.chatgpt_account_id
  return typeof id === "string" && id !== "" ? id : undefined
}

export const loadCredentials = (path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(path).json(),
    catch: (error) => failure(`not signed in to ChatGPT: could not read ${path}: ${String(error)}`),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Credentials)),
    Effect.mapError((error) => (error instanceof ProviderError ? error : failure(`${path} is not valid`))),
  )

export const saveCredentials = (path: string, credentials: Credentials) =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const unfinished = `${path}.partial`
      writeFileSync(unfinished, JSON.stringify(credentials, null, 2), { mode: 0o600 })
      chmodSync(unfinished, 0o600)
      renameSync(unfinished, path)
    },
    catch: (error) => failure(`could not write ${path}: ${String(error)}`),
  })

const errorReason = (text: string) => {
  try {
    const body = JSON.parse(text)
    const message = body?.error_description ?? body?.error?.message ?? body?.error
    return typeof message === "string" ? `: ${message}` : ""
  } catch {
    return ""
  }
}

export const refreshed = (credentials: Credentials, authBase: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${authBase}/oauth/token`, {
          method: "POST",
          signal,
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: credentials.refresh_token,
            client_id: CLIENT_ID,
          }),
        }),
      catch: (error) => failure(`could not refresh the ChatGPT sign-in: ${String(error)}`),
    })
    const text = yield* Effect.promise(() => response.text())
    if (!response.ok) {
      return yield* failure(
        `the ChatGPT sign-in expired; sign in again (refresh: ${response.status}${errorReason(text)})`,
      )
    }
    const tokens = yield* Effect.try({ try: () => JSON.parse(text), catch: () => undefined }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Tokens)),
      Effect.mapError(() => failure("the ChatGPT token refresh answered without the expected fields")),
    )
    const account = accountId(tokens.access_token)
    if (!account) return yield* failure("the ChatGPT access token names no account")
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? credentials.refresh_token,
      expires_at_ms: Date.now() + tokens.expires_in * 1000,
      account_id: account,
    } satisfies Credentials
  })
