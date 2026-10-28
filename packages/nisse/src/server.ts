import { BunSocketServer } from "@effect/platform-bun"
import { NisseRpcs, PROTOCOL_VERSION } from "@nisse/protocol"
import { Console, Duration, Effect, Layer, Stream } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { Conversations } from "./conversations.ts"
import type { Home } from "./home.ts"
import { Lifetime } from "./lifetime.ts"
import type { Providers } from "./provider.ts"
import { Setup } from "./setup.ts"
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
    const setup = yield* Setup
    return NisseRpcs.of({
      initialize: () => Effect.succeed({ version: VERSION, protocol: PROTOCOL_VERSION }),
      "conversation/start": ({ cwd, ...options }) => conversations.start(cwd, options),
      "conversation/select_model": ({ conversation, author, selection }) =>
        conversations.selectModel(conversation, author, selection),
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
      "skills/list": ({ conversation }) => conversations.skills(conversation),
      "server/stop": () => Effect.andThen(conversations.settle, afterReply(lifetime.stop)),
      "providers/list": ({ refresh }) => setup.providers(refresh ?? false),
      "models/list": ({ refresh }) => setup.models(refresh ?? false),
      "auth/start": ({ provider, method }) => setup.start(provider, method),
      "auth/respond": ({ provider, flow, response }) =>
        Effect.map(setup.respond(provider, flow, response), (accepted) => ({ accepted })),
      "auth/cancel": ({ provider, flow }) => Effect.map(setup.cancel(provider, flow), (accepted) => ({ accepted })),
      "auth/logout": ({ provider }) => setup.logout(provider),
      "auth/watch": () => Stream.unwrap(Effect.as(lifetime.hold, setup.watch)),
    })
  }),
)

export const serverLayer = (home: Home, options: { readonly idleGrace: Duration.Input }) => {
  const app = Layer.merge(Conversations.layer, Setup.layer).pipe(
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
