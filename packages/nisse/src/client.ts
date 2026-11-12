import { BunSocket } from "@effect/platform-bun"
import { type Approvals, NisseRpcs } from "@nisse/protocol"
import { spawn } from "node:child_process"
import { fstatSync, mkdirSync, openSync, readFileSync } from "node:fs"
import * as Net from "node:net"
import { Cause, Context, Data, Duration, Effect, Layer, Schedule, Stream } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import { RpcClientError } from "effect/rpc/RpcClientError"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import { HOME_TAKEN_EXIT, type Home } from "./home.ts"

/** A client of the home's server. */
export class Client extends Context.Service<Client, RpcClient.FromGroup<typeof NisseRpcs, RpcClientError>>()(
  "nisse/Client",
) {}

export interface StartOptions {
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly approvals?: Approvals
  readonly instructions?: string
}

const CLOSE_GRACE = "1 second"

const open = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<Net.Socket, Socket.SocketError>((resume) => {
      const socket = Net.connect(path)
      const onError = (cause: Error) => {
        socket.destroy()
        resume(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })))
      }
      socket.once("error", onError)
      socket.once("connect", () => {
        socket.off("error", onError)
        resume(Effect.succeed(socket))
      })
    }),
    (socket) =>
      Effect.callback<void>((resume) => {
        socket.once("close", () => resume(Effect.void))
        socket.resume()
        socket.end()
      }).pipe(Effect.timeout(CLOSE_GRACE), Effect.ignore, Effect.ensuring(Effect.sync(() => socket.destroy()))),
  )

/** Whether a server answers on the home's socket now; it starts none. */
export const serverAnswers = (home: Home) =>
  Effect.scoped(open(home.socket)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

const WITHOUT_BUN_GC_TIMER = { BUN_GC_TIMER_DISABLE: "1" }

export const serveCommand = (): Array<string> => {
  const script = process.argv[1]
  return script && /\.[cm]?[jt]sx?$/.test(script) && !script.startsWith("/$bunfs")
    ? [process.execPath, script, "serve"]
    : [process.execPath, "serve"]
}

export class ServerFailed extends Data.TaggedError("ServerFailed")<{ readonly output: string }> {}

const startServer = (home: Home) =>
  Effect.sync(() => {
    mkdirSync(home.dir, { recursive: true, mode: 0o700 })
    const log = openSync(home.log, "a")
    const written = fstatSync(log).size
    const [command, ...args] = serveCommand()
    const server = spawn(command!, args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...WITHOUT_BUN_GC_TIMER },
    })
    server.unref()
    return Effect.callback<{ readonly code: number | null; readonly output: string }>((resume) => {
      const exited = (code: number | null) =>
        resume(Effect.sync(() => ({ code, output: readFileSync(home.log).subarray(written).toString().trim() })))
      server.once("exit", exited)
      return Effect.sync(() => server.off("exit", exited))
    })
  })

const openSoon = (home: Home) =>
  open(home.socket).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }))

const openOrStart = (home: Home) =>
  open(home.socket).pipe(
    Effect.catch(() =>
      Effect.flatMap(startServer(home), (exited) =>
        Effect.raceFirst(
          openSoon(home),
          Effect.flatMap(exited, ({ code, output }) =>
            code === HOME_TAKEN_EXIT ? Effect.never : Effect.fail(new ServerFailed({ output })),
          ),
        ),
      ),
    ),
  )

const serverReady = (home: Home) =>
  Effect.scoped(openOrStart(home)).pipe(
    Effect.catchTag("SocketError", () =>
      Effect.fail(new ServerFailed({ output: `nisse's server did not start; see ${home.log}` })),
    ),
  )

const openSocket = (home: Home) =>
  openOrStart(home).pipe(
    Effect.catchTag("ServerFailed", (cause) =>
      Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })),
    ),
  )

/** The home's socket, starting the server when none runs. */
const protocolLayer = (home: Home) =>
  RpcClient.layerProtocolSocket({
    pingInterval: Duration.infinity,
    retryPolicy: Schedule.spaced("50 millis"),
  }).pipe(
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(Layer.effect(Socket.Socket, BunSocket.fromDuplex(openSocket(home)))),
    Layer.provide(Layer.effectDiscard(serverReady(home))),
  )

/**
 * A server that stops interrupts the calls it was answering and reports each one interrupted, which would interrupt the
 * caller as if it were stopped itself. While the client is open, those calls fail as a lost connection does instead, so
 * a caller that asks again or watches again once the server is back does that after a stop as it does after a crash.
 * A caller's own interruption is not a failure and passes through, and so does the client's own close, which ends the
 * calls still waiting with an interrupt: a caller that asks again on a lost connection would otherwise ask forever.
 */
const serverGone = new RpcClientError({
  reason: new Socket.SocketCloseError({ code: 1001, closeReason: "the server stopped" }),
})

const survivingStops = (client: Client["Service"], open: () => boolean): Client["Service"] => {
  const failInterrupts = (cause: Cause.Cause<unknown>) =>
    open() && Cause.hasInterruptsOnly(cause) ? Effect.fail(serverGone) : Effect.failCause(cause)
  return Object.fromEntries(
    Object.entries(client).map(([tag, call]) => [
      tag,
      (...args: Array<unknown>) => {
        const answer = (call as (...args: Array<unknown>) => unknown)(...args)
        return Stream.isStream(answer)
          ? Stream.catchCause(answer, (cause) => Stream.fromEffect(failInterrupts(cause)))
          : Effect.catchCause(answer as Effect.Effect<unknown, unknown>, failInterrupts)
      },
    ]),
  ) as unknown as Client["Service"]
}

export const clientLayer = (home: Home) =>
  Layer.effect(
    Client,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(NisseRpcs)
      // Added after the client's own finalizer, so it runs first, before the client ends what still waits.
      let open = true
      yield* Effect.addFinalizer(() => Effect.sync(() => (open = false)))
      return survivingStops(client, () => open)
    }),
  ).pipe(Layer.provide(protocolLayer(home)))
