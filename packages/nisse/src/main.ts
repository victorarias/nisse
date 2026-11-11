#!/usr/bin/env -S BUN_GC_TIMER_DISABLE=1 bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Schedule } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { ExtensionInfo } from "@nisse/protocol"
import { Client, clientLayer, KernelClient, kernelClientLayer, ServerFailed, type StartOptions } from "./client.ts"
import { exec } from "./exec.ts"
import { claimHome, defaultHome, HOME_TAKEN_EXIT, type Home, type HomeTaken } from "./home.ts"
import { openAiOptions, type ProviderOptions, providersLayer } from "./drivers/index.ts"
import { readScript } from "./drivers/script.ts"
import { readHomeConfig } from "./config.ts"
import { login, logout } from "./login.ts"
import { protocolSchema } from "./schema.ts"
import { execOnKernel } from "./kernel/exec.ts"
import { serveKernel } from "./kernel/server.ts"
import { serve } from "./server.ts"
import { VERSION } from "./version.ts"

const IDLE_GRACE = "30 seconds"

const conversationFlag = Flag.String("conversation").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Open this conversation, starting it with this id if there is none"),
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

const instructionsFlag = Flag.String("instructions").pipe(
  Flag.withDescription("Start the conversation with these instructions for the model, beside its own"),
  Flag.optional,
)

const startFlags = {
  auto: autoFlag,
  provider: providerFlag,
  model: modelFlag,
  effort: effortFlag,
  instructions: instructionsFlag,
}

const startWith = (flags: {
  readonly auto: boolean
  readonly provider: Option.Option<string>
  readonly model: Option.Option<string>
  readonly effort: Option.Option<string>
  readonly instructions: Option.Option<string>
}): StartOptions => ({
  ...(flags.auto ? { approvals: "auto" as const } : {}),
  ...Option.match(flags.provider, { onNone: () => ({}), onSome: (provider) => ({ provider }) }),
  ...Option.match(flags.model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
  ...Option.match(flags.effort, { onNone: () => ({}), onSome: (effort) => ({ effort }) }),
  ...Option.match(flags.instructions, { onNone: () => ({}), onSome: (instructions) => ({ instructions }) }),
})

/** Whether this command's server runs the kernel and speaks its wire: `NISSE_KERNEL=1`. */
const onKernel = () => process.env.NISSE_KERNEL === "1"

const refuseFailedServer = <A, E, R>(effect: Effect.Effect<A, E | ServerFailed, R>) =>
  Effect.catchIf(
    effect,
    (error): error is ServerFailed => error instanceof ServerFailed,
    (error) => refuse(error.output),
  )

const withClient =
  (home: Home) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    refuseFailedServer(Effect.provide(effect, clientLayer(home)))

const withKernelClient =
  (home: Home) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    refuseFailedServer(Effect.provide(effect, kernelClientLayer(home)))

/** The client of whichever wire the home's server speaks, for what both serve alike. */
const withEitherClient = <A, E, R>(
  home: Home,
  use: (client: Client["Service"] | KernelClient["Service"]) => Effect.Effect<A, E, R>,
) =>
  onKernel()
    ? Effect.gen(function* () {
        return yield* use(yield* KernelClient)
      }).pipe(withKernelClient(home), Effect.scoped)
    : Effect.gen(function* () {
        return yield* use(yield* Client)
      }).pipe(withClient(home), Effect.scoped)

const refuse = (reason: string, exitCode = 1) =>
  Effect.andThen(
    Console.error(reason),
    Effect.sync(() => {
      process.exitCode = exitCode
    }),
  )

const homeTaken = (home: Home) => refuse(`another server already serves ${home.dir}`, HOME_TAKEN_EXIT)

const unknownProvider = (error: { readonly provider: string }) =>
  refuse(`nisse has no provider named ${error.provider}`)

const stopRunningServer = (home: Home) => Effect.ignore(withEitherClient(home, (client) => client["server/stop"]()))

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
    const claimed = restart
      ? claim.pipe(
          Effect.retry({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: "30 seconds" })) }),
        )
      : claim
    if (onKernel()) return yield* serveKernelHome(home, claimed)
    const providers = Layer.unwrap(Effect.map(providerOptions(home), providersLayer))
    yield* Effect.scoped(
      Effect.andThen(claimed, serve(home, { idleGrace: IDLE_GRACE }).pipe(Effect.provide(providers))),
    ).pipe(
      Effect.catchTag("HomeTaken", () => homeTaken(home)),
      Effect.catchTag("ConfigError", (error) => refuse(`${error.path}: ${error.message}`)),
    )
  }),
).pipe(Command.withDescription("Run this home's server in the foreground"))

/**
 * The home's providers as its `config.toml` and the environment name them: `NISSE_MODEL_SCRIPT` adds `script` and
 * prefers it, and `NISSE_CLAUDE` names the `claude` every Claude provider without a `binary` runs.
 */
const providerOptions = (home: Home) =>
  Effect.gen(function* () {
    const config = yield* readHomeConfig(home.dir)
    const scriptPath = process.env.NISSE_MODEL_SCRIPT
    return {
      ...(scriptPath === undefined ? {} : { script: yield* readScript(scriptPath || undefined) }),
      openai: openAiOptions(home),
      claude: process.env.NISSE_CLAUDE ? { executable: process.env.NISSE_CLAUDE } : {},
      preferred: scriptPath === undefined ? "claude" : "script",
      config,
    } satisfies ProviderOptions
  })

// A stuck code-mode worker survives terminate() and keeps the process alive (F19), so the end of the server's lifetime
// ends the process.
const serveKernelHome = <A, R>(home: Home, claimed: Effect.Effect<A, HomeTaken, R>) =>
  Effect.gen(function* () {
    const served = yield* Effect.scoped(
      Effect.andThen(
        claimed,
        Effect.flatMap(providerOptions(home), (providers) => serveKernel(home, { idleGrace: IDLE_GRACE, providers })),
      ),
    ).pipe(
      Effect.as(true),
      Effect.catchTag("HomeTaken", () => Effect.as(homeTaken(home), false)),
      Effect.catchTag("ConfigError", (error) => Effect.as(refuse(`${error.path}: ${error.message}`), false)),
    )
    if (served) process.exit(0)
  })

const execCommand = Command.make(
  "exec",
  {
    prompt: Argument.String("prompt"),
    conversation: conversationFlag,
    json: Flag.Boolean("json").pipe(
      Flag.withDescription(
        "Print the conversation's view as JSON lines instead of the answer: the view, then each commit's changes to it, until the run ends (on the kernel)",
      ),
      Flag.withDefault(false),
    ),
    ...startFlags,
  },
  Effect.fn(function* ({ prompt, conversation, json, ...flags }) {
    const home = defaultHome()
    const id = Option.getOrUndefined(conversation)
    if (!onKernel()) {
      if (json) return yield* refuse("nisse exec --json prints the kernel wire's view: run it with NISSE_KERNEL=1")
      const ok = yield* exec(prompt, id, startWith(flags)).pipe(
        withClient(home),
        Effect.scoped,
        Effect.catchTag("UnknownProvider", unknownProvider),
      )
      if (ok === false) process.exitCode = 1
      return
    }
    const ok = yield* execOnKernel(prompt, id, startWith(flags), json).pipe(
      withKernelClient(home),
      Effect.scoped,
      Effect.catchTags({
        UnknownProvider: unknownProvider,
        UnknownEffort: (error) =>
          refuse(`nisse knows no effort named ${error.effort}; it knows ${error.efforts.join(", ")}`),
        InvalidConversationId: (error) => refuse(error.message),
        UnreadableImage: (error) => refuse(error.message),
      }),
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
    const ok = yield* withEitherClient(defaultHome(), (client) => login(client, provider, deviceCode))
    if (!ok) process.exitCode = 1
  }),
).pipe(Command.withDescription("Sign in to a provider"))

const logoutCommand = Command.make(
  "logout",
  { provider: providerArgument },
  Effect.fn(function* ({ provider }) {
    const ok = yield* withEitherClient(defaultHome(), (client) => logout(client, provider))
    if (!ok) process.exitCode = 1
  }),
).pipe(Command.withDescription("Sign out of a provider"))

const showExtensions = (home: Home, extensions: ReadonlyArray<ExtensionInfo>) =>
  Effect.gen(function* () {
    if (extensions.length === 0) return yield* Console.log(`no extensions in ${home.extensions}`)
    for (const extension of extensions) {
      yield* Console.log(
        [extension.name, extension.state, extension.path, ...(extension.message ? [extension.message] : [])].join("  "),
      )
    }
    if (extensions.some((extension) => extension.state === "failed")) process.exitCode = 1
  })

const reloadExtensionsCommand = Command.make(
  "reload",
  {},
  Effect.fn(function* () {
    const home = defaultHome()
    yield* withEitherClient(home, (client) =>
      Effect.flatMap(client["extensions/reload"](), (extensions) => showExtensions(home, extensions)),
    )
  }),
).pipe(Command.withDescription("Load every extension again from disk, with its options from config.toml"))

const extensionsCommand = Command.make(
  "extensions",
  {},
  Effect.fn(function* () {
    const home = defaultHome()
    yield* withEitherClient(home, (client) =>
      Effect.flatMap(client["extensions/list"](), (extensions) => showExtensions(home, extensions)),
    )
  }),
).pipe(
  Command.withDescription("List the home's extensions, and why any failed to load"),
  Command.withSubcommands([reloadExtensionsCommand]),
)

const schemaCommand = Command.make(
  "schema",
  {
    kernel: Flag.Boolean("kernel").pipe(
      Flag.withDescription("Print the schema of the wire a server under NISSE_KERNEL=1 speaks"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ kernel }) {
    yield* Console.log(JSON.stringify(protocolSchema(kernel), null, 2))
  }),
).pipe(Command.withDescription("Print the protocol's JSON Schema"))

const nisse = Command.make(
  "nisse",
  {
    prompt: Argument.String("prompt").pipe(
      Argument.withDescription("Send this prompt once it opens"),
      Argument.optional,
    ),
    conversation: conversationFlag,
    ...startFlags,
  },
  Effect.fn(function* ({ prompt, conversation, ...flags }) {
    const home = defaultHome()
    if (onKernel()) {
      const { kernelTui } = yield* Effect.promise(async () => {
        await import("@opentui/solid/preload")
        return import("./tui/kernel.tsx")
      })
      return yield* kernelTui(
        Option.getOrUndefined(conversation),
        startWith(flags),
        Option.getOrUndefined(prompt),
      ).pipe(
        withKernelClient(home),
        Effect.scoped,
        Effect.catchTags({
          UnknownProvider: unknownProvider,
          UnreadableImage: (error) => refuse(error.message),
        }),
      )
    }
    const { tui } = yield* Effect.promise(async () => {
      await import("@opentui/solid/preload")
      return import("./tui/main.tsx")
    })
    yield* tui(Option.getOrUndefined(conversation), startWith(flags), Option.getOrUndefined(prompt)).pipe(
      withClient(home),
      Effect.scoped,
      Effect.catchTag("UnknownProvider", unknownProvider),
    )
  }),
).pipe(
  Command.withDescription("A durable, multiplayer coding agent"),
  Command.withSubcommands([serveCommand, execCommand, loginCommand, logoutCommand, extensionsCommand, schemaCommand]),
)

nisse.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(Layer.mergeAll(BunServices.layer)),
  BunRuntime.runMain({ disableErrorReporting: false }),
)
