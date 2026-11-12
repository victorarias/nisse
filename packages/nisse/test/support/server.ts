// A server, in process or as the `nisse` binary, and a raw client's view of a conversation over the wire: the first
// view with every later change applied, as a client keeps it.
import { applyImmutable, type Op } from "@nisse/delta"
import type { ScriptStep } from "@nisse/models"
import {
  type EntryRecord,
  RUN_END_KIND,
  WITHDRAWN_KIND,
  USER_KIND,
  type RunEnd,
  type View,
  type ViewItem,
  type Window,
} from "@nisse/protocol"
import type { ClaudeProcessSettings } from "@nisse/claude"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { type Duration, Effect, Exit, Layer, Logger, Scope } from "effect"
import type { HomeConfig } from "../../src/config.ts"
import { homeAt, type Home } from "../../src/home.ts"
import { openAiOptions, type OpenAiOptions, type ProviderOptions } from "../../src/providers.ts"
import { serverLayer } from "../../src/server.ts"
import { Lifetime } from "../../src/lifetime.ts"
import { defaultClaude } from "./claude.ts"
import { deadline, RawClient, type Reply } from "./raw.ts"
import { nisse, nisseEnv } from "./terminal.ts"

export { homeAt }

// The real path: on macOS /tmp is a link, and a process's working directory is never reported through it.
export const tempHome = () => homeAt(realpathSync(mkdtempSync("/tmp/nisse-")))

/** What a server logs, kept beside the console it still prints to. */
export const logRecorder = () => {
  const logged: Array<{ readonly level: string; readonly message: unknown }> = []
  const recorder = Logger.make(({ logLevel, message }) => {
    logged.push({ level: logLevel, message })
  })
  return { logged, recorder: Logger.layer([recorder], { mergeWithExisting: true }) }
}

export interface ServerOptions {
  readonly home?: Home
  readonly openai?: (home: Home) => (id: string) => OpenAiOptions
  readonly claude?: ClaudeProcessSettings
  readonly config?: HomeConfig
}

/** The providers a test's server has: `script` playing `script` and preferred, then those `options` configure. */
const testProviders = (
  home: Home,
  script: ReadonlyArray<ScriptStep>,
  options: ServerOptions = {},
): ProviderOptions => ({
  script,
  openai: (options.openai ?? openAiOptions)(home),
  claude: options.claude ?? defaultClaude(home.dir),
  preferred: "script",
  config: options.config ?? {},
})

export const runningServer = async (
  script: ReadonlyArray<ScriptStep> = [],
  options: ServerOptions & { readonly connectionQueue?: number; readonly readOnly?: boolean } = {},
) => {
  const home = options.home ?? tempHome()
  const scope = Effect.runSync(Scope.make())
  const { logged, recorder } = logRecorder()
  await Effect.runPromise(
    Layer.buildWithScope(
      serverLayer(home, {
        idleGrace: "1 hour",
        providers: testProviders(home, script, options),
        ...(options.connectionQueue === undefined ? {} : { connectionQueue: options.connectionQueue }),
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      }).pipe(Layer.provide(recorder)),
      scope,
    ),
  )
  const stop = () => Effect.runPromise(Scope.close(scope, Exit.void))
  return {
    home,
    logged,
    stop,
    [Symbol.asyncDispose]: async () => {
      await stop()
      if (!options.home) rmSync(home.dir, { recursive: true, force: true })
    },
  }
}

/** A server serving `home` until its lifetime ends; `exited` resolves when it has. */
export const servingUntilIdle = async (
  home: Home,
  idleGrace: Duration.Input,
  script: ReadonlyArray<ScriptStep> = [],
) => {
  const listening = Promise.withResolvers<void>()
  const exited = Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* Lifetime
      listening.resolve()
      yield* lifetime.ended
    }).pipe(Effect.provide(serverLayer(home, { idleGrace, providers: testProviders(home, script) })), Effect.scoped),
  )
  await Promise.race([listening.promise, exited])
  return { exited }
}

/** The environment of a `nisse` binary answering from `script`. */
export const scriptEnv = async (home: Home, script: ReadonlyArray<ScriptStep> = []) => {
  const path = `${home.dir}/script.json`
  await Bun.write(path, JSON.stringify(script))
  return nisseEnv(home, { NISSE_MODEL_SCRIPT: path })
}

/** `nisse serve`, or the command `args` name, run in `cwd`, once it listens. */
export const serving = async (env: Record<string, string | undefined>, cwd?: string, args = ["serve"]) => {
  const server = nisse(args, env, cwd)
  const log = server.stderr.getReader()
  let printed = ""
  while (!printed.includes("serving")) {
    const { value, done } = await deadline(log.read(), 10_000, "server listening")
    if (done) throw new Error(`server exited: ${printed}`)
    printed += new TextDecoder().decode(value)
  }
  log.releaseLock()
  return server
}

export interface ViewWatch {
  readonly id: number
  readonly items: ReadonlyArray<ViewItem>
  readonly ended: Promise<Reply>
  /** The view as the client holds it: the first view with every change since applied. */
  readonly view: () => View
  /** Every entry the view has held, by id: a window lets old entries go, a client keeps what it saw. */
  readonly seen: () => ReadonlyArray<EntryRecord>
  readonly until: (predicate: (watch: ViewWatch) => boolean, ms?: number) => Promise<void>
}

export const watchView = (client: RawClient, conversation: string, window?: Window): ViewWatch => {
  const watch = client.watch<ViewItem>("conversation/watch", { conversation, ...(window ? { window } : {}) })
  let view: View | undefined
  let applied = 0
  const seen = new Map<number, EntryRecord>()
  const current = () => {
    for (; applied < watch.items.length; applied++) {
      const item = watch.items[applied]!
      view = item._tag === "view" ? item.view : applyImmutable(view, item.ops as ReadonlyArray<Op>)
      for (const entry of view!.entries) seen.set(entry.id, entry)
    }
    return view
  }
  const self: ViewWatch = {
    id: watch.id,
    items: watch.items,
    ended: watch.ended,
    view: () =>
      current() ??
      (() => {
        throw new Error("no view yet")
      })(),
    seen: () => {
      current()
      return [...seen.values()].sort((a, b) => a.id - b.id)
    },
    until: (predicate, ms) => watch.until(() => current() !== undefined && predicate(self), ms),
  }
  return self
}

export const runEnds = (entries: ReadonlyArray<EntryRecord>): ReadonlyArray<RunEnd> =>
  entries.filter((entry) => entry.kind === RUN_END_KIND).map((entry) => entry.data as RunEnd)

/** Until `count` runs have ended and the conversation has no run in flight. */
export const settled = (count: number) => (watch: ViewWatch) =>
  runEnds(watch.seen()).length >= count &&
  (watch.view().docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined

/** What the entries say, in order: the user's text, the model's text, and how each run ended. */
export const transcript = (entries: ReadonlyArray<EntryRecord>) =>
  entries.flatMap((entry): Array<string> => {
    const message = entry.model?.[0] as { content?: unknown; stopReason?: string } | undefined
    const text = (content: unknown) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
          : ""
    if (entry.kind === "pi.user" || entry.kind === USER_KIND) return [`user: ${text(message?.content)}`]
    if (entry.kind === "pi.assistant") {
      const cut = message?.stopReason === "stop" || message?.stopReason === "toolUse" ? "" : ` [${message?.stopReason}]`
      return [`assistant: ${text(message?.content)}${cut}`]
    }
    if (entry.kind === RUN_END_KIND) {
      const end = entry.data as RunEnd
      return [`run_end: ${end.outcome}${end.message ? ` (${end.message})` : ""}`]
    }
    if (entry.kind === WITHDRAWN_KIND) return [`withdrawn: ${(entry.data as { requestId: string }).requestId}`]
    return []
  })

export const start = async (client: RawClient, cwd = "/work") =>
  (await client.call("conversation/start", { cwd })).result.conversation as string

export const submit = (
  client: RawClient,
  conversation: string,
  text: string,
  requestId: string = crypto.randomUUID(),
  author = "ada",
  steer = false,
) => client.call("conversation/submit", { conversation, requestId, author, text, ...(steer ? { steer } : {}) })
