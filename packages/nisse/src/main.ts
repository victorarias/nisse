#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Schedule } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Client, clientLayer } from "./client.ts"
import { exec } from "./exec.ts"
import { claimHome, defaultHome, type Home } from "./home.ts"
import { providersFromScript } from "./drivers/script.ts"
import { protocolSchema } from "./schema.ts"
import { serve } from "./server.ts"
import { tui } from "./tui/main.tsx"
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

const approvalsFrom = (auto: boolean) => (auto ? ("auto" as const) : undefined)

const withClient = (home: Home) => Effect.provide(clientLayer(home))

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
    yield* Effect.scoped(
      Effect.andThen(
        claimed,
        serve(home, { idleGrace: IDLE_GRACE }).pipe(
          Effect.provide(providersFromScript(process.env.NISSE_MODEL_SCRIPT || undefined)),
        ),
      ),
    ).pipe(Effect.catchTag("HomeTaken", () => Console.error(`another server already serves ${home.dir}`)))
  }),
).pipe(Command.withDescription("Run this home's server in the foreground"))

const execCommand = Command.make(
  "exec",
  { prompt: Argument.String("prompt"), conversation: conversationFlag, auto: autoFlag },
  Effect.fn(function* ({ prompt, conversation, auto }) {
    const home = defaultHome()
    const ok = yield* exec(prompt, Option.getOrUndefined(conversation), approvalsFrom(auto)).pipe(
      withClient(home),
      Effect.scoped,
    )
    if (!ok) process.exitCode = 1
  }),
).pipe(Command.withDescription("Send one prompt, print the answer, and exit"))

const schemaCommand = Command.make(
  "schema",
  {},
  Effect.fn(function* () {
    yield* Console.log(JSON.stringify(protocolSchema(), null, 2))
  }),
).pipe(Command.withDescription("Print the protocol's JSON Schema"))

const nisse = Command.make(
  "nisse",
  { conversation: conversationFlag, auto: autoFlag },
  Effect.fn(function* ({ conversation, auto }) {
    const home = defaultHome()
    yield* tui(Option.getOrUndefined(conversation), approvalsFrom(auto)).pipe(withClient(home), Effect.scoped)
  }),
).pipe(
  Command.withDescription("A durable, multiplayer coding agent"),
  Command.withSubcommands([serveCommand, execCommand, schemaCommand]),
)

nisse.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(Layer.mergeAll(BunServices.layer)),
  BunRuntime.runMain({ disableErrorReporting: false }),
)
