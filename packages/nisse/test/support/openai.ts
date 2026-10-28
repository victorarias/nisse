import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { OpenAiOptions } from "../../src/drivers/openai/index.ts"
import type { Home } from "../../src/home.ts"

const FIXTURES = join(import.meta.dir, "../../../../fixtures/openai")
export const ACCOUNT = "acct-test"
const ANY = "<any>"

type Reply =
  | { readonly http: { status: number; body: unknown } }
  | { readonly events: Array<unknown>; readonly hold?: boolean; readonly crlfSplit?: boolean }

export interface Received {
  readonly path: string
  readonly headers: Headers
  readonly body: string
}

export const accessToken = (label: string) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return [
    part({ alg: "none" }),
    part({ label, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } }),
    "signature",
  ].join(".")
}

export const matches = (actual: unknown, expected: unknown): boolean => {
  if (expected === ANY) return true
  if (Array.isArray(expected))
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e))
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    return [...keys].every((key) => matches((actual as any)[key], (expected as any)[key]))
  }
  return actual === expected
}

export class FakeOpenAi {
  readonly received: Array<Received> = []
  private readonly replies: Array<Reply> = []
  private readonly tokens: Array<unknown> = []
  private readonly held = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private readonly abandoned = Promise.withResolvers<void>()
  private readonly server: ReturnType<typeof Bun.serve>

  constructor() {
    this.server = Bun.serve({ port: 0, fetch: (request) => this.answer(request) })
  }

  get base() {
    return `http://127.0.0.1:${this.server.port}`
  }

  options(instructions = "You are a test.") {
    return (home: Home): OpenAiOptions => ({
      authPath: join(home.dir, "auth", "openai.json"),
      authBase: this.base,
      baseUrl: this.base,
      instructions,
    })
  }

  play(fixture: string) {
    const expected: Array<unknown> = []
    const replies: Array<Array<any>> = []
    for (const line of readFileSync(join(FIXTURES, `${fixture}.ndjson`), "utf8").split("\n")) {
      if (line.trim() === "") continue
      const parsed = JSON.parse(line)
      if (parsed.type === "expect_outbound") {
        expected.push(parsed.frame)
        replies.push([])
      } else if (parsed.type === "emit_inbound") replies.at(-1)!.push(parsed.frame)
    }
    for (const frames of replies) {
      this.replies.push(frames[0]?.http ? { http: frames[0].http } : { events: frames })
    }
    return expected
  }

  reply(reply: Reply) {
    this.replies.push(reply)
  }

  issueTokens(label: string, expiresIn: number) {
    this.tokens.push({
      access_token: accessToken(label),
      refresh_token: `${label}-refresh`,
      id_token: "unused",
      expires_in: expiresIn,
    })
  }

  responses() {
    return this.received.filter((request) => request.path === "/codex/responses")
  }

  private async answer(request: Request) {
    const path = new URL(request.url).pathname
    const body = await request.text()
    this.received.push({ path, headers: request.headers, body })
    if (path === "/oauth/token") {
      const tokens = this.tokens.shift()
      return tokens ? Response.json(tokens) : Response.json({ error: "invalid_grant" }, { status: 400 })
    }
    const reply = this.replies.shift()
    if (!reply) return Response.json({ error: { message: "no reply scripted" } }, { status: 500 })
    if ("http" in reply) return Response.json(reply.http.body, { status: reply.http.status })
    const encoder = new TextEncoder()
    if (reply.crlfSplit) {
      const pieces = reply.events.flatMap((event) => [`data: ${JSON.stringify(event)}\r\n\r`, "\n"])
      const split = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          await Bun.sleep(5)
          const piece = pieces.shift()
          if (piece === undefined) controller.close()
          else controller.enqueue(encoder.encode(piece))
        },
      })
      return new Response(split, { headers: { "content-type": "text/event-stream" } })
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of reply.events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        if (reply.hold) {
          this.held.add(controller)
          request.signal.addEventListener("abort", () => {
            this.held.delete(controller)
            this.abandoned.resolve()
          })
        } else controller.close()
      },
      cancel: () => undefined,
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  }

  get heldStreamAbandoned() {
    return this.abandoned.promise
  }

  async [Symbol.asyncDispose]() {
    for (const controller of this.held) controller.close()
    await this.server.stop(true)
  }
}

export const signIn = async (home: Home, label = "first", expiresAt = Date.now() + 3_600_000) =>
  Bun.write(
    join(home.dir, "auth", "openai.json"),
    JSON.stringify({
      access_token: accessToken(label),
      refresh_token: `${label}-refresh`,
      expires_at_ms: expiresAt,
      account_id: ACCOUNT,
    }),
  )
