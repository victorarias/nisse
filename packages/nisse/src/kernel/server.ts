// The server a home runs under NISSE_KERNEL=1: one Harness over `kernel.sqlite`, served over the home's socket with
// the kernel wire (`@nisse/wire`). The model is the `script` provider until providers come to the kernel.
import { BunSocketServer } from "@effect/platform-bun"
import {
  type ConversationView,
  type ConversationWindow,
  createRegistry,
  openHarness,
  type Harness,
} from "@nisse/harness"
import { type ConversationId, type EntryId, idFromNumber, openSqliteStorage } from "@nisse/kernel"
import { fromProviders, type ScriptStep, scriptProvider, SCRIPT_MODEL } from "@nisse/models"
import {
  FellBehind,
  KERNEL_PROTOCOL_VERSION,
  KernelRpcs,
  NoSuchConversation,
  type View,
  type ViewItem,
  type Window,
} from "@nisse/wire"
import { Cause, Console, Context, type Duration, Effect, Layer, Queue, Stream } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import type { Home } from "../home.ts"
import { Lifetime } from "../lifetime.ts"
import { VERSION } from "../version.ts"
import { writeRunEnd } from "./run-end.ts"

/**
 * The changes one watch may hold unread before its connection is dropped (D10). Receipt: in the wire test
 * `wire-dropped`, 1,500 prompts submitted 100 at a time, a client that reads peaked at 34 queued changes. Past this the
 * client is told it fell behind and watches again from the position it holds.
 */
export const CONNECTION_QUEUE = 4096

export class KernelHarness extends Context.Service<KernelHarness, Harness>()("nisse/KernelHarness") {
  static readonly layer = (home: Home, script: ReadonlyArray<ScriptStep>) =>
    Layer.effect(
      KernelHarness,
      Effect.acquireRelease(
        Effect.flatMap(openSqliteStorage(home.kernel), (storage) =>
          openHarness(storage, {
            registry: createRegistry(),
            models: fromProviders([scriptProvider(script)]),
            runEnded: writeRunEnd,
          }),
        ),
        (harness) => Effect.ignore(harness.close),
      ).pipe(Effect.orDie),
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
    const lifetime = yield* Lifetime
    // Keeps the server up while the harness has work, such as a run a submission started or a crash left.
    const scope = yield* Effect.scope
    const holdUntilIdle = Effect.forkIn(
      Effect.scoped(Effect.andThen(lifetime.hold, Effect.ignore(harness.waitForIdle))),
      scope,
    )
    yield* Effect.orDie(harness.resume)
    yield* holdUntilIdle

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
          const observation = yield* Effect.acquireRelease(
            Effect.orDie(
              harness.observeConversation(
                conversation.id,
                {
                  // On the Session line: only capture. A full queue drops the connection instead of holding the line.
                  advance: (change) => {
                    if (Queue.offerUnsafe(queue, { _tag: "change", ops: change.ops })) return
                    Effect.runSync(Queue.clear(queue))
                    Queue.failCauseUnsafe(queue, Cause.fail(new FellBehind({ limit: CONNECTION_QUEUE })))
                  },
                  end: (end) => {
                    if (end.kind === "ended") Queue.endUnsafe(queue)
                    else Queue.failCauseUnsafe(queue, Cause.die(end.error))
                  },
                },
                toWindow(window),
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
      "conversation/start": ({ cwd }) =>
        Effect.map(
          Effect.orDie(
            harness.createConversation({
              ownership: { kind: "ownerless" },
              agent: { model: { provider: SCRIPT_MODEL.provider, modelId: SCRIPT_MODEL.id }, cwd },
            }),
          ),
          (conversation) => ({ conversation: String(conversation.id) }),
        ),
      "conversation/submit": ({ conversation: id, requestId, text }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const submission = yield* Effect.orDie(conversation.submit({ type: "input", content: text, requestId }))
          yield* holdUntilIdle
          return { submission: submission.id }
        }),
      "conversation/watch": ({ conversation, window }) => watch(conversation, window),
      "conversation/interrupt": ({ conversation: id }) =>
        Effect.flatMap(find(id), (conversation) => Effect.orDie(conversation.abort())),
      "server/stop": () => afterReply(lifetime.stop),
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

export const kernelServerLayer = (
  home: Home,
  options: { readonly idleGrace: Duration.Input; readonly script: ReadonlyArray<ScriptStep> },
) =>
  RpcServer.layer(KernelRpcs).pipe(
    Layer.provide(Handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(BunSocketServer.layer({ path: home.socket })),
    Layer.provideMerge(KernelHarness.layer(home, options.script)),
    Layer.provideMerge(Lifetime.layer(options.idleGrace)),
  )

/** Serves the home until its lifetime ends: stopped, or idle past the grace. */
export const serveKernel = (
  home: Home,
  options: { readonly idleGrace: Duration.Input; readonly script: ReadonlyArray<ScriptStep> },
) =>
  Effect.gen(function* () {
    const lifetime = yield* Lifetime
    yield* Console.error(`nisse ${VERSION} serving ${home.dir} on the kernel`)
    yield* lifetime.ended
  }).pipe(Effect.provide(kernelServerLayer(home, options)), Effect.scoped)
