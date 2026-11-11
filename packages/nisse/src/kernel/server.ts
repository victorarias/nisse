// The server a home runs under NISSE_KERNEL=1: one Harness over `kernel.sqlite`, served over the home's socket with
// the kernel wire (`@nisse/wire`). Conversations run on the home's providers (`./providers.ts`).
import { BunSocketServer } from "@effect/platform-bun"
import {
  type ConversationView,
  type ConversationWindow,
  createRegistry,
  openHarness,
  type Harness,
} from "@nisse/harness"
import { type ConversationId, type EntryId, idFromNumber, openSqliteStorage } from "@nisse/kernel"
import { fromProviders } from "@nisse/models"
import {
  FellBehind,
  InvalidWindow,
  KERNEL_PROTOCOL_VERSION,
  KernelRpcs,
  NoSuchConversation,
  type View,
  type ViewItem,
  type Window,
} from "@nisse/wire"
import { Cause, Console, Context, type Duration, Effect, Exit, Layer, Queue, Scope, Stream } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import type { ProviderOptions } from "../drivers/index.ts"
import type { Home } from "../home.ts"
import { Lifetime } from "../lifetime.ts"
import { Setup } from "../setup.ts"
import { VERSION } from "../version.ts"
import { agentModel, KernelProviders, LastModelDoc } from "./providers.ts"
import { writeRunEnd } from "./run-end.ts"
import { committedSignIns } from "./sign-ins.ts"

/**
 * The changes one watch may hold unread before it ends with `FellBehind` (D10); the connection stays open. Receipt: in the wire test
 * `wire-dropped`, 1,500 prompts submitted 100 at a time, a client that reads peaked at 34 queued changes. Past this the
 * client is told it fell behind at its next read, and watches again from the position it holds.
 */
export const CONNECTION_QUEUE = 4096

export class KernelHarness extends Context.Service<KernelHarness, Harness>()("nisse/KernelHarness") {
  static readonly layer = (home: Home) =>
    Layer.effect(
      KernelHarness,
      Effect.gen(function* () {
        const { instances } = yield* KernelProviders
        const providers = [...instances.values()].flatMap((instance) => (instance.provider ? [instance.provider] : []))
        return yield* Effect.acquireRelease(
          Effect.flatMap(openSqliteStorage(home.kernel), (storage) =>
            openHarness(storage, {
              registry: createRegistry(),
              models: fromProviders(providers),
              runEnded: writeRunEnd,
            }),
          ),
          (harness) => Effect.ignore(harness.close),
        ).pipe(Effect.orDie)
      }),
    )
}

const conversationId = (id: string): ConversationId | undefined =>
  /^[1-9][0-9]*$/.test(id) ? idFromNumber<ConversationId>(Number(id)) : undefined

const toWindow = (window: Window | undefined): ConversationWindow | undefined =>
  window === undefined
    ? undefined
    : {
        ...(window.from === undefined ? {} : { from: idFromNumber<EntryId>(window.from) }),
        ...(window.min === undefined ? {} : { min: window.min }),
        ...(window.max === undefined ? {} : { max: window.max }),
      }

const Handlers = KernelRpcs.toLayer(
  Effect.gen(function* () {
    const harness = yield* KernelHarness
    const providers = yield* KernelProviders
    const setup = yield* Setup.make(providers.instances, yield* committedSignIns(harness))
    const lifetime = yield* Lifetime
    // Keeps the server up while the harness has work, such as a run a submission started or a crash left.
    const scope = yield* Effect.scope
    // The hold is taken before `admit` and handed to an idle wait that starts after it, so the work `admit` admits
    // is never unheld: an idle wait started earlier can return before the work exists.
    const heldUntilIdle = <A, E>(admit: Effect.Effect<A, E>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const held = yield* Scope.make()
          yield* Scope.provide(lifetime.hold, held)
          const admitted = yield* Effect.exit(restore(admit))
          yield* Effect.forkIn(Effect.ensuring(Effect.ignore(harness.waitForIdle), Scope.close(held, Exit.void)), scope)
          return yield* admitted
        }),
      )
    yield* heldUntilIdle(Effect.orDie(harness.resume))

    const find = (id: string) =>
      Effect.flatMap(
        Effect.suspend(() => {
          const kernelId = conversationId(id)
          return kernelId === undefined ? Effect.succeed(undefined) : Effect.orDie(harness.conversation(kernelId))
        }),
        (conversation) =>
          conversation === undefined
            ? Effect.fail(new NoSuchConversation({ conversation: id }))
            : Effect.succeed(conversation),
      )

    const watch = (id: string, window: Window | undefined) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* lifetime.hold
          const conversation = yield* find(id)
          const queue = yield* Queue.bounded<ViewItem, FellBehind | Cause.Done>(CONNECTION_QUEUE)
          let behind = false
          const observation = yield* Effect.acquireRelease(
            harness
              .observeConversation(
                conversation.id,
                {
                  // On the Session line: only capture. A full queue ends the watch instead of holding the line; what it
                  // held is dropped so the client hears FellBehind at its next read.
                  advance: (change) => {
                    if (behind || Queue.offerUnsafe(queue, { _tag: "change", ops: change.ops })) return
                    behind = true
                    Effect.runSync(Queue.clear(queue))
                    Queue.failCauseUnsafe(queue, Cause.fail(new FellBehind({ limit: CONNECTION_QUEUE })))
                  },
                  end: (end) => {
                    if (end.kind === "ended") Queue.endUnsafe(queue)
                    else Queue.failCauseUnsafe(queue, Cause.die(end.error))
                  },
                },
                toWindow(window),
              )
              .pipe(
                Effect.orDie,
                // The harness checks the window's bounds and names the one that is wrong.
                Effect.catchDefect((defect) =>
                  defect instanceof RangeError
                    ? Effect.fail(new InvalidWindow({ message: defect.message }))
                    : Effect.die(defect),
                ),
              ),
            (attached) => Effect.sync(() => attached.detach()),
          )
          const first: ViewItem = { _tag: "view", view: toView(observation.value) }
          return Stream.concat(Stream.make(first), Stream.fromQueue(queue))
        }),
      )

    return KernelRpcs.of({
      initialize: () => Effect.succeed({ version: VERSION, protocol: KERNEL_PROTOCOL_VERSION }),
      "conversation/start": ({ cwd, ...ask }) =>
        Effect.gen(function* () {
          const last = yield* Effect.orDie(harness.session.snapshot(LastModelDoc))
          const { selection, instance } = yield* providers.choose(cwd, ask, last?.selection)
          const model = yield* agentModel(selection, instance)
          const conversation = yield* Effect.orDie(
            harness.createConversation({
              ownership: { kind: "ownerless" },
              agent: { ...model, cwd },
              init: (tx) =>
                Effect.map(tx.doc(LastModelDoc), (doc) => {
                  doc.selection = { ...selection }
                }),
            }),
          )
          return { conversation: String(conversation.id), model: selection }
        }),
      "conversation/submit": ({ conversation: id, requestId, text }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const submission = yield* heldUntilIdle(
            Effect.orDie(conversation.submit({ type: "input", content: text, requestId })),
          )
          return { submission: submission.id }
        }),
      "conversation/watch": ({ conversation, window }) => watch(conversation, window),
      "conversation/interrupt": ({ conversation: id }) =>
        Effect.flatMap(find(id), (conversation) => Effect.orDie(conversation.abort())),
      // Stops once the runs in flight settle, as the shipping server does; a run is never cut off by a stop.
      "server/stop": () => Effect.andThen(Effect.ignore(harness.waitForIdle), afterReply(lifetime.stop)),
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

/** The view as the wire carries it: kernel ids are plain numbers already. */
const toView = (view: ConversationView): View => view as unknown as View

const afterReply = (effect: Effect.Effect<void>) =>
  Effect.withFiber((handler) =>
    Effect.sync(() => {
      handler.addObserver(() => Effect.runFork(effect))
    }),
  )

export interface KernelServerOptions {
  readonly idleGrace: Duration.Input
  readonly providers: ProviderOptions
}

export const kernelServerLayer = (home: Home, options: KernelServerOptions) =>
  RpcServer.layer(KernelRpcs).pipe(
    Layer.provide(Handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(BunSocketServer.layer({ path: home.socket })),
    Layer.provideMerge(KernelHarness.layer(home)),
    Layer.provideMerge(KernelProviders.layer(options.providers)),
    Layer.provideMerge(Lifetime.layer(options.idleGrace)),
  )

/** Serves the home until its lifetime ends: stopped, or idle past the grace. */
export const serveKernel = (home: Home, options: KernelServerOptions) =>
  Effect.gen(function* () {
    const lifetime = yield* Lifetime
    yield* Console.error(`nisse ${VERSION} serving ${home.dir} on the kernel`)
    yield* lifetime.ended
  }).pipe(Effect.provide(kernelServerLayer(home, options)), Effect.scoped)
