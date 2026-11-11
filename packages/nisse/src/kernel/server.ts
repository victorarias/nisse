// The server a home runs under NISSE_KERNEL=1: one Harness over `kernel.sqlite`, served over the home's socket with
// the kernel wire (`@nisse/wire`). Conversations run on the home's providers (`./providers.ts`).
import { BunSocketServer } from "@effect/platform-bun"
import { claudeRunTasks } from "@nisse/claude"
import { LocalExecutionEnv } from "@nisse/env/local"
import {
  answerApproval,
  approveAutomatically,
  type ConversationView,
  type ConversationWindow,
  createRegistry,
  type EndedRun,
  openHarness,
  type Harness,
} from "@nisse/harness"
import { type ConversationId, type EntryId, idFromNumber, openSqliteStorage, type Tx } from "@nisse/kernel"
import { fromProviders } from "@nisse/models"
import {
  FellBehind,
  InvalidConversationId,
  InvalidWindow,
  KERNEL_PROTOCOL_VERSION,
  KernelRpcs,
  NoSuchApproval,
  NoSuchConversation,
  RUN_END_KIND,
  USER_KIND,
  type View,
  type ViewItem,
  type Window,
} from "@nisse/wire"
import { Cause, Console, Context, type Duration, Effect, Exit, Layer, Queue, Scope, Semaphore, Stream } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import type { ModelAsk } from "../config.ts"
import type { ProviderOptions } from "../drivers/index.ts"
import type { Home } from "../home.ts"
import { Lifetime } from "../lifetime.ts"
import { Setup } from "../setup.ts"
import { VERSION } from "../version.ts"
import { chosenNumber, ConversationIdsDoc, kernelNumber, refusedChoice } from "./ids.ts"
import { agentModel, KernelProviders, LastModelDoc, selectionOf } from "./providers.ts"
import { countStops, restartLimitMessage } from "./restarts.ts"
import { writeRunEnd } from "./run-end.ts"
import { committedSignIns } from "./sign-ins.ts"
import { NisseTools } from "./tools.ts"
import { AGENTS_EXTENSION, agentTools, interruptTree } from "./agents.ts"
import { type KernelExtensions, openKernelExtensions, StatusLinesDoc } from "./extensions.ts"
import { followTreeStatus, type TreeStatuses } from "./status.ts"
import { workspaceInstructions } from "./workspace.ts"

/**
 * The changes one watch may hold unread before it ends with `FellBehind` (D10); the connection stays open. Receipt: in the wire test
 * `wire-dropped`, 1,500 prompts submitted 100 at a time, a client that reads peaked at 34 queued changes. Past this the
 * client is told it fell behind at its next read, and watches again from the position it holds.
 */
export const CONNECTION_QUEUE = 4096

/**
 * The home's Harness, and the runs the server stopped too often in a row (D12): counted as it opens, before anything
 * runs, and ended `restart_limit` once scheduling resumes.
 */
export type KernelHarnessService = {
  readonly harness: Harness
  readonly stoppedTooOften: Map<ConversationId, number>
  readonly extensions: KernelExtensions
  readonly status: TreeStatuses
}

export class KernelHarness extends Context.Service<KernelHarness, KernelHarnessService>()("nisse/KernelHarness") {
  static readonly layer = (home: Home) =>
    Layer.effect(
      KernelHarness,
      Effect.gen(function* () {
        const { instances, agents, claude } = yield* KernelProviders
        const stoppedTooOften = new Map<ConversationId, number>()
        const registry = createRegistry()
        const base = [NisseTools, agentTools(agents)]
        for (const extension of base) registry.install(extension)
        registry.install(workspaceInstructions(home, instances))
        // Claude Code has its own tools and subagents, so nisse's built-in ones are not offered to it.
        const claudeRuns = claudeRunTasks({
          settings: (provider) => claude.get(provider),
          builtinExtensions: new Set([NisseTools.name, AGENTS_EXTENSION]),
        })
        registry.install({ name: "claude", tasks: [claudeRuns.run, claudeRuns.subagent] })
        // A run ended for the limit was aborted; its run_end says why.
        const runEnded = (tx: Tx, run: EndedRun) => {
          // The first run to end after the abort is the one the limit stopped, however it ended.
          const stops = stoppedTooOften.get(run.conversationId)
          stoppedTooOften.delete(run.conversationId)
          if (stops === undefined || run.answered || run.end.status === "done") return writeRunEnd(tx, run)
          return Effect.asVoid(
            tx.appendEntry(run.conversationId, {
              kind: RUN_END_KIND,
              data: { outcome: "restart_limit", message: restartLimitMessage(stops) },
            }),
          )
        }
        const harness = yield* Effect.acquireRelease(
          Effect.flatMap(openSqliteStorage(home.kernel), (storage) =>
            openHarness(storage, {
              registry,
              models: fromProviders(
                [...instances.values()].flatMap((instance) => (instance.provider ? [instance.provider] : [])),
              ),
              env: ({ cwd }) => Effect.succeed(new LocalExecutionEnv({ cwd: cwd ?? home.dir })),
              runEnded,
              viewDocs: [StatusLinesDoc],
              runTasks: claudeRuns.runTasks,
            }),
          ),
          (harness) => Effect.ignore(harness.close),
        )
        for (const [id, stops] of yield* countStops(harness)) stoppedTooOften.set(id, stops)
        const status = yield* followTreeStatus(harness)
        // Loaded before anything runs, so the extensions guard the calls a restart resumes.
        const extensions = yield* openKernelExtensions(home, registry, base, () => harness)
        return { harness, stoppedTooOften, extensions, status }
      }).pipe(Effect.orDie),
    )
}

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
    const { harness, stoppedTooOften, extensions, status } = yield* KernelHarness
    const providers = yield* KernelProviders
    const setup = yield* Setup.make(providers.instances, yield* committedSignIns(harness))
    const lifetime = yield* Lifetime
    // Keeps the server up while the harness has work, such as a run a submission started or a crash left.
    const scope = yield* Effect.scope
    // The hold is taken before `admit` and handed to an idle wait that starts after it, so the work `admit` admits
    // is never unheld: an idle wait started earlier can return before the work exists.
    // The harness's idle leaves out work under background tasks, such as a subagent and its reporter, so the hold also
    // waits for every task left; a blocked task waits for a person, not for the server.
    const quiet = Effect.gen(function* () {
      for (;;) {
        yield* harness.waitForIdle
        const live = (yield* harness.inspect).tasks.filter((task) => task.state.kind !== "blocked")
        if (live.length === 0) return
        yield* Effect.forEach(live, (task) => harness.waitForTask(task.record.id), {
          concurrency: "unbounded",
          discard: true,
        })
      }
    })
    const heldUntilIdle = <A, E>(admit: Effect.Effect<A, E>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const held = yield* Scope.make()
          yield* Scope.provide(lifetime.hold, held)
          const admitted = yield* Effect.exit(restore(admit))
          yield* Effect.forkIn(Effect.ensuring(Effect.ignore(quiet), Scope.close(held, Exit.void)), scope)
          return yield* admitted
        }),
      )
    yield* heldUntilIdle(Effect.orDie(harness.resume))
    // Ends each run the server stopped during too often; its run_end says restart_limit.
    for (const id of stoppedTooOften.keys()) {
      yield* heldUntilIdle(
        Effect.orDie(Effect.flatMap(harness.conversation(id), (conversation) => conversation?.abort() ?? Effect.void)),
      )
    }

    /** The kernel number of a wire id: a chosen id's mapping, or the number it is. */
    const resolve = (id: string) =>
      Effect.map(Effect.orDie(harness.session.snapshot(ConversationIdsDoc)), (chosen) => {
        const mapped = chosenNumber(chosen, id)
        return mapped === undefined ? kernelNumber(id) : idFromNumber<ConversationId>(mapped)
      })

    const find = (id: string) =>
      Effect.flatMap(
        Effect.flatMap(resolve(id), (kernelId) =>
          kernelId === undefined ? Effect.succeed(undefined) : Effect.orDie(harness.conversation(kernelId)),
        ),
        (conversation) =>
          conversation === undefined
            ? Effect.fail(new NoSuchConversation({ conversation: id }))
            : Effect.succeed(conversation),
      )

    // Starts with a chosen id one at a time, so two starts with one new id make one conversation.
    const choosing = yield* Semaphore.make(1)

    const startConversation = (
      cwd: string,
      id: string | undefined,
      approvals: "ask" | "auto" | undefined,
      instructions: string | undefined,
      ask: ModelAsk,
    ) =>
      Effect.gen(function* () {
        const last = yield* Effect.orDie(harness.session.snapshot(LastModelDoc))
        const { selection, instance } = yield* providers.choose(cwd, ask, last?.selection)
        const model = yield* agentModel(selection, instance)
        // One commit: a second start with the same id finds the first one's mapping.
        let started: ConversationId | undefined
        const conversation = yield* Effect.orDie(
          harness.createConversation({
            ownership: { kind: "ownerless" },
            agent: { ...model, cwd, ...(instructions === undefined ? {} : { instructions }) },
            init: (tx, created) =>
              Effect.gen(function* () {
                started = created
                if (approvals === "auto") yield* approveAutomatically(tx, created)
                if (id !== undefined) (yield* tx.doc(ConversationIdsDoc)).ids[id] = Number(created)
                ;(yield* tx.doc(LastModelDoc)).selection = { ...selection }
              }),
          }),
        )
        return { conversation: id ?? String(started ?? conversation.id), model: selectionOf(model) }
      })

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
      "conversation/start": ({ cwd, id, approvals, instructions, ...ask }) =>
        Effect.gen(function* () {
          if (id === undefined) return yield* startConversation(cwd, undefined, approvals, instructions, ask)
          const refused = refusedChoice(id)
          if (refused !== undefined) return yield* Effect.fail(new InvalidConversationId({ message: refused }))
          return yield* choosing.withPermits(1)(
            Effect.gen(function* () {
              const existing = chosenNumber(yield* Effect.orDie(harness.session.snapshot(ConversationIdsDoc)), id)
              if (existing === undefined) return yield* startConversation(cwd, id, approvals, instructions, ask)
              const agent = yield* Effect.orDie(harness.resolveAgent(idFromNumber<ConversationId>(existing)))
              return { conversation: id, model: selectionOf(agent) }
            }),
          )
        }),
      "conversation/submit": ({ conversation: id, requestId, author, text, steer }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const entry = { kind: USER_KIND, data: { author } }
          const submission = yield* heldUntilIdle(
            Effect.orDie(
              conversation.submit({
                type: "input",
                content: text,
                requestId,
                entry,
                ...(steer ? { whenBusy: "steer" as const } : {}),
              }),
            ),
          )
          return { submission: submission.id }
        }),
      "conversation/watch": ({ conversation, window }) => watch(conversation, window),
      "conversation/interrupt": ({ conversation: id }) =>
        Effect.flatMap(find(id), (conversation) => Effect.orDie(interruptTree(harness, conversation.id))),
      "approval/resolve": ({ conversation: id, approval, author, allow }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const answered = yield* Effect.orDie(
            conversation.commit((tx) =>
              answerApproval(tx, conversation.id, approval, { allow, author, at: Date.now() }),
            ),
          )
          if (answered === "unknown") return yield* Effect.fail(new NoSuchApproval({ approval }))
          return { accepted: answered === "accepted" }
        }),
      "status/watch": () => Stream.unwrap(Effect.as(lifetime.hold, status.watch(CONNECTION_QUEUE))),
      "extensions/list": () => extensions.list,
      "extensions/reload": () => extensions.reload,
      // Stops once the runs in flight settle, as the shipping server does; a run is never cut off by a stop.
      "server/stop": () => Effect.andThen(Effect.ignore(quiet), afterReply(lifetime.stop)),
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
