#!/usr/bin/env -S BUN_GC_TIMER_DISABLE=1 bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Schedule } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { UnknownProvider } from "@nisse/protocol"
import { Client, clientLayer, type StartOptions } from "./client.ts"
import { exec } from "./exec.ts"
import { claimHome, defaultHome, type Home } from "./home.ts"
import { openAiOptions, providersLayer } from "./drivers/index.ts"
import { readScript } from "./drivers/script.ts"
import { readHomeConfig } from "./config.ts"
import { login, logout } from "./login.ts"
import { protocolSchema } from "./schema.ts"
import { serve } from "./server.ts"
import { VERSION } from "./version.ts"

const IDLE_GRACE = "30 seconds"

const conversationFlag = Flag.String("conversation").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Open this conversation instead of starting a new one"),
  Flag.optional,
)

const autoFlag = Flag.Boolean("auto").pipe(
  Flag.withDescription("Start the conversation without asking before calls that change things"),
  Flag.withDefault(false),
)

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Start the conversation with this provider, such as openai"),
  Flag.optional,
)

const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("Start the conversation with this model, instead of the default one"),
  Flag.optional,
)

const effortFlag = Flag.String("effort").pipe(
  Flag.withDescription("Start the conversation with this reasoning effort, such as low or high"),
  Flag.optional,
)

const startFlags = { auto: autoFlag, provider: providerFlag, model: modelFlag, effort: effortFlag }

const startWith = (flags: {
  readonly auto: boolean
  readonly provider: Option.Option<string>
  readonly model: Option.Option<string>
  readonly effort: Option.Option<string>
}): StartOptions => ({
  ...(flags.auto ? { approvals: "auto" as const } : {}),
  ...Option.match(flags.provider, { onNone: () => ({}), onSome: (provider) => ({ provider }) }),
  ...Option.match(flags.model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
  ...Option.match(flags.effort, { onNone: () => ({}), onSome: (effort) => ({ effort }) }),
})

const withClient = (home: Home) => Effect.provide(clientLayer(home))

const refuse = (reason: string) =>
  Effect.andThen(
    Console.error(reason),
    Effect.sync(() => {
      process.exitCode = 1
    }),
  )

const unknownProvider = (error: UnknownProvider) => refuse(`nisse has no provider named ${error.provider}`)

const stopRunningServer = (home: Home) =>
  Effect.gen(function* () {
    const client = yield* Client
    yield* client["server/stop"]()
  }).pipe(withClient(home), Effect.scoped, Effect.ignore)

const serveCommand = Command.make(
  "serve",
  {
    restart: Flag.Boolean("restart").pipe(
      Flag.withDescription("Replace the running server once its runs settle"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ restart }) {
    const home = defaultHome()
    if (restart) yield* stopRunningServer(home)
    const claim = claimHome(home)
    const claimed = restart ? claim.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 })) : claim
    const scriptPath = process.env.NISSE_MODEL_SCRIPT
    const providers = Layer.unwrap(
      Effect.gen(function* () {
        const config = yield* readHomeConfig(home.dir)
        return providersLayer({
          ...(scriptPath === undefined ? {} : { script: yield* readScript(scriptPath || undefined) }),
          openai: openAiOptions(home),
          claude: {},
          preferred: scriptPath === undefined ? "claude" : "script",
          config,
        })
      }),
    )
    yield* Effect.scoped(
      Effect.andThen(claimed, serve(home, { idleGrace: IDLE_GRACE }).pipe(Effect.provide(providers))),
    ).pipe(
      Effect.catchTag("HomeTaken", () => refuse(`another server already serves ${home.dir}`)),
      Effect.catchTag("ConfigError", (error) => refuse(`${error.path}: ${error.message}`)),
    )
  }),
).pipe(Command.withDescription("Run this home's server in the foreground"))

const execCommand = Command.make(
  "exec",
  { prompt: Argument.String("prompt"), conversation: conversationFlag, ...startFlags },
  Effect.fn(function* ({ prompt, conversation, ...flags }) {
    const home = defaultHome()
    const ok = yield* exec(prompt, Option.getOrUndefined(conversation), startWith(flags)).pipe(
      withClient(home),
      Effect.scoped,
      Effect.catchTag("UnknownProvider", unknownProvider),
    )
    if (ok === false) process.exitCode = 1
  }),
).pipe(Command.withDescription("Send one prompt, print the answer, and exit"))

const providerArgument = Argument.String("provider").pipe(
  Argument.withDescription("The provider, such as claude or openai, or one config.toml names"),
)

const loginCommand = Command.make(
  "login",
  {
    provider: providerArgument,
    deviceCode: Flag.Boolean("device-code").pipe(
      Flag.withDescription("Sign in with a code entered on any device, instead of a browser on this one"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ provider, deviceCode }) {
    const ok = yield* login(provider, deviceCode).pipe(withClient(defaultHome()), Effect.scoped)
    if (!ok) process.exitCode = 1
  }),
).pipe(Command.withDescription("Sign in to a provider"))

const logoutCommand = Command.make(
  "logout",
  { provider: providerArgument },
  Effect.fn(function* ({ provider }) {
    const ok = yield* logout(provider).pipe(withClient(defaultHome()), Effect.scoped)
    if (!ok) process.exitCode = 1
  }),
).pipe(Command.withDescription("Sign out of a provider"))

const schemaCommand = Command.make(
  "schema",
  {},
  Effect.fn(function* () {
    yield* Console.log(JSON.stringify(protocolSchema(), null, 2))
  }),
).pipe(Command.withDescription("Print the protocol's JSON Schema"))

const nisse = Command.make(
  "nisse",
  { conversation: conversationFlag, ...startFlags },
  Effect.fn(function* ({ conversation, ...flags }) {
    const home = defaultHome()
    const { tui } = yield* Effect.promise(async () => {
      await import("@opentui/solid/preload")
      return import("./tui/main.tsx")
    })
    yield* tui(Option.getOrUndefined(conversation), startWith(flags)).pipe(
      withClient(home),
      Effect.scoped,
      Effect.catchTag("UnknownProvider", unknownProvider),
    )
  }),
).pipe(
  Command.withDescription("A durable, multiplayer coding agent"),
  Command.withSubcommands([serveCommand, execCommand, loginCommand, logoutCommand, schemaCommand]),
)

nisse.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(Layer.mergeAll(BunServices.layer)),
  BunRuntime.runMain({ disableErrorReporting: false }),
)
