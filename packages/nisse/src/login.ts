import type { AuthMethod, AuthState } from "@nisse/protocol"
import { createInterface } from "node:readline"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { Client } from "./client.ts"

const say = (text: string) => process.stderr.write(`${text}\n`)

const remote = () => process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined

const openBrowser = (url: string) => {
  if (remote()) return
  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref()
  } catch {}
}

const pastedLines = (onLine: (line: string) => void) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const lines = createInterface({ input: process.stdin })
      lines.on("line", onLine)
      return lines
    }),
    (lines) => Effect.sync(() => lines.close()),
  )

const runTerminal = (command: ReadonlyArray<string>, env: Readonly<Record<string, string>>) =>
  Effect.promise(async () => {
    try {
      const child = Bun.spawn([...command], {
        env: { ...process.env, ...env },
        stdio: ["inherit", "inherit", "inherit"],
      })
      return (await child.exited) === 0
    } catch {
      return false
    }
  })

export const login = Effect.fnUntraced(function* (provider: string, deviceCode: boolean) {
  const client = yield* Client
  const providers = yield* client["providers/list"]({})
  const known = providers.find((snapshot) => snapshot.id === provider)
  if (!known) {
    say(`no provider named ${provider}; there are ${providers.map((snapshot) => snapshot.id).join(", ")}`)
    return false
  }
  const method: AuthMethod | undefined =
    deviceCode || (remote() && known.signIn.includes("device_code")) ? "device_code" : undefined
  let flow: string | undefined
  const startedFlow = yield* Deferred.make<string>()
  let outcome: AuthState | undefined

  const respond = (line: string) => {
    if (flow === undefined || line.trim() === "") return
    Effect.runFork(client["auth/respond"]({ provider, flow, response: { _tag: "callback", url: line.trim() } }))
  }

  const shown = (state: AuthState) =>
    Effect.gen(function* () {
      const interaction = state.interaction
      if (state.phase === "succeeded") say(`signed in to ${provider}${state.message ? ` as ${state.message}` : ""}`)
      else if (state.phase === "failed") say(`signing in to ${provider} failed: ${state.message ?? "no reason given"}`)
      else if (state.phase === "cancelled") say(`signing in to ${provider} was cancelled`)
      if (over(state)) {
        outcome = state
        return
      }
      if (state.phase !== "waiting" || !interaction) return
      switch (interaction._tag) {
        case "browser":
          say(`Open this address to sign in:\n\n  ${interaction.url}\n`)
          say("A browser on another machine can't reach this one: paste the address it ends on here.")
          openBrowser(interaction.url)
          return
        case "device_code":
          say(`Open ${interaction.url} on any device and enter the code ${interaction.code}`)
          return
        case "terminal": {
          const success = yield* runTerminal(interaction.command, interaction.env)
          yield* client["auth/respond"]({ provider, flow: state.flow, response: { _tag: "terminal_exited", success } })
        }
      }
    })

  yield* pastedLines(respond)
  const watching = client["auth/watch"]().pipe(
    Stream.filterEffect((state) => Effect.map(Deferred.await(startedFlow), (started) => state.flow === started)),
    Stream.tap(shown),
    Stream.takeUntil(over),
    Stream.runDrain,
  )
  const watcher = yield* Effect.forkScoped(watching)
  const started = yield* client["auth/start"]({ provider, ...(method ? { method } : {}) }).pipe(
    Effect.catchTags({
      CannotSignIn: (error) =>
        Effect.andThen(
          Effect.sync(() => say(error.message)),
          Effect.succeed(undefined),
        ),
      UnknownProvider: () => Effect.succeed(undefined),
    }),
  )
  if (!started) return false
  flow = started.flow
  yield* Deferred.succeed(startedFlow, started.flow)
  yield* Effect.onInterrupt(Fiber.join(watcher), () =>
    Effect.ignore(client["auth/cancel"]({ provider, flow: started.flow })),
  )
  return outcome?.phase === "succeeded"
})

const over = (state: AuthState) =>
  state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled"

export const logout = Effect.fnUntraced(function* (provider: string) {
  const client = yield* Client
  return yield* client["auth/logout"]({ provider }).pipe(
    Effect.map((snapshot) => {
      say(`signed out of ${provider}: ${snapshot.health.status.replace("_", " ")}`)
      return true
    }),
    Effect.catchTags({
      CannotSignIn: (error) => Effect.sync(() => (say(error.message), false)),
      UnknownProvider: () => Effect.sync(() => (say(`no provider named ${provider}`), false)),
    }),
  )
})
