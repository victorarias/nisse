// The server a home runs: one Harness over `kernel.sqlite`, served over the home's socket with the protocol
// (`@nisse/protocol`). Conversations run on the home's providers (`./providers.ts`).
import { claudeRunTasks, makeClaudeProcesses } from "@nisse/claude"
import { CodemodeSandbox } from "@nisse/codemode/sandbox"
import { LocalExecutionEnv } from "@nisse/env/local"
import {
  answerApproval,
  AgentDoc,
  ApprovalsDoc,
  approveAutomatically,
  CompactionRefused,
  configure,
  ConversationBusy as BusyConversation,
  type Conversation,
  type ConversationView,
  type ConversationWindow,
  createRegistry,
  type EndedRun,
  type WithdrawnInput,
  openHarness,
  UsageDoc,
  type Harness,
  LiveDoc,
} from "@nisse/harness"
import {
  type ConversationId,
  type Cursor,
  type DocumentObservation,
  type DocumentObserver,
  type EntryId,
  idFromNumber,
  openSqliteStorage,
  type SubmissionId,
  type Tx,
} from "@nisse/kernel"
import { fromProviders, type Models } from "@nisse/models"
import type { ImageProcessor } from "@nisse/tools"
import { createNodePhotonImages } from "@nisse/tools/images/node"
import {
  ReadOnlyServer,
  CannotCompact,
  CONFIGURED_KIND,
  ConversationBusy,
  NothingToContinue,
  FellBehind,
  NoSuchSubmission,
  type TaskGraphItem,
  InvalidConversationId,
  InvalidWindow,
  PROTOCOL_VERSION,
  NisseRpcs,
  MODEL_KIND,
  NoSuchApproval,
  NoSuchConversation,
  NoSuchEntry,
  TakesNoInput,
  UnknownProvider,
  type EntryRecord as WireEntry,
  USER_KIND,
  WITHDRAWN_KIND,
  type View,
  type ViewItem,
  type Window,
} from "@nisse/protocol"
import { Cause, Console, Context, type Duration, Effect, Exit, Layer, Queue, Scope, Semaphore, Stream } from "effect"
import * as RpcServer from "effect/rpc/RpcServer"
import type { ModelAsk } from "./config.ts"
import type { ProviderOptions } from "./providers.ts"
import type { Home } from "./home.ts"
import { Lifetime } from "./lifetime.ts"
import { homeSocketServer } from "./socket.ts"
import { Setup } from "./setup.ts"
import { VERSION } from "./version.ts"
import { chosenNumber, ConversationIdsDoc, kernelNumber, refusedChoice } from "./ids.ts"
import { agentModel, Providers, LastModelDoc, selectionOf } from "./providers.ts"
import { countStops, restartLimitMessage } from "./restarts.ts"
import { endRun, LastRunEndDoc, switchModel, writeRunEnd } from "./run-end.ts"
import { committedSignIns } from "./sign-ins.ts"
import { codeModeTools, nisseTools } from "./tools/index.ts"
import { attachedImages } from "./images.ts"
import { agentTools, type AgentTypes, interruptTree } from "./agents.ts"
import { type Extensions, openExtensions, StatusLinesDoc } from "./extensions/index.ts"
import { followTreeStatus, type TreeStatuses } from "./status.ts"
import { skillsOf, userInput, workspaceInstructions } from "./workspace.ts"
import { lineageOf, listConversations, titleOf, wireId } from "./conversations.ts"
import { readableNdJsonRpc } from "./wire-errors.ts"

/**
 * The changes one watch may hold unread before it ends with `FellBehind` (D10); the connection stays open. Receipt: 1,500
 * prompts submitted 100 at a time to one conversation, a client that reads peaked at 34 queued changes; 300 at a time,
 * at 64. Past this the client is told it fell behind at its next read, and watches again from the position it holds.
 */
export const CONNECTION_QUEUE = 4096

/** The server's watch limit: CONNECTION_QUEUE unless a test needs a client to fall behind sooner. */
const ConnectionQueue = Context.Reference<number>("nisse/ConnectionQueue", { defaultValue: () => CONNECTION_QUEUE })

/**
 * The home's Harness, and the runs the server stopped too often in a row (D12): counted as it opens, before anything
 * runs, and ended `restart_limit` once scheduling resumes.
 */
export type KernelHarnessService = {
  readonly home: Home
  readonly harness: Harness
  readonly stoppedTooOften: Map<ConversationId, number>
  readonly extensions: Extensions
  readonly status: TreeStatuses
  /** Prepares the images `read` returns and people attach. */
  readonly images: ImageProcessor
  readonly models: Models
  /** Opened read-only: it shows the home and changes nothing. */
  readonly readOnly: boolean
}

export class KernelHarness extends Context.Service<KernelHarness, KernelHarnessService>()("nisse/KernelHarness") {
  static readonly layer = (
    home: Home,
    readOnly: boolean,
    claudeIdle: Duration.Input | undefined,
    claudeStop: Duration.Input | undefined,
  ) =>
    Layer.effect(
      KernelHarness,
      Effect.gen(function* () {
        const { instances, agents, claude, agentTypes } = yield* Providers
        const lifetime = yield* Lifetime
        // Opened before the harness, so a server stop closes the live Claude Code processes after the runs (D3).
        const processes = yield* makeClaudeProcesses({
          ...(claudeIdle === undefined ? {} : { idle: claudeIdle }),
          ...(claudeStop === undefined ? {} : { stop: claudeStop }),
          hold: lifetime.hold,
        })
        const stoppedTooOften = new Map<ConversationId, number>()
        const registry = createRegistry()
        // Closed after the harness, which stops the scripts first. Closing asks a stuck worker to stop and does not wait
        // for it (F19).
        const sandbox = yield* Effect.acquireRelease(
          Effect.sync(() => new CodemodeSandbox()),
          (sandbox) => Effect.promise(() => sandbox.close()),
        )
        // One processor prepares the images `read` returns and the images people attach, in a worker that exits when idle.
        const images = createNodePhotonImages()
        const models = fromProviders(
          [...instances.values()].flatMap((instance) => (instance.provider ? [instance.provider] : [])),
        )
        const typesOf: AgentTypes = (agent) => agentTypes(agent.model?.provider, agent.cwd ?? home.dir)
        const base = [nisseTools(images), agentTools(agents, typesOf), codeModeTools(sandbox)]
        for (const extension of base) registry.install(extension)
        registry.install(workspaceInstructions(home, instances, typesOf))
        // Claude Code has its own tools and subagents, so nisse's built-in ones are not offered to it. The tools the
        // extensions remove are known once they load, below; Claude Code is told not to use its own of them.
        let removedTools: () => ReadonlyArray<string> = () => []
        const claudeRuns = claudeRunTasks({
          settings: (provider) => claude.get(provider),
          builtinExtensions: new Set(base.map((extension) => extension.name)),
          withheldTools: () => removedTools(),
          title: (conversation) => titleOf(harness, conversation),
          processes,
        })
        registry.install({ name: "claude", tasks: [claudeRuns.run, claudeRuns.subagent] })
        // A run ended for the limit was aborted; its run_end says why.
        const runEnded = (tx: Tx, run: EndedRun) => {
          // The first run to end after the abort is the one the limit stopped, however it ended.
          const stops = stoppedTooOften.get(run.conversationId)
          stoppedTooOften.delete(run.conversationId)
          if (stops === undefined || run.answered || run.end.status === "done") return writeRunEnd(tx, run)
          return endRun(tx, run.conversationId, { outcome: "restart_limit", message: restartLimitMessage(stops) })
        }
        // A person's input withdrawn while it waited says so in the transcript, under the requestId it was submitted
        // with, so a client that lost its watch learns the input's fate from entries alone.
        const inputWithdrawn = (tx: Tx, { conversationId, entry }: WithdrawnInput) =>
          entry?.kind === USER_KIND
            ? Effect.asVoid(
                tx.appendEntry(conversationId, {
                  kind: WITHDRAWN_KIND,
                  data: { requestId: (entry.data as { requestId: string }).requestId },
                }),
              )
            : Effect.void
        const harness = yield* Effect.acquireRelease(
          Effect.flatMap(openSqliteStorage(home.database), (storage) =>
            openHarness(storage, {
              registry,
              models,
              env: ({ cwd }) => Effect.succeed(new LocalExecutionEnv({ cwd: cwd ?? home.dir })),
              runEnded,
              inputWithdrawn,
              viewDocs: [StatusLinesDoc],
              runTasks: claudeRuns.runTasks,
              // A prompt queued behind a run that fails runs next, as one queued behind an answer does.
              settings: { afterFailedRun: "continue" },
              readOnly,
            }),
          ),
          (harness) => Effect.ignore(harness.close),
        )
        // Read-only, nothing runs, so no run counts a stop.
        if (!readOnly) for (const [id, stops] of yield* countStops(harness)) stoppedTooOften.set(id, stops)
        const status = yield* followTreeStatus(harness)
        // Loaded before anything runs, so the extensions guard the calls a restart resumes.
        const extensions = yield* openExtensions(home, registry, base, () => harness)
        removedTools = extensions.removed
        return { home, harness, stoppedTooOften, extensions, status, images, models, readOnly }
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

const Handlers = NisseRpcs.toLayer(
  Effect.gen(function* () {
    const { home, harness, stoppedTooOften, extensions, status, images, models, readOnly } = yield* KernelHarness
    const connectionQueue = yield* ConnectionQueue
    const providers = yield* Providers
    const setup = yield* Setup.make(providers.instances, yield* committedSignIns(harness, readOnly))
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
    /** Refuses a call that would change the home when the server opened it read-only. */
    const writable = readOnly
      ? Effect.fail(
          new ReadOnlyServer({
            message: `the server opened ${home.dir} read-only, so it changes nothing; stop it and run nisse serve to make changes`,
          }),
        )
      : Effect.void
    const writing =
      <P, A, E, R>(handler: (payload: P) => Effect.Effect<A, E, R>) =>
      (payload: P) =>
        Effect.andThen(writable, handler(payload))
    if (!readOnly) yield* heldUntilIdle(Effect.orDie(harness.resume))
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

    const agentOf = (conversation: Conversation) => Effect.orDie(conversation.agent)

    /** A conversation that takes input: not one its parent's provider runs inside its parent's run. */
    const takingInput = (id: string) =>
      Effect.gen(function* () {
        const conversation = yield* find(id)
        const lineage = yield* lineageOf(harness, conversation.id)
        if (lineage !== undefined && lineage.task === undefined) return yield* new TakesNoInput({ conversation: id })
        return conversation
      })

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
        yield* writable
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

    /**
     * A watch's items: `first` of the value `attach` observes, then each commit's operations on it. A full queue ends
     * the watch instead of holding the Session line; what it held is dropped so the client hears FellBehind at its next
     * read.
     */
    const follow = <V, I, E>(
      attach: (observer: DocumentObserver<V>) => Effect.Effect<DocumentObservation<V>, E>,
      first: (value: V) => I,
    ) =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<
          I | { readonly _tag: "change"; readonly ops: ReadonlyArray<unknown> },
          FellBehind | Cause.Done
        >(connectionQueue)
        let behind = false
        const observation = yield* Effect.acquireRelease(
          attach({
            // On the Session line: only capture.
            advance: (change) => {
              if (behind || Queue.offerUnsafe(queue, { _tag: "change" as const, ops: change.ops })) return
              behind = true
              Effect.runSync(Queue.clear(queue))
              Queue.failCauseUnsafe(queue, Cause.fail(new FellBehind({ limit: connectionQueue })))
            },
            end: (end) => {
              if (end.kind === "ended") Queue.endUnsafe(queue)
              else Queue.failCauseUnsafe(queue, Cause.die(end.error))
            },
          }),
          (attached) => Effect.sync(() => attached.detach()),
        )
        return Stream.concat(Stream.make(first(observation.value)), Stream.fromQueue(queue))
      })

    /** Refuses an id a client chose that cannot name a new conversation, or names one already. */
    const freshChoice = (id: string) =>
      Effect.gen(function* () {
        const refused = refusedChoice(id)
        if (refused !== undefined) return yield* new InvalidConversationId({ message: refused })
        // refusedChoice refuses every all-digit id, so only a chosen id can be taken.
        if (chosenNumber(yield* Effect.orDie(harness.session.snapshot(ConversationIdsDoc)), id) !== undefined)
          return yield* new InvalidConversationId({ message: `${id} already names a conversation` })
      })

    const fork = (id: string, at: number, chosen: string | undefined) =>
      Effect.gen(function* () {
        const conversation = yield* takingInput(id)
        const entry = idFromNumber<EntryId>(at)
        const visible = yield* Effect.orDie(harness.session.read((storage) => storage.entry(conversation.id, entry)))
        if (visible === undefined) return yield* new NoSuchEntry({ entry: at })
        const auto = (yield* Effect.orDie(harness.session.snapshot(ApprovalsDoc, conversation.id)))?.auto === true
        // The fork goes on with the settings as they are now, not as they were at `at`.
        const settings = yield* Effect.orDie(harness.session.snapshot(AgentDoc, conversation.id))
        const forked = yield* Effect.orDie(
          conversation.fork(entry, {
            ownership: { kind: "ownerless" },
            init: (tx, created) =>
              Effect.gen(function* () {
                if (settings !== undefined) {
                  const agent = yield* tx.doc(AgentDoc, created)
                  for (const key of Object.keys(agent)) delete agent[key as keyof typeof agent]
                  Object.assign(agent, structuredClone(settings))
                }
                if (auto) yield* approveAutomatically(tx, created)
                if (chosen !== undefined) (yield* tx.doc(ConversationIdsDoc)).ids[chosen] = Number(created)
              }),
          }),
        )
        return { conversation: chosen ?? String(forked.id) }
      })

    const watchTasks = Stream.unwrap(
      Effect.gen(function* () {
        yield* lifetime.hold
        return yield* follow(
          (observer) => Effect.orDie(harness.observeTaskGraph(observer)),
          (graph): TaskGraphItem => ({ _tag: "graph", graph: graph as unknown as { tasks: Record<string, unknown> } }),
        )
      }),
    )

    const watch = (id: string, window: Window | undefined) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* lifetime.hold
          const conversation = yield* find(id)
          return yield* follow(
            (observer) =>
              harness.observeConversation(conversation.id, observer, toWindow(window)).pipe(
                Effect.orDie,
                // The harness checks the window's bounds and names the one that is wrong.
                Effect.catchDefect((defect) =>
                  defect instanceof RangeError
                    ? Effect.fail(new InvalidWindow({ message: defect.message }))
                    : Effect.die(defect),
                ),
              ),
            (view: ConversationView): ViewItem => ({ _tag: "view", view: toView(view) }),
          )
        }),
      )

    return NisseRpcs.of({
      initialize: () => Effect.succeed({ version: VERSION, protocol: PROTOCOL_VERSION, readOnly }),
      "conversation/start": ({ cwd, id, approvals, instructions, ...ask }) =>
        Effect.gen(function* () {
          if (id === undefined) return yield* startConversation(cwd, undefined, approvals, instructions, ask)
          // A conversation's number opens it, as its chosen id does, and answers with the id every other call names it
          // by; a number that names none is refused below.
          const numbered = kernelNumber(id)
          if (numbered !== undefined && (yield* Effect.orDie(harness.conversation(numbered))) !== undefined) {
            return {
              conversation: yield* wireId(harness, numbered),
              model: selectionOf(yield* Effect.orDie(harness.resolveAgent(numbered))),
            }
          }
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
      "conversation/submit": writing(({ conversation: id, requestId, author, text, images: attaching = [], steer }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          const agent = yield* agentOf(conversation)
          const { content, attached } = userInput(
            text,
            skillsOf(home, providers.instances, agent),
            yield* attachedImages(attaching, images, models, agent),
          )
          const entry = {
            kind: USER_KIND,
            data: {
              author,
              requestId,
              ...(attached.length === 0 ? {} : { skills: attached }),
              ...(attaching.length === 0 ? {} : { images: attaching.map((image) => image.name) }),
            },
          }
          const submission = yield* heldUntilIdle(
            Effect.orDie(
              conversation.submit({
                type: "input",
                content,
                requestId,
                entry,
                ...(steer ? { whenBusy: "steer" as const } : {}),
              }),
            ),
          )
          return { submission: submission.id }
        }),
      ),
      "conversation/list": () => listConversations(harness),
      "conversation/select_model": writing(({ conversation: id, author, selection }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          const instance = providers.instances.get(selection.provider)
          if (instance === undefined) return yield* new UnknownProvider({ provider: selection.provider })
          const model = yield* agentModel(selection, instance)
          const subagent = (yield* lineageOf(harness, conversation.id)) !== undefined
          yield* Effect.orDie(
            conversation.commit((tx) =>
              Effect.gen(function* () {
                yield* switchModel(tx, conversation.id, {
                  model: model.model,
                  thinkingLevel: model.thinkingLevel ?? null,
                })
                yield* tx.appendEntry(conversation.id, { kind: MODEL_KIND, data: { author, selection } })
                // The model chosen last is one a person chose for a conversation they started.
                if (!subagent) (yield* tx.doc(LastModelDoc)).selection = { ...selection }
              }),
            ),
          )
        }),
      ),
      "skills/list": ({ conversation: id }) =>
        Effect.map(Effect.flatMap(find(id), agentOf), (agent) => [...skillsOf(home, providers.instances, agent)]),
      "conversation/entries": ({ conversation: id, from, to, order, limit, cursor }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const page = yield* Effect.orDie(
            conversation.entries(
              {
                ...(from === undefined ? {} : { minEntryId: idFromNumber<EntryId>(from) }),
                ...(to === undefined ? {} : { maxEntryId: idFromNumber<EntryId>(to) }),
                ...(order === undefined ? {} : { order }),
              },
              limit,
              cursor as Cursor | undefined,
            ),
          )
          return {
            entries: page.items as unknown as ReadonlyArray<WireEntry>,
            ...(page.next === undefined ? {} : { next: page.next }),
          }
        }),
      "conversation/context": ({ conversation: id, at }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const entry = at === undefined ? undefined : idFromNumber<EntryId>(at)
          if (entry !== undefined) {
            const visible = yield* Effect.orDie(
              harness.session.read((storage) => storage.entry(conversation.id, entry)),
            )
            if (visible === undefined) return yield* new NoSuchEntry({ entry: at! })
          }
          const context = yield* Effect.orDie(conversation.context(entry === undefined ? {} : { at: entry }))
          return { messages: context.messages, entries: context.entries.map((record) => Number(record.id)) }
        }),
      "conversation/watch": ({ conversation, window }) => watch(conversation, window),
      "conversation/fork": writing(({ conversation, at, id }) =>
        id === undefined
          ? fork(conversation, at, undefined)
          : choosing.withPermits(1)(Effect.andThen(freshChoice(id), fork(conversation, at, id))),
      ),
      "conversation/reset": writing(({ conversation: id, author, handoff }) =>
        Effect.flatMap(takingInput(id), (conversation) =>
          heldUntilIdle(Effect.orDie(conversation.reset(handoff, { author }))),
        ),
      ),
      "conversation/compact": writing(({ conversation: id, instructions }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          const task = yield* heldUntilIdle(
            conversation.compact(instructions).pipe(
              Effect.catchIf(
                (error) => error instanceof CompactionRefused,
                (error) => Effect.fail(new CannotCompact({ message: (error as CompactionRefused).message })),
              ),
              Effect.catchIf(
                (error) => !(error instanceof CannotCompact),
                (error) => Effect.die(error),
              ),
            ),
          )
          const outcome = (yield* Effect.orDie(harness.waitForTask(task))).state.outcome
          if (outcome.status === "completed") {
            // The summary is placed as a write; a compaction that found nothing to summarize places none.
            const { entryId, submissionId } = outcome.result
            return { outcome: entryId === undefined && submissionId === undefined ? "nothing_to_compact" : "compacted" }
          }
          if (outcome.status === "aborted") return { outcome: "stopped" as const }
          return { outcome: "failed" as const, message: outcome.error?.message ?? outcome.reason ?? outcome.status }
        }),
      ),
      "conversation/continue": writing(({ conversation: id }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          // A working run is the reason to refuse first: how the run before it ended says nothing about this one.
          if ((yield* Effect.orDie(harness.session.snapshot(LiveDoc, conversation.id)))?.run !== undefined)
            return yield* new ConversationBusy({ conversation: id })
          const last = (yield* Effect.orDie(harness.session.snapshot(LastRunEndDoc, conversation.id)))?.end?.data
          if (last === undefined)
            return yield* new NothingToContinue({ message: "no run has ended here yet; send a message to start one" })
          if (last.outcome === "answered")
            return yield* new NothingToContinue({ message: "the last run answered; send a message to go on" })
          const submission = yield* heldUntilIdle(
            conversation.submit({ type: "continue" }).pipe(
              Effect.catchIf(
                (error) => error instanceof BusyConversation,
                () => Effect.fail(new ConversationBusy({ conversation: id })),
              ),
              Effect.catchIf(
                (error) => !(error instanceof ConversationBusy),
                (error) => Effect.die(error),
              ),
            ),
          )
          return { submission: submission.id }
        }),
      ),
      "submission/withdraw": writing(({ conversation: id, submission }) =>
        Effect.gen(function* () {
          const conversation = yield* find(id)
          const result = yield* Effect.orDie(
            harness.abortSubmission(idFromNumber<SubmissionId>(submission), conversation.id),
          )
          if (result === "not_found") return yield* new NoSuchSubmission({ submission })
          return { result: result === "aborted" ? ("withdrawn" as const) : result }
        }),
      ),
      "conversation/configure": writing(({ conversation: id, author, instructions, maxTurns }) =>
        Effect.gen(function* () {
          const conversation = yield* takingInput(id)
          const change = {
            ...(instructions === undefined ? {} : { instructions }),
            ...(maxTurns === undefined ? {} : { maxTurns }),
          }
          yield* Effect.orDie(
            conversation.commit((tx) =>
              Effect.gen(function* () {
                yield* configure(tx, conversation.id, change)
                yield* tx.appendEntry(conversation.id, { kind: CONFIGURED_KIND, data: { author, ...change } })
              }),
            ),
          )
        }),
      ),
      "usage/get": ({ conversation: id }) =>
        id === undefined
          ? Effect.orDie(harness.usage)
          : Effect.gen(function* () {
              const conversation = yield* find(id)
              const usage = yield* Effect.orDie(harness.session.snapshot(UsageDoc, conversation.id))
              return usage ?? { models: {}, tools: {} }
            }),
      "tasks/watch": () => watchTasks,
      "conversation/interrupt": writing(({ conversation: id }) =>
        Effect.flatMap(find(id), (conversation) => Effect.orDie(interruptTree(harness, conversation.id))),
      ),
      "approval/resolve": writing(({ conversation: id, approval, author, allow }) =>
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
      ),
      "status/watch": () => Stream.unwrap(Effect.as(lifetime.hold, status.watch(connectionQueue))),
      "extensions/list": () => extensions.list,
      "extensions/reload": () => extensions.reload,
      // Stops once the runs in flight settle; a run is never cut off by a stop.
      "server/stop": () => Effect.andThen(Effect.ignore(quiet), afterReply(lifetime.stop)),
      "providers/list": ({ refresh }) => setup.providers(refresh ?? false),
      "models/list": ({ refresh }) => setup.models(refresh ?? false),
      "auth/start": writing(({ provider, method }) => setup.start(provider, method)),
      "auth/respond": ({ provider, flow, response }) =>
        Effect.map(setup.respond(provider, flow, response), (accepted) => ({ accepted })),
      "auth/cancel": ({ provider, flow }) => Effect.map(setup.cancel(provider, flow), (accepted) => ({ accepted })),
      "auth/logout": writing(({ provider }) => setup.logout(provider)),
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

export interface ServerOptions {
  /** How long the server outlives its last watch, run and live Claude Code process. */
  readonly idleGrace: Duration.Input
  /** How long a Claude Code process stays live for its conversation's next run; default `IDLE_RELEASE`. */
  readonly claudeIdle?: Duration.Input
  /** How long a stopped run waits for Claude Code to end its turn before closing its process; default `STOP_TIMEOUT`. */
  readonly claudeStop?: Duration.Input
  /** Show the home and change nothing: no run resumes, and calls that would change it are refused. */
  readonly readOnly?: boolean
  readonly providers: ProviderOptions
  readonly connectionQueue?: number
}

export const serverLayer = (home: Home, options: ServerOptions) =>
  RpcServer.layer(NisseRpcs).pipe(
    Layer.provide(Handlers),
    Layer.provide(Layer.succeed(ConnectionQueue, options.connectionQueue ?? CONNECTION_QUEUE)),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(readableNdJsonRpc),
    Layer.provide(homeSocketServer(home.socket)),
    Layer.provideMerge(KernelHarness.layer(home, options.readOnly === true, options.claudeIdle, options.claudeStop)),
    Layer.provideMerge(
      Providers.layer(
        options.readOnly === true
          ? { ...options.providers, openai: (id) => ({ ...options.providers.openai(id), readOnly: true }) }
          : options.providers,
      ),
    ),
    Layer.provideMerge(Lifetime.layer(options.idleGrace)),
  )

/** Serves the home until its lifetime ends: stopped, or idle past the grace. */
export const serve = (home: Home, options: ServerOptions) =>
  Effect.gen(function* () {
    const lifetime = yield* Lifetime
    yield* Console.error(`nisse ${VERSION} serving ${home.dir}`)
    yield* lifetime.ended
  }).pipe(Effect.provide(serverLayer(home, options)), Effect.scoped)
