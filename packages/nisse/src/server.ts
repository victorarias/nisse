import { BunSocketServer } from "@effect/platform-bun"
import { NisseRpcs, PROTOCOL_VERSION } from "@nisse/protocol"
import { Console, Duration, Effect, Layer, Stream } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { Conversations } from "./conversations.ts"
import type { Home } from "./home.ts"
import { Lifetime } from "./lifetime.ts"
import type { Providers } from "./provider.ts"
import { Store } from "./store.ts"
import { VERSION } from "./version.ts"

const afterReply = (effect: Effect.Effect<void>) =>
  Effect.withFiber((handler) =>
    Effect.sync(() => {
      handler.addObserver(() => Effect.runFork(effect))
    }),
  )

const Handlers = NisseRpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* Store
    const conversations = yield* Conversations
    const lifetime = yield* Lifetime
    return NisseRpcs.of({
      initialize: () => Effect.succeed({ version: VERSION, protocol: PROTOCOL_VERSION }),
      "conversation/start": ({ cwd, provider, approvals }) => conversations.start(cwd, provider, approvals),
      "conversation/list": () => Effect.sync(() => store.list()),
      "conversation/subscribe": ({ conversation, sinceSeq }) =>
        Stream.unwrap(Effect.as(lifetime.hold, store.subscribe(conversation, sinceSeq))),
      "conversation/submit": ({ conversation, requestId, author, text, steer }) =>
        Effect.map(conversations.submit(conversation, requestId, author, text, steer ?? false), (submission) => ({
          submission,
        })),
      "conversation/interrupt": ({ conversation }) => conversations.interrupt(conversation),
      "approval/resolve": ({ conversation, approval, author, allow }) =>
        Effect.map(conversations.resolve(conversation, approval, author, allow), (accepted) => ({ accepted })),
      "server/stop": () => Effect.andThen(conversations.settle, afterReply(lifetime.stop)),
    })
  }),
)

export const serverLayer = (home: Home, options: { readonly idleGrace: Duration.Input }) => {
  const app = Conversations.layer.pipe(
    Layer.provideMerge(Store.layer(home.database)),
    Layer.provideMerge(Lifetime.layer(options.idleGrace)),
  )
  return RpcServer.layer(NisseRpcs).pipe(
    Layer.provide(Handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(BunSocketServer.layer({ path: home.socket })),
    Layer.provideMerge(app),
  )
}

export const serve = (home: Home, options: { readonly idleGrace: Duration.Input }) =>
  Effect.gen(function* () {
    const lifetime = yield* Lifetime
    yield* Console.error(`nisse ${VERSION} serving ${home.dir}`)
    yield* lifetime.ended
  }).pipe(Effect.provide(serverLayer(home, options)), Effect.scoped) satisfies Effect.Effect<void, unknown, Providers>
