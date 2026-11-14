// The Harness: one Session with its task scheduler, conversations, and the services harness tasks run with (spec 2.2,
// 5 and 7.1). Every change is one commit on the Session line.
import type { ExecutionEnv } from "@sigma/env"
import {
  type AnyDocToken,
  type CommitError,
  commitIn,
  type ConversationId,
  type ConversationOwnership,
  type ConversationRecord,
  type Cursor,
  type JsonObject,
  type JsonValue,
  type DocAddressArgs,
  type DocumentObservation,
  type DocumentObserver,
  type DocumentWatch,
  makeWatch,
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
  SessionFailed,
  type StorageReads,
  type SubmissionId,
  type SubmissionRecord,
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
  currentSpan,
  DurableMetrics,
  spanTime,
  TracePropagation,
  updateMetric,
} from "@sigma/kernel"
import {
  type ClientIdentity,
  mergeClientIdentity,
  type Models,
  PI_ATTRIBUTION,
  withClientIdentity,
} from "@sigma/models"
import { Cause, Clock, Context, Data, Deferred, Effect, Exit, Layer, Scope, type Tracer } from "effect"
import { AgentDoc, agentHooks, configure, createAgent, resolveAgent, resolveSettings } from "./agent.ts"
import { BUILTIN_TASKS } from "./builtin.ts"
import { createCompaction } from "./compaction.ts"
import { ContextReads } from "./context.ts"
import { ProviderDoc } from "./documents.ts"
import { InboxDoc, type InputWithdrawnHook, withdrawQueuedInputs } from "./inbox.ts"
import {
  GENERATION_RUNS,
  limitsRestarts,
  LiveDoc,
  type RunEndedHook,
  type RunTasks,
  settleSchedulerOutcome,
} from "./live.ts"
import {
  type AbortResult,
  type AdmissionError,
  type Submission,
  Submissions,
  type SubmitTelemetry,
} from "./submissions.ts"
import { addUsageState, UsageDoc, type UsageState } from "./usage.ts"
import { ResetEntry } from "./entries.ts"
import { type TaskGraph, TaskGraphView } from "./task-graph.ts"
import { type ConversationView, ConversationViews, type ConversationWindow } from "./view.ts"
import { type ConversationHandle, type ReportFrom, type TaskApi, TaskServices } from "./services.ts"
import type {
  Agent,
  AgentChange,
  CompactionResult,
  ContextView,
  DocumentReader,
  HarnessSettings,
  HookApi,
  RegistryReader,
  RegistrySnapshot,
  Settings,
  SubmissionDraft,
  ToolRegistration,
} from "./types.ts"

/** Request identity of a Harness's model requests: the models' defaults with provider attribution to pi. */
export const DEFAULT_HARNESS_IDENTITY: ClientIdentity = { attribution: PI_ATTRIBUTION }

/** What a viewer's calls that would run tasks fail with. */
const RUNNING_REFUSED = new ReadOnlySession({ message: "Read-only Harness: running tasks refused" })

/** A conversation whose run task is not `pi.generation` compacts its own context, so `compact()` refuses. */
export class CompactionRefused extends Data.TaggedError("CompactionRefused")<{ readonly message: string }> {}

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
  /** Merged over `DEFAULT_HARNESS_IDENTITY` into every model request. */
  readonly identity?: ClientIdentity
  /** The host's policy, read at each use. */
  readonly settings?: HarnessSettings | (() => HarnessSettings | undefined)
  /** Builds a conversation's execution environment; without it tasks get none. */
  readonly env?: (target: EnvTarget) => Effect.Effect<ExecutionEnv | undefined, unknown>
  /** The clock tasks and documents are stamped with. Default: Effect's `Clock`. */
  readonly now?: () => number
  /** A viewer of a Session another process drives: nothing is written or run (spec 2.2). */
  readonly readOnly?: boolean
  readonly onReport?: (report: Report) => void
  /** Runs in the commit that ends a run, whatever ended it. */
  readonly runEnded?: RunEndedHook
  /** Runs in every commit that withdraws a queued input, whatever withdrew it. */
  readonly inputWithdrawn?: InputWithdrawnHook
  /** Conversation documents of the host's that the conversation view carries beside the built-in ones. */
  readonly viewDocs?: readonly AnyDocToken[]
  /** The host's run tasks besides `pi.generation`, and which one an agent's model runs on. */
  readonly runTasks?: RunTasks
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
  /**
   * Starts a new context, history kept; `handoff` is the first message of the new context (spec 7.1). Behind a live run
   * the reset waits in the inbox, as every write does. `data` is the `pi.reset` entry's, such as who reset it.
   */
  reset(handoff?: string, data?: JsonObject): Effect.Effect<void, ReadError | CommitError>
  /**
   * Starts a manual compaction of the conversation, focused by `instructions` (spec 8.7). It never takes run control:
   * its summary is placed like a write. `Conversation.abort()` aborts it. `data` goes on the `pi.compaction` entry,
   * such as who asked.
   */
  compact(
    instructions?: string,
    data?: JsonObject,
  ): Effect.Effect<TaskId<CompactionResult>, CommitError | ReadOnlySession | CompactionRefused>
  /** Admits a submission in its own commit (spec 6). */
  submit(draft: SubmissionDraft): Effect.Effect<Submission, AdmissionError | ReadError | CommitError>
  /** Admits a submission inside `tx`, before the commit's first table write; it is stored or lost with that commit. */
  submit(tx: Tx, draft: SubmissionDraft): Effect.Effect<SubmissionId, AdmissionError | ReadError>
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
  /**
   * A watch of the conversation view through `window` (spec 9.3): changes wait, folded, while the consumer is busy. The
   * scope's end stops it; the Session's close ends it.
   */
  watch(window?: ConversationWindow): Effect.Effect<DocumentWatch<ConversationView>, ReadFailure, Scope.Scope>
}

export type HarnessInspection = {
  readonly scheduling: "paused" | "running" | "closing"
  readonly tasks: readonly TaskInspection[]
  readonly submissions: readonly SubmissionRecord[]
}

export interface Harness<T extends ToolRegistration = ToolRegistration> {
  readonly session: Session
  readonly registry: RegistryReader<T>
  /** The tasks that carry runs besides `pi.generation`. */
  readonly runTasks: RunTasks
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
  /** Live tasks and the submissions not settled yet, queued and placed, in ID order. */
  readonly inspect: Effect.Effect<HarnessInspection, ReadFailure>
  /** The handle of an existing submission. */
  submission(id: SubmissionId): Effect.Effect<Submission | undefined, ReadFailure>
  /**
   * Withdraws a queued submission; `conversationId` limits it to that conversation's submissions. `data` reaches the
   * host's `inputWithdrawn`, such as who withdrew it.
   */
  abortSubmission(
    id: SubmissionId,
    conversationId?: ConversationId,
    data?: JsonObject,
  ): Effect.Effect<AbortResult | "not_found", ReadFailure | CommitError>
  /** Every conversation's committed `pi.usage`, summed. */
  readonly usage: Effect.Effect<UsageState, ReadFailure>
  /**
   * Attaches an observer of the conversation view through `window` (spec 9.3), atomically on the Session line. Its
   * `advance` runs on the line, so it must only capture.
   */
  observeConversation(
    id: ConversationId,
    observer: DocumentObserver<ConversationView>,
    window?: ConversationWindow,
  ): Effect.Effect<DocumentObservation<ConversationView>, ReadFailure>
  /** A watch of the task graph (spec 9.4); the scope's end stops it. It never enables scheduling. */
  readonly watchTaskGraph: Effect.Effect<DocumentWatch<TaskGraph>, ReadFailure, Scope.Scope>
  /** Attaches an observer of the task graph (spec 9.4), atomically on the Session line. */
  observeTaskGraph(observer: DocumentObserver<TaskGraph>): Effect.Effect<DocumentObservation<TaskGraph>, ReadFailure>
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
    const host = new HarnessHost(options, yield* Effect.context<never>())
    const now = host.clock
    const session = yield* makeSession(storage, {
      readOnly: options.readOnly === true,
      ...(now === undefined ? {} : { now }),
      documentRetentionMs: () => host.hostSettings()?.documentRetentionMs,
      conversationCreated: (tx, record) => host.conversationCreated(tx, record),
      reportTelemetry: (error) => host.report(error, { kind: "host_error", callback: "telemetry" }),
    })
    // The Session's failure is reported once: at the seal when it failed the Session, or when the close ends failed, for
    // a failure the close itself met (Storage's close, a write still in flight). Watched before the scheduler opens, so
    // a failure that fails open is reported too.
    let reported = false
    const reportFailure = (error: unknown) => {
      if (reported) return
      reported = true
      host.report(error, { kind: "storage_failed" })
    }
    session.subscribeClose(() => {
      const failure = session.failure
      if (failure !== undefined) reportFailure(failure.error)
    })
    Effect.runFork(
      Effect.map(session.closed, (end) => {
        if (end.kind === "failed") reportFailure(end.error)
      }),
    )
    const scheduler = yield* Effect.onError(
      openTaskScheduler<TaskServices>({
        session,
        registry: options.registry,
        services: (phase) => Layer.succeed(TaskServices, host.taskApi(phase)),
        restartLimit: () => host.settings().restartLimit,
        limitsRestarts: (kind) => limitsRestarts(host.runTasks, kind),
        settleOutcome: (tx, record, outcome) =>
          settleSchedulerOutcome(
            tx,
            record,
            outcome,
            host.runTasks,
            options.runEnded,
            host.settings().afterFailedRun,
            options.inputWithdrawn,
          ),
        withdrawInputs: (tx, conversationId) =>
          withdrawQueuedInputs(tx, conversationId, "aborted", options.inputWithdrawn),
        queuedInputs: (reads) => queuedConversations(reads),
        report: (error, report, snapshot, span) => host.report(error, host.taskReport(report, snapshot), span),
        readOnly: options.readOnly === true,
      }),
      () => Effect.ignore(session.close),
    )
    const clock = yield* Clock.Clock
    const contexts = new ContextReads(session, {
      now: () => host.now(),
      retentionMs: () => host.settings().contextRetentionMs,
      waitForIdle: (conversationId) => scheduler.waitForIdle(conversationId),
      clock,
    })
    return host.bind(session, scheduler, clock, contexts, {
      propagation: yield* TracePropagation,
      tracer: yield* Effect.tracer,
      report: (error) => host.report(error, { kind: "host_error", callback: "telemetry" }),
    })
  })

/** Conversations with queued submissions, from a scan of every queued one. */
const queuedConversations = (reads: StorageReads): Effect.Effect<readonly ConversationId[], ReadError> =>
  Effect.map(
    scanAll((cursor) => reads.scanSubmissions({ status: "queued" }, SCAN_PAGE_SIZE, cursor)),
    (queued) => [...new Set(queued.map((record) => record.conversationId))],
  )

/** Collects every page of a scan. */
const scanAll = <T, E>(page: (cursor: Cursor | undefined) => Effect.Effect<Page<T>, E>): Effect.Effect<T[], E> =>
  Effect.gen(function* () {
    const items: T[] = []
    let cursor: Cursor | undefined
    do {
      const next = yield* page(cursor)
      items.push(...next.items)
      cursor = next.next
    } while (cursor !== undefined)
    return items
  })

const SCAN_PAGE_SIZE = 256

/** What a Harness keeps; its parts are bound once the Session and scheduler are open. */
class HarnessHost<T extends ToolRegistration> implements Harness<T> {
  readonly #options: HarnessOptions<T>
  #session: Session | undefined
  #scheduler: TaskScheduler | undefined
  #submissions: Submissions | undefined
  #effectClock: Clock.Clock | undefined
  #contexts: ContextReads | undefined
  #views: ConversationViews | undefined
  #graph: TaskGraphView | undefined

  /** The host's clock behind `safeNow`; `undefined` for Effect's `Clock`. */
  readonly clock: (() => number) | undefined

  /** The host's run tasks; without any, every run is a chain of generations. */
  get runTasks(): RunTasks {
    return this.#options.runTasks ?? GENERATION_RUNS
  }

  /** The context the Harness opened in, whose metric registry reports are counted in. */
  readonly #telemetry: Context.Context<never>

  constructor(options: HarnessOptions<T>, telemetry: Context.Context<never>) {
    this.#options = options
    this.#telemetry = telemetry
    const now = options.now
    this.clock =
      now === undefined
        ? undefined
        : safeNow(now, (error) => this.report(error, { kind: "host_error", callback: "now" }))
  }

  bind(
    session: Session,
    scheduler: TaskScheduler,
    clock: Clock.Clock,
    contexts: ContextReads,
    telemetry: SubmitTelemetry,
  ): this {
    this.#session = session
    this.#scheduler = scheduler
    this.#effectClock = clock
    this.#contexts = contexts
    this.#views = new ConversationViews(session, this.#options.viewDocs)
    this.#graph = new TaskGraphView(session, scheduler)
    this.#submissions = new Submissions(
      session,
      () => this.now(),
      () => this.settings(),
      this.#options.readOnly === true ? Effect.void : scheduler.resume,
      telemetry,
      this.runTasks,
      this.#options.inputWithdrawn,
    )
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

  get submissions(): Submissions {
    return this.#submissions!
  }

  /** The Session's clock: the host's, or Effect's. */
  now(): number {
    return this.clock?.() ?? this.#effectClock!.currentTimeMillisUnsafe()
  }

  hostSettings(): HarnessSettings | undefined {
    const settings = this.#options.settings
    return typeof settings === "function" ? settings() : settings
  }

  settings(): Settings {
    return resolveSettings(this.hostSettings())
  }

  /** The host's models with the Harness's request identity applied; each `Models` is wrapped once. */
  models(): Models {
    const option = this.#options.models
    const models = typeof option === "function" ? option() : option
    let wrapped = this.#identified.get(models)
    if (wrapped === undefined) {
      const identity = mergeClientIdentity(DEFAULT_HARNESS_IDENTITY, this.#options.identity) ?? DEFAULT_HARNESS_IDENTITY
      wrapped = withClientIdentity(models, identity)
      this.#identified.set(models, wrapped)
    }
    return wrapped
  }

  readonly #identified = new WeakMap<Models, Models>()

  /** Forwards a report to the host; a host callback that throws is dropped, since reporting it would report again. */
  /**
   * A scheduler report with the extension whose definition its task has: by the snapshot the task ran with, else by the
   * registry's current one.
   */
  taskReport(report: TaskReport, snapshot?: unknown): ReportInfo {
    if (!("task" in report)) return report
    const kind = report.task.kind
    const extension = ((snapshot as RegistrySnapshot<T> | undefined) ?? this.registry.snapshot())
      .installed()
      .find((extension) => extension.tasks?.some((task) => task.definition.name === kind) === true)
    return extension === undefined ? report : { ...report, extension: extension.name }
  }

  /**
   * Forwards a report to the host, then counts it in `pi.durable.reports` and records its content-free event on `span`,
   * the span it was raised in, if any. A throwing host callback, metric or event is dropped: reporting it would report
   * again.
   */
  report(error: unknown, info: ReportInfo, span?: Tracer.Span): void {
    try {
      this.#options.onReport?.({ ...info, error })
    } catch {
      // Dropped: see above.
    }
    recordReport(info, span, this.#telemetry)
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

  get inspect(): Effect.Effect<HarnessInspection, ReadFailure> {
    return Effect.gen({ self: this }, function* () {
      // One job on the line: an inspect queued before close began reports it, and sees one committed state (spec 2.2).
      return yield* this.session.read((storage) =>
        Effect.gen({ self: this }, function* () {
          const { scheduling, tasks } = yield* this.#tasks.inspectOnLine
          const scan = (status: "queued" | "placed") =>
            scanAll((cursor) => storage.scanSubmissions({ status }, SCAN_PAGE_SIZE, cursor))
          const submissions = [...(yield* scan("queued")), ...(yield* scan("placed"))].sort((a, b) => a.id - b.id)
          return { scheduling, tasks, submissions }
        }),
      )
    })
  }

  submission(id: SubmissionId): Effect.Effect<Submission | undefined, ReadFailure> {
    return this.submissions.get(id)
  }

  abortSubmission(
    id: SubmissionId,
    conversationId?: ConversationId,
    data?: JsonObject,
  ): Effect.Effect<AbortResult | "not_found", ReadFailure | CommitError> {
    return this.submissions.abort(id, conversationId, data)
  }

  /** Every conversation's committed `pi.usage`, summed. Each document is read at its own point; totals only grow. */
  get usage(): Effect.Effect<UsageState, ReadFailure> {
    return Effect.gen({ self: this }, function* () {
      const conversations = yield* this.session.read((storage) =>
        scanAll((cursor) => storage.scanConversations({}, SCAN_PAGE_SIZE, cursor)),
      )
      const total = UsageDoc.definition.initial()
      for (const { id } of conversations) {
        const state = yield* this.session.snapshot(UsageDoc, id)
        if (state !== undefined) addUsageState(total, state)
      }
      return total
    })
  }

  observeConversation(
    id: ConversationId,
    observer: DocumentObserver<ConversationView>,
    window?: ConversationWindow,
  ): Effect.Effect<DocumentObservation<ConversationView>, ReadFailure> {
    return this.#views!.observe(id, observer, window)
  }

  get watchTaskGraph(): Effect.Effect<DocumentWatch<TaskGraph>, ReadFailure, Scope.Scope> {
    return watchOf((observer) => this.#graph!.observe(observer))
  }

  observeTaskGraph(observer: DocumentObserver<TaskGraph>): Effect.Effect<DocumentObservation<TaskGraph>, ReadFailure> {
    return this.#graph!.observe(observer)
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
      reset: (handoff, data) => this.#reset(id, handoff, data),
      compact: (instructions, data) => {
        const input = {
          reason: "manual" as const,
          ...(instructions === undefined ? {} : { instructions }),
          ...(data === undefined ? {} : { data }),
        }
        return Effect.andThen(
          this.resume,
          commitIn(this.session, { conversationId: id }, (tx) =>
            Effect.gen({ self: this }, function* () {
              // An agent that runs its own loop compacts its own context; the compaction task has no model to ask.
              const model = (yield* tx.doc(AgentDoc, id)).model
              const runTask = this.runTasks.choose(model)
              if (runTask !== undefined) {
                return yield* new CompactionRefused({
                  message: `${model?.provider ?? "This provider"} compacts its own context: ${runTask.definition.name} runs this conversation`,
                })
              }
              return yield* createCompaction(tx, id, input)
            }),
          ),
        ) as Effect.Effect<TaskId<CompactionResult>, CommitError | ReadOnlySession | CompactionRefused>
      },
      submit: ((first: SubmissionDraft | Tx, second?: SubmissionDraft) =>
        isDraft(first)
          ? this.submissions.submit(id, first)
          : this.submissions.admit(first, id, second!)) as Conversation["submit"],
      commit: (body) => commitIn(this.session, { conversationId: id }, body),
      context: (options) => this.#contexts!.read(id, options?.at),
      entries: (query, limit, cursor) =>
        this.session.read((storage) => storage.scanEntries({ ...query, conversationId: id }, limit, cursor)),
      fork: (at, options) => this.#create({ kind: "fork", parentId: id, at, ownership: options.ownership }, options),
      abort: (options) => Effect.andThen(this.resume, this.#tasks.abortConversation(id, options)),
      get waitForIdle() {
        return Effect.andThen(host.resume, host.#tasks.waitForIdle(id))
      },
      watch: (window) => watchOf((observer) => this.#views!.observe(id, observer, window)),
    }
  }

  /** A reset is a write submission (spec 7.1): its `pi.reset` entry, `head: "self"`, carries the handoff. */
  #reset(
    id: ConversationId,
    handoff: string | undefined,
    data: JsonObject | undefined,
  ): Effect.Effect<void, ReadError | CommitError> {
    const model = handoff === undefined ? {} : { model: [{ role: "user", content: handoff, timestamp: this.now() }] }
    const entry = { kind: ResetEntry.kind, head: "self" as const, ...model, ...(data === undefined ? {} : { data }) }
    return Effect.asVoid(
      this.submissions.submit(id, { type: "write", entry }) as Effect.Effect<Submission, ReadError | CommitError>,
    )
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
      runOwner: { conversationId, runEnded: this.#options.runEnded },
      inputWithdrawn: this.#options.inputWithdrawn,
      runTasks: this.runTasks,
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
                host.report(Cause.squash(exit.cause), { kind: "extension_error", extension, task }, currentSpan())
              }
            }),
          ),
      },
      hookApi: {
        taskId: phase.record.id,
        conversationId,
        signal: runtime.signal,
        models: () => this.models(),
        memo: ((name: string, ...candidate: [JsonValue?]) =>
          candidate.length === 0 ? runtime.memo(name) : runtime.memo(name, candidate[0]!)) as HookApi["memo"],
        entry: (id) => runtime.entry(id),
        entries: (query, limit, cursor) => runtime.entries(query, limit, cursor),
        snapshot: (token, ...address) => runtime.snapshot(token, ...address),
      },
      context: (id, options) => runtime.guard(this.#contexts!.readFor(runtime, id, options?.at)),
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
                    // Refused once the invocation is aborted, before it ended: the task is winding down.
                    submit: ((first: SubmissionDraft | Tx, second?: SubmissionDraft) =>
                      runtime.signal.aborted
                        ? ended
                        : isDraft(first)
                          ? runtime.guard(
                              Effect.map(this.submissions.submit(record.id, first), (submission) => ({
                                ...submission,
                                status: runtime.guard(submission.status),
                                wait: runtime.guard(submission.wait),
                                abort: runtime.guard(submission.abort),
                              })),
                            )
                          : runtime.guard(
                              this.submissions.admit(first, record.id, second!),
                            )) as ConversationHandle["submit"],
                    abort: (options) => runtime.guard(this.#tasks.abortConversation(record.id, options)),
                    waitForIdle: runtime.guard(
                      Effect.raceFirst(
                        this.#tasks.waitForIdle(record.id),
                        // A failed Session ends the invocation too; the wait ends with that failure, as the
                        // scheduler's waits do.
                        Effect.andThen(
                          aborted(runtime.signal),
                          Effect.suspend(() => sessionEnd(this.session, ended)),
                        ),
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
          currentSpan(),
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

/** `SessionFailed` once the Session failed, else `otherwise`. */
const sessionEnd = <A, E>(session: Session, otherwise: Effect.Effect<A, E>): Effect.Effect<A, E | SessionFailed> => {
  const failure = session.failure
  return failure === undefined ? otherwise : Effect.fail(SessionFailed.of(failure.error))
}

/** A watch over an observer the views always attach. */
const watchOf = <T>(
  observe: (observer: DocumentObserver<T>) => Effect.Effect<DocumentObservation<T>, ReadFailure>,
): Effect.Effect<DocumentWatch<T>, ReadFailure, Scope.Scope> => Effect.map(makeWatch(observe), (watch) => watch!)

const isDraft = (value: SubmissionDraft | Tx): value is SubmissionDraft => "type" in value

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

/**
 * Counts a report in `pi.durable.reports` by its kind and records its fixed fields as a `pi.durable.report` event on
 * `span`; never the error itself. Telemetry that throws is dropped, as reporting it would report again.
 */
export function recordReport(info: ReportInfo, span: Tracer.Span | undefined, context: Context.Context<never>): void {
  updateMetric(DurableMetrics.reports, 1, { type: info.kind }, context, () => {})
  if (span === undefined) return
  const fields = info as {
    readonly reason?: string
    readonly extension?: string
    readonly task?: { readonly id: TaskId }
  }
  try {
    span.event("pi.durable.report", spanTime(), {
      type: info.kind,
      ...(fields.reason === undefined ? {} : { reason: fields.reason }),
      ...(fields.extension === undefined ? {} : { extension: fields.extension }),
      ...(fields.task === undefined ? {} : { "task.id": fields.task.id }),
    })
  } catch {
    // Dropped: see above.
  }
}
