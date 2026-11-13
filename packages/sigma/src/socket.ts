// The home's socket server, where a client hanging up ends its connection the way a clean close does.
import { BunSocketServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import * as Socket from "effect/socket/Socket"
import * as SocketServer from "effect/socket/SocketServer"

// What node:net reports when the client is already gone. A reply written after the client closed fails with EPIPE, and
// node:net reports a write failure on the socket's one 'error' event, which Effect's NodeSocket labels a read error.
const CLIENT_GONE = new Set(["EPIPE", "ECONNRESET"])

const clientGone = (error: Socket.SocketError) =>
  error.reason._tag === "SocketReadError" &&
  CLIENT_GONE.has((error.reason.cause as { readonly code?: string } | undefined)?.code ?? "")

// RpcServer ends a connection quietly on a close and logs anything else as an unhandled error, so a client gone is
// reported to it as the close it is. Every other socket failure passes through and is still logged.
const hangUpAsClose = (socket: Socket.Socket): Socket.Socket =>
  Socket.make({
    reader: Effect.map(socket.reader, (reader) => ({
      ...reader,
      pull: Effect.mapError(reader.pull, (error) =>
        clientGone(error) ? new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) }) : error,
      ),
    })),
    writer: socket.writer,
  })

export const homeSocketServer = (path: string) =>
  Layer.effect(
    SocketServer.SocketServer,
    Effect.map(SocketServer.SocketServer, (server) =>
      SocketServer.SocketServer.of({
        address: server.address,
        run: (handler) => server.run((socket) => handler(hangUpAsClose(socket))),
      }),
    ),
  ).pipe(Layer.provide(BunSocketServer.layer({ path })))
