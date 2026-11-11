// A server under NISSE_KERNEL=1, in process or as the `nisse` binary, and a raw client's view of a conversation over
// the kernel wire: the first view with every later change applied, as a client keeps it.
import { applyImmutable, type Op } from "@nisse/delta"
import type { ScriptStep } from "@nisse/models"
import {
  type EntryRecord,
  RUN_END_KIND,
  USER_KIND,
  type RunEnd,
  type View,
  type ViewItem,
  type Window,
} from "@nisse/wire"
import { rmSync } from "node:fs"
import { type Duration, Effect, Exit, Layer, Scope } from "effect"
import type { Home } from "../../src/home.ts"
import { openAiOptions, type ProviderOptions } from "../../src/drivers/index.ts"
import { kernelServerLayer } from "../../src/kernel/server.ts"
import { Lifetime } from "../../src/lifetime.ts"
import { defaultClaude } from "./claude.ts"
import { deadline, RawClient, type Reply } from "./raw.ts"
import { logRecorder, type ServerOptions, tempHome } from "./server.ts"
import { nisse, nisseEnv } from "./terminal.ts"

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

export const runningKernelServer = async (
  script: ReadonlyArray<ScriptStep> = [],
  options: ServerOptions & { readonly connectionQueue?: number } = {},
) => {
  const home = options.home ?? tempHome()
  const scope = Effect.runSync(Scope.make())
  const { logged, recorder } = logRecorder()
  await Effect.runPromise(
    Layer.buildWithScope(
      kernelServerLayer(home, {
        idleGrace: "1 hour",
        providers: testProviders(home, script, options),
        ...(options.connectionQueue === undefined ? {} : { connectionQueue: options.connectionQueue }),
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

/** A kernel server serving `home` until its lifetime ends; `exited` resolves when it has. */
export const servingKernelUntilIdle = async (
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
    }).pipe(
      Effect.provide(kernelServerLayer(home, { idleGrace, providers: testProviders(home, script) })),
      Effect.scoped,
    ),
  )
  await Promise.race([listening.promise, exited])
  return { exited }
}

/** The environment of a `nisse` binary on the kernel, answering from `script`. */
export const kernelEnv = async (home: Home, script: ReadonlyArray<ScriptStep> = []) => {
  const path = `${home.dir}/script.json`
  await Bun.write(path, JSON.stringify(script))
  return nisseEnv(home, { NISSE_KERNEL: "1", NISSE_MODEL_SCRIPT: path })
}

/** `nisse serve` on the kernel, or the command `args` name, run in `cwd`, once it listens. */
export const servingKernel = async (env: Record<string, string | undefined>, cwd?: string, args = ["serve"]) => {
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
    return []
  })

export const start = async (client: RawClient, cwd = "/work") =>
  (await client.call("conversation/start", { cwd })).result.conversation as string

export const submit = (
  client: RawClient,
  conversation: string,
  text: string,
  requestId = crypto.randomUUID(),
  author = "ada",
  steer = false,
) => client.call("conversation/submit", { conversation, requestId, author, text, ...(steer ? { steer } : {}) })
