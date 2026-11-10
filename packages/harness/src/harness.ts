// The Harness: one Session with its task scheduler, conversations, and the services harness tasks run with (spec 2.2,
// 5 and 7.1). Every change is one commit on the Session line.
import type { ExecutionEnv } from "@nisse/env"
import {
  type AnyDocToken,
  type CommitError,
  commitIn,
  type ConversationId,
  type ConversationOwnership,
  type ConversationRecord,
  type Cursor,
  type DocAddressArgs,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  InvocationEnded,
  makeSession,
  openTaskScheduler,
  type Page,
  type PhaseInfo,
  type ReadError,
  type ReadFailure,
  ReadOnlySession,
  type ReportTask,
  ROOT_CONVERSATION_ID,
  type RewindableAddressArgs,
  type Session,
  type SettledTask,
  type Storage,
  type StorageError,
  type TaskId,
  type TaskInspection,
  type TaskRecord,
  type TaskReport,
  type TaskScheduler,
  type Tx,
  type Wake,
} from "@nisse/kernel"
import type { Models } from "@nisse/models"
import { Cause, Clock, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { AgentDoc, agentHooks, configure, createAgent, resolveAgent, resolveSettings } from "./agent.ts"
import { BUILTIN_TASKS } from "./builtin.ts"
import { readContext } from "./context.ts"
import { ProviderDoc } from "./documents.ts"
import { InboxDoc } from "./inbox.ts"
import { LiveDoc } from "./live.ts"
import { UsageDoc } from "./usage.ts"
import { ResetEntry } from "./entries.ts"
import { type ConversationHandle, type ReportFrom, type TaskApi, TaskServices } from "./services.ts"
import type {
  Agent,
  AgentChange,
  ContextView,
  DocumentReader,
  HarnessSettings,
  RegistryReader,
  RegistrySnapshot,
  Settings,
  ToolRegistration,
} from "./types.ts"

/** What a viewer's calls that would run tasks fail with. */
const RUNNING_REFUSED = new ReadOnlySession({ message: "Read-only Harness: running tasks refused" })

/** A failure the Harness forwards to its host instead of failing what it was doing. */
export type ReportInfo =
  /** A scheduler report; one about a task names the extension that registers its definition, if any. */
  | (TaskReport & { readonly extension?: string })
  /** Storage failed the Session, which the Harness then closes as failed. */
  | { readonly kind: "storage_failed" }
  /** Extension code failed: a wrapper, a section, a hook handler. */
  | {
      readonly kind: "extension_error"
      readonly extension?: string
      readonly task?: ReportTask
      readonly conversationId?: ConversationId
    }
  /** A host callback failed: the clock, or one a task called. */
  | { readonly kind: "host_error"; readonly callback: string; readonly task?: ReportTask }

export type Report = ReportInfo & { readonly error: unknown }

/** What the environment builder gets. */
export type EnvTarget = {
  readonly conversationId: ConversationId
  /** The conversation's agent `cwd`. */
  readonly cwd?: string
  readonly read: DocumentReader
}

/** Runs inside the creating commit, after the creation hook and the `agent` change. */
export type ConversationInit = (tx: Tx, conversationId: ConversationId) => Effect.Effect<void, unknown>

export type ConversationCreateOptions = {
  readonly ownership: ConversationOwnership
  /** Applied in the creating commit after the creation hook's copy, before `init`. */
  readonly agent?: AgentChange
  readonly init?: ConversationInit
}

export type HarnessOptions<T extends ToolRegistration = ToolRegistration> = {
  readonly registry: RegistryReader<T>
  /** The host's models, read at each use. */
  readonly models: Models | (() => Models)
  /** The host's policy, read at each use. */
  readonly settings?: HarnessSettings | (() => HarnessSettings | undefined)
  /** Builds a conversation's execution environment; without it tasks get none. */
  readonly env?: (target: EnvTarget) => Effect.Effect<ExecutionEnv | undefined, unknown>
  /** The clock tasks and documents are stamped with. Default: Effect's `Clock`. */
  readonly now?: () => number
  /** A viewer of a Session another process drives: nothing is written or run (spec 2.2). */
  readonly readOnly?: boolean
  readonly onReport?: (report: Report) => void
  /** Runs in every commit that creates or forks a conversation, after the built-in creation hook. */
  readonly conversationCreated?: (tx: Tx, record: ConversationRecord) => Effect.Effect<void, unknown>
}

/** A conversation of a Harness; stateless, so compare handles by `id`. */
export interface Conversation {
  readonly id: ConversationId
  /** The conversation's agent resolved against the current registry and settings. */
  readonly agent: Effect.Effect<Agent, ReadFailure>
  /** Applies one change to the stored agent in its own commit. */
  configure(change: AgentChange): Effect.Effect<void, CommitError>
  /** Starts a new context, history kept; `handoff` is the first message of the new context (spec 7.1). */
  reset(handoff?: string): Effect.Effect<void, CommitError>
  /** A commit bound to the conversation: `tx.createTask()` defaults to it. */
  commit<A, E>(body: (tx: Tx) => Effect.Effect<A, E>): Effect.Effect<A, E | CommitError>
  /** The committed context, or the context cut off at the visible entry `at` (spec 2.1). */
  context(options?: { readonly at?: EntryId }): Effect.Effect<ContextView, ReadFailure>
  /** Fork-aware raw history, every entry included. */
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor?: Cursor,
  ): Effect.Effect<Page<EntryRecord>, ReadFailure>
  /** A new conversation whose history is this one's through the visible entry `at` (spec 3.7). */
  fork(at: EntryId, options: ConversationCreateOptions): Effect.Effect<Conversation, CommitError>
  /** Aborts the conversation's live work and succeeds once it is idle (spec 5.4). */
  abort(options?: { readonly background?: boolean }): Effect.Effect<void, ReadFailure | CommitError>
  readonly waitForIdle: Effect.Effect<void, ReadFailure | ReadOnlySession>
}

export interface Harness<T extends ToolRegistration = ToolRegistration> {
  readonly session: Session
  readonly registry: RegistryReader<T>
  /** Enables scheduling; calls that ask for progress enable it too. A viewer refuses (spec 2.2). */
  readonly resume: Effect.Effect<void, ReadOnlySession>
  /** When the Session next needs a running process (spec 5.6). */
  wake(): Wake
  /** The root conversation, created with `agent` and `init` in one commit when absent. */
  root(options?: Omit<ConversationCreateOptions, "ownership">): Effect.Effect<Conversation, CommitError>
  conversation(id: ConversationId): Effect.Effect<Conversation | undefined, ReadFailure>
  createConversation(options: ConversationCreateOptions): Effect.Effect<Conversation, CommitError>
  /** A conversation's agent against `snapshot`, or the current registry. */
  resolveAgent(id: ConversationId, snapshot?: RegistrySnapshot<T>): Effect.Effect<Agent<T>, ReadFailure>
  settings(): Settings
  getTask<R>(id: TaskId<R>): Effect.Effect<TaskRecord | undefined, ReadFailure>
  abortTask(id: TaskId): Effect.Effect<"marked" | "terminal", ReadFailure | CommitError>
  waitForTask<R>(id: TaskId<R>): Effect.Effect<SettledTask<R>, ReadFailure | ReadOnlySession>
  readonly waitForIdle: Effect.Effect<void, ReadFailure | ReadOnlySession>
  readonly inspect: Effect.Effect<
    { readonly scheduling: "paused" | "running" | "closing"; readonly tasks: readonly TaskInspection[] },
    ReadFailure
  >
  /** Joins every task invocation, then closes the Session. */
  readonly close: Effect.Effect<void, StorageError>
  /** For tests that bound memory: what the scheduler's indexes hold. */
  readonly indexSizes: TaskScheduler["indexSizes"]
}

/**
 * Opens a Harness over storage, which it then owns: the Session, then the scheduler, which recovers the tasks a crash
 * left running. Scheduling waits for `resume` or a call that asks for progress. The registry may keep changing.
 */
export const openHarness = <T extends ToolRegistration>(
  storage: Storage,
  options: HarnessOptions<T>,
): Effect.Effect<Harness<T>, CommitError | ReadError> =>
  Effect.gen(function* () {
    const snapshot = options.registry.snapshot()
    const missing = BUILTIN_TASKS.filter((task) => snapshot.task(task.definition.name) === undefined)
    if (missing.length > 0) {
      const names = missing.map((task) => task.definition.name).join(", ")
      return yield* Effect.die(new Error(`Registry lacks built-in tasks ${names}; create it with createRegistry()`))
    }
    const host = new HarnessHost(options)
    const now = host.clock
    const session = yield* makeSession(storage, {
      readOnly: options.readOnly === true,
      ...(now === undefined ? {} : { now }),
      documentRetentionMs: () => host.hostSettings()?.documentRetentionMs,
      conversationCreated: (tx, record) => host.conversationCreated(tx, record),
    })
    const scheduler = yield* Effect.onError(
      openTaskScheduler<TaskServices>({
        session,
        registry: options.registry,
        services: (phase) => Layer.succeed(TaskServices, host.taskApi(phase)),
        restartLimit: () => host.settings().restartLimit,
        report: (error, report) => host.report(error, host.taskReport(report)),
        readOnly: options.readOnly === true,
      }),
      () => Effect.ignore(session.close),
    )
    session.subscribeClose(() => {
      const failure = session.failure
      if (failure !== undefined) host.report(failure.error, { kind: "storage_failed" })
    })
    return host.bind(session, scheduler)
  })

/** What a Harness keeps; its parts are bound once the Session and scheduler are open. */
class HarnessHost<T extends ToolRegistration> implements Harness<T> {
  readonly #options: HarnessOptions<T>
  #session: Session | undefined
  #scheduler: TaskScheduler | undefined

  /** The host's clock behind `safeNow`; `undefined` for Effect's `Clock`. */
  readonly clock: (() => number) | undefined

  constructor(options: HarnessOptions<T>) {
    this.#options = options
    const now = options.now
    this.clock =
      now === undefined
        ? undefined
        : safeNow(now, (error) => this.report(error, { kind: "host_error", callback: "now" }))
  }

  bind(session: Session, scheduler: TaskScheduler): this {
    this.#session = session
    this.#scheduler = scheduler
    return this
  }

  get session(): Session {
    return this.#session!
  }

  get registry(): RegistryReader<T> {
    return this.#options.registry
  }

  get #tasks(): TaskScheduler {
    return this.#scheduler!
  }

  hostSettings(): HarnessSettings | undefined {
    const settings = this.#options.settings
    return typeof settings === "function" ? settings() : settings
  }

  settings(): Settings {
    return resolveSettings(this.hostSettings())
  }

  models(): Models {
    const models = this.#options.models
    return typeof models === "function" ? models() : models
  }

  /** Forwards a report to the host; a host callback that throws is dropped, since reporting it would report again. */
  /** A scheduler report with the extension whose definition its task has, by the registry's current snapshot. */
  taskReport(report: TaskReport): ReportInfo {
    if (!("task" in report)) return report
    const kind = report.task.kind
    const extension = this.registry
      .snapshot()
      .installed()
      .find((extension) => extension.tasks?.some((task) => task.definition.name === kind) === true)
    return extension === undefined ? report : { ...report, extension: extension.name }
  }

  report(error: unknown, info: ReportInfo): void {
    try {
      this.#options.onReport?.({ ...info, error })
    } catch {
      // Dropped: see above.
    }
  }

  /**
   * The built-in creation hook (spec 7.1): empty `pi.live`, `pi.inbox` and `pi.usage`, a fresh `pi.provider`, the
   * conversation's `pi.agent`, then the host's hook.
   */
  conversationCreated(tx: Tx, record: ConversationRecord): Effect.Effect<void, unknown> {
    const hook = this.#options.conversationCreated
    return Effect.gen(function* () {
      yield* tx.doc(LiveDoc, record.id)
      yield* tx.doc(InboxDoc, record.id)
      yield* tx.doc(UsageDoc, record.id)
      yield* tx.doc(ProviderDoc, record.id)
      yield* createAgent(tx, record)
      if (hook !== undefined) yield* hook(tx, record)
    })
  }

  get resume(): Effect.Effect<void, ReadOnlySession> {
    return this.#options.readOnly === true ? Effect.fail(RUNNING_REFUSED) : this.#tasks.resume
  }

  wake(): Wake {
    return this.#tasks.wake()
  }

  root(options: Omit<ConversationCreateOptions, "ownership"> = {}): Effect.Effect<Conversation, CommitError> {
    return this.#create({ kind: "root" }, options)
  }

  createConversation(options: ConversationCreateOptions): Effect.Effect<Conversation, CommitError> {
    return this.#create({ kind: "independent", ownership: options.ownership }, options)
  }

  conversation(id: ConversationId): Effect.Effect<Conversation | undefined, ReadFailure> {
    return Effect.map(
      this.session.read((storage) => storage.conversation(id)),
      (record) => (record === undefined ? undefined : this.#handle(record.id)),
    )
  }

  resolveAgent(id: ConversationId, snapshot?: RegistrySnapshot<T>): Effect.Effect<Agent<T>, ReadFailure> {
    return Effect.map(this.session.snapshot(AgentDoc, id), (state) =>
      resolveAgent(state, snapshot ?? this.registry.snapshot(), this.settings(), (error, extension) =>
        this.report(error, { kind: "extension_error", conversationId: id, extension }),
      ),
    )
  }

  getTask<R>(id: TaskId<R>): Effect.Effect<TaskRecord | undefined, ReadFailure> {
    return this.session.read((storage) => storage.task(id))
  }

  abortTask(id: TaskId): Effect.Effect<"marked" | "terminal", ReadFailure | CommitError> {
    return this.#tasks.abortTask(id)
  }

  waitForTask<R>(id: TaskId<R>): Effect.Effect<SettledTask<R>, ReadFailure | ReadOnlySession> {
    return Effect.andThen(this.resume, this.#tasks.waitForTask(id))
  }

  get waitForIdle(): Effect.Effect<void, ReadFailure | ReadOnlySession> {
    return Effect.andThen(this.resume, this.#tasks.waitForIdle())
  }

  get inspect() {
    return this.#tasks.inspect
  }

  get close(): Effect.Effect<void, StorageError> {
    return this.session.close
  }

  get indexSizes() {
    return this.#tasks.indexSizes
  }

  #create(target: CreateTarget, options: Omit<ConversationCreateOptions, "ownership">) {
    return Effect.map(
      this.session.commit((tx) =>
        Effect.gen(function* () {
          if (target.kind === "root" && (yield* tx.conversation(ROOT_CONVERSATION_ID)) !== undefined) {
            return ROOT_CONVERSATION_ID
          }
          const record =
            target.kind === "root"
              ? yield* tx.createRootConversation()
              : target.kind === "fork"
                ? yield* tx.forkConversation(target.parentId, target.at, { ownership: target.ownership })
                : yield* tx.createConversation({ ownership: target.ownership })
          if (options.agent !== undefined) yield* configure(tx, record.id, options.agent)
          if (options.init !== undefined) yield* options.init(tx, record.id)
          return record.id
        }),
      ),
      (id) => this.#handle(id),
    ) as Effect.Effect<Conversation, CommitError>
  }

  #handle(id: ConversationId): Conversation {
    const host = this
    return {
      id,
      get agent() {
        return host.resolveAgent(id)
      },
      configure: (change) => this.session.commit((tx) => configure(tx, id, change)) as Effect.Effect<void, CommitError>,
      reset: (handoff) => this.#reset(id, handoff),
      commit: (body) => commitIn(this.session, { conversationId: id }, body),
      context: (options) => readContext(this.session, id, options?.at),
      entries: (query, limit, cursor) =>
        this.session.read((storage) => storage.scanEntries({ ...query, conversationId: id }, limit, cursor)),
      fork: (at, options) => this.#create({ kind: "fork", parentId: id, at, ownership: options.ownership }, options),
      abort: (options) => Effect.andThen(this.resume, this.#tasks.abortConversation(id, options)),
      get waitForIdle() {
        return Effect.andThen(host.resume, host.#tasks.waitForIdle(id))
      },
    }
  }

  /**
   * A reset is a write admitted in one commit: the `pi.reset` entry, `head: "self"`, carrying the handoff, and its
   * `done` write submission. Admission behind a live run, where the write waits in the inbox, comes with runs.
   */
  #reset(id: ConversationId, handoff: string | undefined): Effect.Effect<void, CommitError> {
    const now = this.clock
    return this.session.commit((tx) =>
      Effect.gen(function* () {
        const live = yield* tx.doc(LiveDoc, id)
        if (live.run !== undefined) {
          return yield* Effect.die(new Error("A reset behind a live run waits in the inbox, which runs bring"))
        }
        const timestamp = now === undefined ? yield* Clock.currentTimeMillis : now()
        const model = handoff === undefined ? {} : { model: [{ role: "user", content: handoff, timestamp }] }
        const entry = yield* tx.appendEntry(id, { kind: ResetEntry.kind, head: "self", ...model })
        yield* tx.createSubmission({ conversationId: id, type: "write", status: "done", entry: entry.id })
      }),
    ) as Effect.Effect<void, CommitError>
  }

  /** The services of one task handler (spec 5.1); every operation fails once the invocation ended. */
  taskApi(phase: PhaseInfo<TaskServices>): TaskApi {
    const runtime = phase.runtime
    const conversationId = phase.record.conversationId
    const snapshot = phase.snapshot as unknown as RegistrySnapshot<T>
    const task: ReportTask = { id: phase.record.id, kind: phase.record.kind, conversationId }
    let resolved: Deferred.Deferred<Agent<T>, ReadFailure> | undefined
    // Resolved once, at first use; a caller that stops waiting leaves the resolution to the others.
    const agent = Effect.suspend(() => {
      if (resolved === undefined) {
        const deferred = Deferred.makeUnsafe<Agent<T>, ReadFailure>()
        resolved = deferred
        Effect.runFork(
          Effect.flatMap(Effect.exit(this.resolveAgent(conversationId, snapshot)), (exit) =>
            Deferred.done(deferred, exit),
          ),
        )
      }
      return Deferred.await(resolved)
    })
    const host = this
    const ended = Effect.fail(new InvocationEnded({ message: `Task ${phase.record.id} invocation has ended` }))
    return {
      agent: runtime.guard(agent),
      settings: () => this.settings(),
      models: () => this.models(),
      env: runtime.guard(this.#env(conversationId)),
      hooks: {
        each: (name, invoke) =>
          runtime.guard(
            Effect.gen(function* () {
              for (const { extension, handlers } of agentHooks(yield* agent, phase.task.definition.name)) {
                const handler = (handlers as Record<string, unknown>)[name]
                if (typeof handler !== "function") continue
                const exit = yield* Effect.exit(Effect.suspend(() => invoke(handler.bind(handlers))))
                if (Exit.isSuccess(exit)) continue
                if (runtime.signal.aborted || Cause.hasInterruptsOnly(exit.cause))
                  return yield* Effect.failCause(exit.cause)
                host.report(Cause.squash(exit.cause), { kind: "extension_error", extension, task })
              }
            }),
          ),
      },
      context: (id, options) => runtime.guard(readContext(this.session, id, options?.at)),
      snapshotAsOf: <K extends AnyDocToken>(token: K, ...address: RewindableAddressArgs<K>) =>
        runtime.guard(this.session.snapshotAsOf(token, ...address)),
      // The watch lives in a scope of its own, closed by the caller's scope or the invocation's end, whichever is first.
      watchDoc: <K extends AnyDocToken>(token: K, ...address: DocAddressArgs<K>) =>
        runtime.guard(
          Effect.gen({ self: this }, function* () {
            const outer = yield* Effect.scope
            const inner = yield* Scope.fork(outer)
            const watch = yield* Scope.provide(inner)(this.session.watchDoc(token, ...address))
            if (runtime.signal.aborted) {
              yield* Scope.close(inner, Exit.void)
              return yield* ended
            }
            yield* Effect.forkIn(Effect.andThen(aborted(runtime.signal), Scope.close(inner, Exit.void)), outer)
            return watch
          }),
        ),
      conversation: (id) =>
        runtime.guard(
          Effect.map(
            this.session.read((storage) => storage.conversation(id)),
            (record): ConversationHandle | undefined =>
              record === undefined
                ? undefined
                : {
                    id: record.id,
                    abort: (options) => runtime.guard(this.#tasks.abortConversation(record.id, options)),
                    waitForIdle: runtime.guard(
                      Effect.raceFirst(
                        this.#tasks.waitForIdle(record.id),
                        Effect.andThen(aborted(runtime.signal), ended),
                      ),
                    ),
                  },
          ),
        ),
      report: (error, from?: ReportFrom) => {
        if (from === undefined) return runtime.report(error)
        // `now` fails once the invocation ended, as every runtime operation does.
        runtime.now()
        this.report(
          error,
          from.kind === "extension"
            ? { kind: "extension_error", task, ...(from.extension === undefined ? {} : { extension: from.extension }) }
            : { kind: "host_error", callback: from.callback, task },
        )
      },
    }
  }

  /** The environment of a conversation from its current `cwd`; `undefined` without a builder. */
  #env(conversationId: ConversationId): Effect.Effect<ExecutionEnv | undefined, unknown> {
    const build = this.#options.env
    if (build === undefined) return Effect.succeed(undefined)
    const session = this.session
    return Effect.flatMap(session.snapshot(AgentDoc, conversationId), (state) =>
      build({
        conversationId,
        ...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
        read: { snapshot: (token, ...address) => session.snapshot(token, ...address) },
      }),
    )
  }
}

type CreateTarget =
  | { readonly kind: "root" }
  | { readonly kind: "independent"; readonly ownership: ConversationOwnership }
  | {
      readonly kind: "fork"
      readonly parentId: ConversationId
      readonly at: EntryId
      readonly ownership: ConversationOwnership
    }

/** Succeeds once `signal` aborts; interrupting it removes its listener. */
const aborted = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)
    const listener = () => resume(Effect.void)
    signal.addEventListener("abort", listener, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", listener))
  })

/**
 * The host clock, falling back to `Date.now` when it throws: a broken clock must not stop commits. The first throw is
 * reported; the clock is read in every task change, so later ones are not.
 */
export function safeNow(now: () => number, report: (error: unknown) => void): () => number {
  let reported = false
  return () => {
    try {
      return now()
    } catch (error) {
      // Set first: a report handler that reads the clock again must not report again.
      if (!reported) {
        reported = true
        report(error)
      }
      return Date.now()
    }
  }
}
