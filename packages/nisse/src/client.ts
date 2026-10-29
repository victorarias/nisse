import { BunSocket } from "@effect/platform-bun"
import { NisseRpcs, type Approvals, type ConversationId, type Delivery, type NoSuchConversation } from "@nisse/protocol"
import { spawn } from "node:child_process"
import { fstatSync, mkdirSync, openSync, readFileSync } from "node:fs"
import * as Net from "node:net"
import { Context, Data, Duration, Effect, Layer, Queue, Schedule, type Scope, Stream } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import { homeHeld, type Home } from "./home.ts"

export class Client extends Context.Service<Client, RpcClient.FromGroup<typeof NisseRpcs, RpcClientError>>()(
  "nisse/Client",
) {}

export interface StartOptions {
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
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
    return Effect.callback<string>((resume) => {
      const exited = () => resume(Effect.sync(() => readFileSync(home.log).subarray(written).toString().trim()))
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
          Effect.flatMap(exited, (output) =>
            homeHeld(home) ? Effect.never : Effect.fail(new ServerFailed({ output })),
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

export const clientLayer = (home: Home) =>
  Layer.effect(Client, RpcClient.make(NisseRpcs)).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket({
        pingInterval: Duration.infinity,
        retryPolicy: Schedule.spaced("50 millis"),
      }),
    ),
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(Layer.effect(Socket.Socket, BunSocket.fromDuplex(openSocket(home)))),
    Layer.provide(Layer.effectDiscard(serverReady(home))),
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

export interface Followed {
  readonly conversation: ConversationId
  readonly delivery: Delivery
}

const subagentsIn = (delivery: Delivery) =>
  delivery.entries.flatMap((entry) => (entry.body._tag === "subagent" ? [entry.body.conversation] : []))

export const followTree = (
  client: Client["Service"],
  root: ConversationId,
): Stream.Stream<Followed, NoSuchConversation> =>
  Stream.callback<Followed, NoSuchConversation>((queue) => {
    const followed = new Set<ConversationId>()
    const track = (conversation: ConversationId): Effect.Effect<void, NoSuchConversation, Scope.Scope> =>
      follow(client, conversation).pipe(
        Stream.runForEach((delivery) =>
          Effect.andThen(
            Queue.offer(queue, { conversation, delivery }),
            Effect.forEach(subagentsIn(delivery), (subagent) => trackOnce(subagent, Effect.ignore), { discard: true }),
          ),
        ),
      )
    const trackOnce = (
      conversation: ConversationId,
      ended: (tracked: Effect.Effect<void, NoSuchConversation, Scope.Scope>) => Effect.Effect<void, never, Scope.Scope>,
    ) =>
      Effect.suspend(() => {
        if (followed.has(conversation)) return Effect.void
        followed.add(conversation)
        return Effect.asVoid(Effect.forkScoped(ended(track(conversation))))
      })
    return trackOnce(root, (tracked) => Effect.catch(tracked, (error) => Queue.fail(queue, error)))
  })
