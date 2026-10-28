import { BunSocket } from "@effect/platform-bun"
import { NisseRpcs, type Approvals, type ConversationId, type Delivery, type NoSuchConversation } from "@nisse/protocol"
import { spawn } from "node:child_process"
import { mkdirSync, openSync } from "node:fs"
import * as Net from "node:net"
import { Context, Duration, Effect, Layer, Schedule, Stream } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import type { Home } from "./home.ts"

export class Client extends Context.Service<Client, RpcClient.FromGroup<typeof NisseRpcs, RpcClientError>>()(
  "nisse/Client",
) {}

export interface StartOptions {
  readonly provider?: string
  readonly approvals?: Approvals
}

export const startConversation = (client: Client["Service"], existing: string | undefined, options: StartOptions) =>
  existing === undefined
    ? Effect.map(client["conversation/start"]({ cwd: process.cwd(), ...options }), (conversation) => conversation.id)
    : Effect.succeed(existing as ConversationId)

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

const RESUBSCRIBE_DELAY = "50 millis"

const WITHOUT_BUN_GC_TIMER = { BUN_GC_TIMER_DISABLE: "1" }

export const serveCommand = (): Array<string> => {
  const script = process.argv[1]
  return script && /\.[cm]?[jt]sx?$/.test(script) && !script.startsWith("/$bunfs")
    ? [process.execPath, script, "serve"]
    : [process.execPath, "serve"]
}

const startServer = (home: Home) =>
  Effect.sync(() => {
    mkdirSync(home.dir, { recursive: true, mode: 0o700 })
    const log = openSync(home.log, "a")
    const [command, ...args] = serveCommand()
    spawn(command!, args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...WITHOUT_BUN_GC_TIMER },
    }).unref()
  })

const openOrStart = (home: Home) =>
  open(home.socket).pipe(
    Effect.catch(() =>
      Effect.andThen(
        startServer(home),
        open(home.socket).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 })),
      ),
    ),
  )

export const clientLayer = (home: Home) =>
  Layer.effect(Client, RpcClient.make(NisseRpcs)).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket({
        pingInterval: Duration.infinity,
        retryPolicy: Schedule.spaced("50 millis"),
      }),
    ),
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(Layer.effect(Socket.Socket, BunSocket.fromDuplex(openOrStart(home)))),
  )

export const follow = (
  client: Client["Service"],
  conversation: ConversationId,
): Stream.Stream<Delivery, NoSuchConversation> =>
  Stream.suspend(() => {
    let seq: number | undefined
    const subscribe = (): Stream.Stream<Delivery, NoSuchConversation> =>
      client["conversation/subscribe"](seq === undefined ? { conversation } : { conversation, sinceSeq: seq }).pipe(
        Stream.tap((delivery) => Effect.sync(() => (seq = delivery.seq))),
        Stream.catchIf(
          (error) => error._tag !== "NoSuchConversation",
          () => Stream.unwrap(Effect.as(Effect.sleep(RESUBSCRIBE_DELAY), Stream.suspend(subscribe))),
        ),
      )
    return subscribe()
  })
