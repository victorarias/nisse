// The Session: one mutation line over Storage, its loaded documents and their observers (spec sections 1, 3, 4, 9.1
// and 10.1).
//
// A line fiber takes jobs from a queue one at a time: commits, document reads and observer attachments, and cache
// sweeps. A commit runs its callback against a fresh transaction, sends the transaction's writes to Storage in one call
// (no group commit, D5), adopts its document changes, publishes the stored commit, and hands the outcome back. Because
// the line waits for each storage call to settle, no job ever runs while another commit is unpublished, so reads never
// see half-stored data without any key gates (spec 4, ledger A12).
//
// Nothing is woken directly from the line (F6). Completing a Deferred resumes the fiber waiting on it inside the
// completer's call, which on the line would run that fiber's code before the next job; outcomes therefore go back
// through a queue, whose waiter resumes later. Observers are called on the line, so they must only capture.
import { type Op, track } from "@nisse/delta"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option, Queue, type Scope, Tracer } from "effect"
import { spanTime, TracePropagation } from "../telemetry.ts"
import {
  type AnyDocDefinition,
  type AnyDocToken,
  addressId,
  atAddress,
  checkRecordScope,
  checkRecordVersion,
  type DocAddressArgs,
  type DocValue,
  materializeDocument,
  type RewindableAddressArgs,
  resolveAddress,
} from "../documents/definition.ts"
import { type CommitRefused, ReadOnlySession, SessionClosed, SessionFailed, StorageError } from "../errors.ts"
import type {
  ConversationRecord,
  DocumentAddress,
  DocumentId,
  EntryId,
  JsonObject,
  Seq,
  StorageWrite,
  TelemetryCarrier,
} from "../records.ts"
import type { ReadError, Storage } from "../storage.ts"
import {
  DEFAULT_DOCUMENT_RETENTION_MS,
  DocumentCache,
  type DocumentCacheSizes,
  type LoadedDocument,
} from "./documents.ts"
import { type CommitScope, type DocumentCommitChange, Transaction, type Tx } from "./transaction.ts"
import { type DocumentWatch, makeWatch } from "./watch.ts"

/** How a Session ended: closed, or failed with the first error (spec 10.1). */
export type SessionEnd = { readonly kind: "closed" } | { readonly kind: "failed"; readonly error: unknown }

/** A record or document change a commit stored. */
export type CommitChange =
  | Extract<StorageWrite, { readonly type: "conversation" | "entry" | "task" | "submission" }>
  | DocumentCommitChange

/** Every change one storage transaction stored, with its `seq`. Change order is unspecified. */
export type CommitPublication = {
  readonly seq: Seq
  readonly changes: readonly CommitChange[]
  /** The span the commit was made in, if any: its entry and settlement events are recorded on it. */
  readonly span?: Tracer.AnySpan
}

/**
 * How an observer ended: the Session closed after its last publication (`ended`), failed (`failed`), or the
 * observer's own `advance` threw (`listener_error`). Never after `detach()`.
 */
export type CommitObserverEnd =
  | { readonly kind: "ended" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "listener_error"; readonly error: unknown }

/**
 * Sees every stored commit, in line order, after storage stored it and before its commit resolves. `advance` runs on the
 * mutation line, so it must only capture what it needs: anything slow there delays every commit.
 */
export type CommitObserver = {
  advance(publication: CommitPublication): void
  end(end: CommitObserverEnd): void
}

export type CommitObservation = { detach(): void }

/**
 * One change at a document address: the newest value, the operations that turn the previous value into it, and whether
 * the incarnation followed was retired. A retirement carries the last value and no operations; a later incarnation at
 * the address arrives as a root replacement `[["r", value]]` (spec 9.1).
 */
export type DocumentChange<T> = { readonly value: Readonly<T>; readonly ops: readonly Op[]; readonly retired: boolean }

/** How a document observer ended: as a commit observer does; `ended` here is the Session's close. */
export type DocumentObserverEnd = CommitObserverEnd

/**
 * Follows one document address, as `observeCommits` does commits: `advance` runs on the line at each publication that
 * changes the address, one call per change. It must only capture; a throw detaches it and ends it `listener_error`.
 */
export type DocumentObserver<T> = {
  advance(change: DocumentChange<T>): void
  end(end: DocumentObserverEnd): void
}

/** An attached document observer: the value it starts from, which its first change applies to. */
export type DocumentObservation<T> = { readonly value: Readonly<T>; detach(): void }

/** The reads of Storage a `read` job may make. */
export type StorageReads = Omit<Storage, "commit" | "mintId" | "close">

/** Why a commit failed apart from its callback's own failure. */
export type CommitError = SessionFailed | SessionClosed | ReadOnlySession | StorageError | CommitRefused

/** Why a read of the Session failed: it is not open, or Storage failed. A misused token is a defect. */
export type ReadFailure = SessionFailed | SessionClosed | ReadError

export type SessionOptions = {
  /**
   * Opens a viewer: a commit with writes fails with `ReadOnlySession` before it reaches Storage, and the Session stays
   * healthy; a commit that writes nothing succeeds.
   */
  readonly readOnly?: boolean
  /**
   * The clock document retention and task lifecycle times are measured by, in ms. Default: Effect's `Clock` of the
   * context that opens the Session, so a `TestClock` controls it.
   */
  readonly now?: () => number
  /**
   * How long a loaded document with no observer stays in memory after its last use, in ms, read at each use; `0` drops
   * it after each use and `Infinity` keeps it. Default ten minutes.
   */
  readonly documentRetentionMs?: () => number | undefined
  /**
   * Runs inside every `Tx` call that creates or forks a conversation, before the call returns, so the creating commit
   * holds what it writes (spec 7.1). A failure fails that commit.
   */
  readonly conversationCreated?: (tx: Tx, record: ConversationRecord) => Effect.Effect<void, unknown>
  /**
   * Receives a telemetry failure while a commit is published, such as a throwing tracer or metric registry; the commit
   * stands. Default: dropped.
   */
  readonly reportTelemetry?: (error: unknown) => void
}

export interface Session {
  /**
   * Runs `body` as one atomic commit on the mutation line, after every commit admitted before it. Succeeds once the
   * commit is stored and published, with the callback's value. A callback failure or a defect rolls everything back.
   * Interrupting the caller before the commit reaches Storage abandons it; after that it stands.
   */
  commit<A, E>(body: (tx: Tx) => Effect.Effect<A, E>): Effect.Effect<A, E | CommitError>
  /** Attaches synchronously; gets every commit published after this call. */
  observeCommits(observer: CommitObserver): CommitObservation
  /** Called synchronously when closing begins, after admission is sealed, also when a failure closes the Session. */
  subscribeClose(listener: () => void): () => void
  /** Seals admission, lets every admitted commit finish, then closes Storage. Fails only if closing Storage fails. */
  readonly close: Effect.Effect<void, StorageError>
  /** Settles once the Session has closed, Storage included: after `close`, or after the failure that closed it. */
  readonly closed: Effect.Effect<SessionEnd>
  /** The first error that failed the Session, once one did; set before the close listeners run. */
  readonly failure: { readonly error: unknown } | undefined
  /** Whether `tx` is a transaction of one of this Session's commits. */
  owns(tx: Tx): boolean

  /**
   * The committed value at a document address, migrated in memory to the token's version; `undefined` when absent
   * (spec 3.3). Never creates or stores. The value is shared and must not be mutated.
   */
  snapshot<K extends AnyDocToken>(
    token: K,
    ...address: DocAddressArgs<K>
  ): Effect.Effect<Readonly<DocValue<K>> | undefined, ReadFailure>
  /**
   * A rewindable conversation document's value after the commit of entry `at`, which must be visible from the
   * conversation; read from the ancestor that owns the entry and the incarnation alive then (spec 3.3).
   */
  snapshotAsOf<K extends AnyDocToken>(
    token: K,
    ...address: RewindableAddressArgs<K>
  ): Effect.Effect<Readonly<DocValue<K>> | undefined, ReadFailure>
  /**
   * Attaches an observer to a document address, atomically on the line, from the incarnation there now; `undefined`
   * when absent (spec 9.1). It follows the address through retirements and new incarnations until `detach()` or the
   * Session's close. The observed incarnation stays loaded.
   */
  observeDoc<K extends AnyDocToken>(
    token: K,
    ...args: [...DocAddressArgs<K>, DocumentObserver<DocValue<K>>]
  ): Effect.Effect<DocumentObservation<DocValue<K>> | undefined, ReadFailure>
  /**
   * Watches a document address from its current incarnation; `undefined` when absent (spec 9.2). Acquisition and the
   * subscription are one step on the line; the scope's end detaches the watch.
   */
  watchDoc<K extends AnyDocToken>(
    token: K,
    ...address: DocAddressArgs<K>
  ): Effect.Effect<DocumentWatch<DocValue<K>> | undefined, ReadFailure, Scope.Scope>
  /**
   * Runs `body` on the line, between commits, so every read it makes sees the same committed state. A storage error
   * there fails the Session, as in a commit.
   */
  read<A, E>(body: (storage: StorageReads) => Effect.Effect<A, E>): Effect.Effect<A, E | SessionFailed | SessionClosed>
  /**
   * Runs `body` beside the line, for reads of records no commit changes, such as entries at or below a tail read on the
   * line: commits go on meanwhile. A storage error fails the Session. What it read is refused once the Session failed
   * or began closing before it ended, and the close waits for it before closing Storage.
   */
  readOffLine<A, E>(
    body: (storage: StorageReads) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | SessionFailed | SessionClosed>
  /** Drops every loaded document not observed; the next access loads it from Storage. */
  readonly unloadDocuments: Effect.Effect<void, SessionFailed | SessionClosed>
  /** For tests that bound memory: what the document cache holds. */
  readonly documentCacheSizes: DocumentCacheSizes
}

/** Opens a Session over `storage`, which it then owns. The scope's end closes it. */
export const openSession = (
  storage: Storage,
  options: SessionOptions = {},
): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.acquireRelease(SessionImpl.make(storage, options), (session) => Effect.ignore(session.close))

/** Opens a Session that the caller closes with `close`; for hosts that manage its lifetime themselves. */
export const makeSession = (storage: Storage, options: SessionOptions = {}): Effect.Effect<Session> =>
  SessionImpl.make(storage, options)

/** What the task scheduler needs of a Session beyond its public surface. Not exported from the package. */
export interface SessionInternals {
  /** `commit` with a bound scope, whose callback gets the transaction with its scheduler operations. */
  commitIn<A, E>(scope: CommitScope, body: (tx: Transaction) => Effect.Effect<A, E>): Effect.Effect<A, E | CommitError>
  /**
   * Adds a step closing runs after the line drained and every observer ended, before Storage closes: nothing is
   * published any more, and `store` writes straight to Storage. A failed write fails the Session.
   */
  onClosing(step: (store: (writes: readonly StorageWrite[]) => Effect.Effect<void>) => Effect.Effect<void>): void
  /** Fails the Session with an error of the scheduler's own commits. */
  fail(error: unknown): void
  /** The Session's clock, in ms. */
  now(): number
  /**
   * At a publication: runs `task` once every commit observer saw it, so a microtask `task` queues follows the ones the
   * observers queued.
   */
  afterPublication(task: () => void): void
  /** Storage's reads behind the failure rule, for code that runs inside a job on the line, such as a commit callback. */
  readonly lineReads: StorageReads
}

export const internals = (session: Session): SessionInternals => session as SessionImpl

type Job = {
  /** Set by the caller once it stops waiting; the line skips a job not started, and interrupts its callback. */
  cancelled: boolean
  /** The callback's fiber, while it runs. */
  callback: Fiber.Fiber<unknown, unknown> | undefined
  /** Set once the commit goes to Storage; from then on it stands. */
  storing: boolean
  readonly run: Effect.Effect<void>
}

/** An attached document observer, following its address. */
type Attached = {
  readonly addressId: string
  readonly address: DocumentAddress
  /** The incarnation followed; none while the address is absent. */
  incarnation: DocumentId | undefined
  /** Its value; none while the address is absent, so nothing retired stays referenced. */
  value: Readonly<JsonObject> | undefined
  /** The definition version the value has: a change of another version is shown whole. */
  version: number
  unpin: () => void
  observer: DocumentObserver<JsonObject> | undefined
}

const NO_OPS: readonly Op[] = []

/** The longest delay `setTimeout` takes: 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

class SessionImpl implements Session, SessionInternals {
  readonly #storage: Storage
  readonly #readOnly: boolean
  readonly #jobs: Queue.Queue<Job, Cause.Done>
  readonly #closedEnd: Deferred.Deferred<SessionEnd>
  readonly #observers = new Set<CommitObserver>()
  /** Tasks for after the current publication's observers. */
  #afterPublication: (() => void)[] = []
  readonly #closeListeners = new Set<() => void>()
  readonly #cache: DocumentCache
  /** Attached document observers by address. */
  readonly #documentObservers = new Map<string, Set<Attached>>()
  readonly #now: () => number
  readonly #conversationCreated: SessionOptions["conversationCreated"]
  readonly #reportTelemetry: (error: unknown) => void
  /** The host's trace propagation, from the context the Session opened in. */
  readonly #propagation: TracePropagation | undefined
  #line: Fiber.Fiber<void> | undefined
  /** The first error that failed the Session. */
  #failure: { readonly error: unknown } | undefined
  /** Admission is sealed: closing or failed. */
  #sealed = false
  #closing: Fiber.Fiber<void> | undefined
  /** How observers end, set once the line has drained and nothing more can be published. */
  #observersEnded: CommitObserverEnd | undefined
  /** A failure of `Storage.close()` during a clean close, which `close` fails with. */
  #closeError: StorageError | undefined
  /** Storage's reads, each behind the failure rule. */
  readonly #reads: StorageReads
  /** Reads underway beside the line, and what a close waiting for them to end awaits. */
  #offLine = 0
  #offLineEnded: Deferred.Deferred<void> | undefined
  readonly #closingSteps: ((store: (writes: readonly StorageWrite[]) => Effect.Effect<void>) => Effect.Effect<void>)[] =
    []
  /** The pending cache sweep: a job queued on the line, or a timer and the time it fires. */
  #sweep: { readonly at: number; readonly timer: ReturnType<typeof setTimeout> | undefined } | undefined

  private constructor(
    storage: Storage,
    options: SessionOptions,
    jobs: Queue.Queue<Job, Cause.Done>,
    closed: Deferred.Deferred<SessionEnd>,
    clock: Clock.Clock,
    propagation: TracePropagation | undefined,
  ) {
    this.#storage = storage
    this.#propagation = propagation
    const reportTelemetry = options.reportTelemetry ?? (() => {})
    this.#reportTelemetry = (error) => {
      try {
        reportTelemetry(error)
      } catch {
        // Dropped: reporting it would report again.
      }
    }
    this.#readOnly = options.readOnly === true
    this.#conversationCreated = options.conversationCreated
    this.#jobs = jobs
    this.#closedEnd = closed
    this.#reads = guardedReads(storage, (call) => this.#storageCall(call))
    const now = options.now ?? (() => clock.currentTimeMillisUnsafe())
    // Cache bookkeeping never changes the outcome of what it follows: a throwing clock or retention is the default.
    this.#now = () => {
      try {
        return now()
      } catch {
        return Date.now()
      }
    }
    const retention = options.documentRetentionMs ?? (() => undefined)
    this.#cache = new DocumentCache({
      now: this.#now,
      retentionMs: () => {
        try {
          const ms = retention()
          return typeof ms === "number" && ms >= 0 ? ms : DEFAULT_DOCUMENT_RETENTION_MS
        } catch {
          return DEFAULT_DOCUMENT_RETENTION_MS
        }
      },
      schedule: (delayMs) => this.#scheduleSweep(delayMs),
    })
  }

  static make(storage: Storage, options: SessionOptions): Effect.Effect<SessionImpl> {
    return Effect.gen(function* () {
      const session = new SessionImpl(
        storage,
        options,
        yield* Queue.unbounded<Job, Cause.Done>(),
        yield* Deferred.make<SessionEnd>(),
        yield* Clock.Clock,
        yield* TracePropagation,
      )
      // Detached: the line ends when close ends its queue, never by interruption.
      session.#line = yield* Effect.forkDetach(session.#runLine())
      return session
    })
  }

  commit<A, E>(body: (tx: Tx) => Effect.Effect<A, E>): Effect.Effect<A, E | CommitError> {
    return this.commitIn(NO_SCOPE, body)
  }

  onClosing(step: (store: (writes: readonly StorageWrite[]) => Effect.Effect<void>) => Effect.Effect<void>): void {
    this.#closingSteps.push(step)
  }

  now(): number {
    return this.#now()
  }

  get lineReads(): StorageReads {
    return this.#reads
  }

  fail(error: unknown): void {
    this.#fail(error)
    // A failure outside a job starts closing at once: no job may come to notice it.
    this.#beginClose()
  }

  commitIn<A, E>(
    scope: CommitScope,
    body: (tx: Transaction) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | CommitError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const refused = this.#admissionError()
        if (refused !== undefined) return yield* Effect.fail(refused)
        const span = Option.getOrUndefined(yield* Effect.serviceOption(Tracer.ParentSpan))
        const reply = yield* Queue.bounded<Exit.Exit<A, E | CommitError>>(1)
        const job: Job = {
          cancelled: false,
          callback: undefined,
          storing: false,
          run: Effect.suspend(() => (job.cancelled ? Effect.void : this.#runCommit(job, scope, body, reply, span))),
        }
        if (!(yield* Queue.offer(this.#jobs, job)))
          return yield* Effect.fail(this.#admissionError() ?? SessionClosed.instance)
        const exit = yield* restore(Queue.take(reply)).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              job.cancelled = true
              return job.callback !== undefined && !job.storing ? Fiber.interrupt(job.callback) : Effect.void
            }),
          ),
        )
        return yield* exit
      }),
    )
  }

  observeCommits(observer: CommitObserver): CommitObservation {
    // Until the admitted commits have drained, a closing Session still publishes; after that it never will.
    const ended = this.#observersEnded
    if (ended !== undefined) {
      contain(() => observer.end(ended))
      return { detach: () => {} }
    }
    this.#observers.add(observer)
    return { detach: () => void this.#observers.delete(observer) }
  }

  subscribeClose(listener: () => void): () => void {
    const own = () => listener()
    this.#closeListeners.add(own)
    return () => void this.#closeListeners.delete(own)
  }

  get close(): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function* () {
      this.#beginClose()
      yield* Deferred.await(this.#closedEnd)
      if (this.#closeError !== undefined) return yield* Effect.fail(this.#closeError)
    })
  }

  get closed(): Effect.Effect<SessionEnd> {
    return Deferred.await(this.#closedEnd)
  }

  get failure(): { readonly error: unknown } | undefined {
    return this.#failure
  }

  owns(tx: Tx): boolean {
    return Transaction.over(tx, this.#storage)
  }

  // Documents

  snapshot<K extends AnyDocToken>(token: K, ...address: DocAddressArgs<K>) {
    return Effect.suspend(() => {
      const refused = this.#admissionError()
      if (refused !== undefined) return Effect.fail(refused)
      const definition = token.definition
      const resolved = resolveAddress(definition, address)
      // A tracker of the token's version serves without the line: adoption swaps it synchronously on the line.
      const cached = this.#cache.peek(resolved.id)
      if (cached?.valueVersion === definition.version) {
        this.#cache.touch(resolved.id)
        return Effect.succeed(checkedValue(definition, cached))
      }
      return this.#onLine(
        Effect.map(this.#loadDocument(definition, resolved.id, resolved.address), (loaded) =>
          loaded === undefined ? undefined : checkedValue(definition, loaded),
        ),
      )
    }) as Effect.Effect<Readonly<DocValue<K>> | undefined, ReadFailure>
  }

  snapshotAsOf<K extends AnyDocToken>(token: K, ...args: RewindableAddressArgs<K>) {
    return Effect.suspend(() => {
      const refused = this.#admissionError()
      if (refused !== undefined) return Effect.fail(refused)
      const definition = token.definition
      const resolved = resolveAddress(definition, args)
      const scope = resolved.address.scope
      if (scope.kind !== "conversation") throw new TypeError("Session.snapshotAsOf() requires a conversation document")
      const at = args[resolved.nextArgument]
      if (typeof at !== "number" || !Number.isSafeInteger(at))
        throw new TypeError("Session.snapshotAsOf() requires an entry ID")
      return this.#onLine(
        Effect.gen({ self: this }, function* () {
          const stored = yield* this.#storageCall(this.#storage.entry(scope.conversationId, at as EntryId))
          if (stored === undefined) {
            return yield* Effect.die(new Error(`Entry ${at} is not visible from conversation ${scope.conversationId}`))
          }
          const address: DocumentAddress = {
            ...resolved.address,
            scope: { kind: "conversation", conversationId: stored.entry.conversationId },
          }
          const record = yield* this.#storageCall(this.#storage.findDocument(address, stored.commitSeq))
          if (record === undefined) return undefined
          const document = yield* this.#storageCall(this.#storage.document(record.id, stored.commitSeq))
          if (document === undefined) {
            return yield* Effect.die(new Error(`Historical document ${record.id} (${record.kind}) cannot be read`))
          }
          return materializeDocument(definition, document)
        }),
      )
    }) as Effect.Effect<Readonly<DocValue<K>> | undefined, ReadFailure>
  }

  observeDoc<K extends AnyDocToken>(token: K, ...args: [...DocAddressArgs<K>, DocumentObserver<DocValue<K>>]) {
    return Effect.suspend(() => {
      const refused = this.#admissionError()
      if (refused !== undefined) return Effect.fail(refused)
      const definition = token.definition
      const resolved = resolveAddress(definition, args)
      const observer = args[resolved.nextArgument] as DocumentObserver<JsonObject>
      return this.#onLine(
        Effect.flatMap(this.#loadDocument(definition, resolved.id, resolved.address), (loaded) => {
          // Close ends observers at its seal: one attached after it would never end.
          const sealed = this.#admissionError()
          if (sealed !== undefined) return Effect.fail(sealed)
          return Effect.succeed(loaded === undefined ? undefined : this.#attach(definition, loaded, observer))
        }),
        (observation) => observation?.detach(),
      )
    }) as Effect.Effect<DocumentObservation<DocValue<K>> | undefined, ReadFailure>
  }

  watchDoc<K extends AnyDocToken>(token: K, ...address: DocAddressArgs<K>) {
    return makeWatch<DocValue<K>>((observer) =>
      this.observeDoc(
        token,
        ...([...address, observer] as unknown as [...DocAddressArgs<K>, DocumentObserver<DocValue<K>>]),
      ),
    )
  }

  read<A, E>(body: (storage: StorageReads) => Effect.Effect<A, E>) {
    return Effect.suspend(() => {
      const refused = this.#admissionError()
      if (refused !== undefined) return Effect.fail(refused)
      return this.#onLine(Effect.suspend(() => body(this.#reads)))
    })
  }

  readOffLine<A, E>(body: (storage: StorageReads) => Effect.Effect<A, E>) {
    return Effect.suspend(() => {
      const refused = this.#admissionError()
      if (refused !== undefined) return Effect.fail(refused)
      this.#offLine++
      return Effect.suspend(() => body(this.#reads)).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            this.#offLine--
            // A storage error here failed the Session outside any job, so nothing on the line starts its close.
            if (this.#failure !== undefined) this.#beginClose()
            const ended = this.#offLineEnded
            return this.#offLine === 0 && ended !== undefined ? Deferred.succeed(ended, undefined) : Effect.void
          }),
        ),
        Effect.flatMap((value) => {
          const late = this.#admissionError()
          return late === undefined ? Effect.succeed(value) : Effect.fail(late)
        }),
      )
    })
  }

  get unloadDocuments(): Effect.Effect<void, SessionFailed | SessionClosed> {
    return Effect.suspend(() => {
      const refused = this.#admissionError()
      if (refused !== undefined) return Effect.fail(refused)
      return this.#onLine(Effect.sync(() => this.#cache.unload()))
    })
  }

  get documentCacheSizes(): DocumentCacheSizes {
    return this.#cache.sizes
  }

  // The line

  #runLine(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const next = yield* Effect.exit(Queue.take(this.#jobs))
        if (Exit.isFailure(next)) return
        yield* next.value.run
        if (this.#failure !== undefined) this.#beginClose()
        else this.#cache.sweep()
      }
    })
  }

  /**
   * Runs `body` as a job on the line and hands its outcome back through a queue. A caller that stops waiting before the
   * job started skips it; `abandon` undoes what a job finished for a caller that stopped waiting.
   */
  #onLine<A, E>(
    body: Effect.Effect<A, E>,
    abandon?: (value: A) => void,
  ): Effect.Effect<A, E | SessionFailed | SessionClosed> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const reply = yield* Queue.bounded<Exit.Exit<A, E | SessionFailed>>(1)
        const job: Job = {
          cancelled: false,
          callback: undefined,
          storing: false,
          run: Effect.suspend(() => {
            if (job.cancelled) return Effect.void
            if (this.#failure !== undefined) return Queue.offer(reply, Exit.fail(this.#sessionFailed()))
            return Effect.flatMap(Effect.exit(body), (exit) => {
              if (job.cancelled) {
                if (Exit.isSuccess(exit)) abandon?.(exit.value)
                return Effect.void
              }
              return Queue.offer(reply, exit)
            })
          }),
        }
        if (!(yield* Queue.offer(this.#jobs, job)))
          return yield* Effect.fail(this.#admissionError() ?? SessionClosed.instance)
        const exit = yield* restore(Queue.take(reply)).pipe(
          Effect.onInterrupt(() =>
            Effect.flatMap(
              Effect.sync(() => {
                job.cancelled = true
              }),
              () =>
                Effect.map(Queue.poll(reply), (delivered) => {
                  if (delivered._tag === "Some" && Exit.isSuccess(delivered.value)) abandon?.(delivered.value.value)
                }),
            ),
          ),
        )
        return yield* exit
      }),
    )
  }

  #runCommit<A, E>(
    job: Job,
    scope: CommitScope,
    body: (tx: Transaction) => Effect.Effect<A, E>,
    reply: Queue.Queue<Exit.Exit<A, E | CommitError>>,
    span: Tracer.AnySpan | undefined,
  ) {
    const deliver = (exit: Exit.Exit<A, E | CommitError>) => Queue.offer(reply, exit)
    return Effect.gen({ self: this }, function* () {
      if (this.#failure !== undefined) return yield* deliver(Exit.fail(this.#sessionFailed()))
      const tx = new Transaction({
        storage: this.#storage,
        now: this.#now,
        scope,
        failed: (error) => this.#fail(error),
        cached: (id) => this.#cache.get(id),
        load: (definition, id, address) => this.#loadDocument(definition, id, address),
        install: (document) => this.#cache.install(document),
        retire: (id, recordId) => this.#cache.retire(id, recordId),
        trace: this.#traceOf(span),
        ...(this.#conversationCreated === undefined ? {} : { conversationCreated: this.#conversationCreated }),
      })
      const callback = yield* Effect.forkChild(
        Effect.suspend(() => body(tx)),
        { startImmediately: true },
      )
      job.callback = callback
      const done = yield* Fiber.await(callback)
      job.callback = undefined
      const { pending } = yield* tx.settle(Exit.isSuccess(done))
      if (job.cancelled) {
        tx.abort()
        return
      }
      // A callback that failed keeps its own outcome, also when a storage error it passed on failed the Session.
      if (Exit.isFailure(done)) return yield* deliver(done)
      if (pending) {
        return yield* deliver(Exit.die(new Error("Session commit callback settled before its pending Tx operations")))
      }
      // A callback that caught a failed read cannot commit.
      if (this.#failure !== undefined) {
        tx.abort()
        return yield* deliver(Exit.fail(this.#sessionFailed()))
      }
      // Nor can one that caught a defect of a Tx call that had begun changing the transaction.
      if (tx.poison !== undefined) {
        tx.abort()
        return yield* deliver(Exit.die(tx.poison.defect))
      }
      const assembled = yield* Effect.exit(tx.writes())
      if (Exit.isFailure(assembled)) return yield* deliver(Exit.failCause(assembled.cause))
      const writes = assembled.value
      if (writes.length === 0) {
        tx.abort()
        return yield* deliver(done)
      }
      if (this.#readOnly) {
        tx.abort()
        return yield* deliver(Exit.fail(ReadOnlySession.instance))
      }
      // A caller that stopped waiting while the writes were assembled abandons the commit: it has not reached Storage.
      if (job.cancelled) {
        tx.abort()
        return
      }

      job.storing = true
      let seq: Seq | undefined
      const stored = yield* Effect.exit(this.#storage.commit([writes], (_index, received) => void (seq = received)))
      // A commit Storage gave a receipt for is durable: it is adopted and published even when the call then fails.
      if (seq !== undefined) this.#publish(seq, writes, tx, span)
      else tx.abort()
      if (Exit.isFailure(stored)) {
        const error = failureOf(stored)
        this.#fail(error)
        return yield* deliver(Exit.fail(error))
      }
      const { refused } = stored.value
      if (refused !== undefined) {
        this.#fail(refused)
        return yield* deliver(Exit.fail(refused))
      }
      if (seq === undefined) {
        const error = StorageError.because("Storage committed without adopting the batch: it gave no receipt")
        this.#fail(error)
        return yield* deliver(Exit.fail(error))
      }
      return yield* deliver(done)
    })
  }

  /** Adopts a stored commit's document changes, then shows it to document observers and commit observers. */
  #publish(seq: Seq, writes: readonly StorageWrite[], tx: Transaction, span: Tracer.AnySpan | undefined): void {
    let documents: readonly DocumentCommitChange[]
    try {
      documents = tx.adopt(seq)
    } catch (error) {
      // Memory is behind what is stored: the Session cannot go on.
      this.#fail(error)
      return
    }
    const changes: CommitChange[] = []
    for (const write of writes) {
      if (
        write.type === "conversation" ||
        write.type === "entry" ||
        write.type === "task" ||
        write.type === "submission"
      )
        changes.push(write)
    }
    if (span?._tag === "Span") this.#recordEvents(span, writes)
    for (const change of documents) {
      changes.push(change)
      if (change.type === "document") this.#advanceDocumentObservers(change)
    }
    const publication: CommitPublication = { seq, changes, ...(span === undefined ? {} : { span }) }
    for (const observer of [...this.#observers]) {
      if (!this.#observers.has(observer)) continue
      try {
        // An `advance` may be async; its promise is watched, never awaited on the line.
        const returned: unknown = observer.advance(publication)
        if (isPromiseLike(returned)) returned.then(undefined, (error: unknown) => this.#observerFailed(observer, error))
      } catch (error) {
        this.#observerFailed(observer, error)
      }
    }
    const after = this.#afterPublication
    this.#afterPublication = []
    for (const task of after) task()
  }

  /**
   * The content-free events of a stored commit on the span it was made in: each entry it appends, and each submission
   * it settles. A throwing tracer is reported; the commit stands.
   */
  #recordEvents(span: Tracer.Span, writes: readonly StorageWrite[]): void {
    try {
      for (const write of writes) {
        if (write.type === "entry") {
          span.event("pi.durable.entry", spanTime(), { "entry.id": write.value.id, "entry.kind": write.value.kind })
        } else if (write.type === "submission") {
          const record = write.value
          if (record.status !== "done" && record.status !== "unanswered") continue
          span.event("pi.durable.submission", spanTime(), {
            "submission.id": record.id,
            status: record.status,
            ...(record.answer === undefined ? {} : { "answer.entry_id": record.answer }),
          })
        }
      }
    } catch (error) {
      this.#reportTelemetry(error)
    }
  }

  /** The carrier of `span` in the host's propagation, injected once, when a task created in the commit needs it. */
  #traceOf(span: Tracer.AnySpan | undefined): () => TelemetryCarrier | undefined {
    const propagation = this.#propagation
    if (span === undefined || propagation === undefined) return () => undefined
    let carrier: { readonly value: TelemetryCarrier | undefined } | undefined
    return () => {
      carrier ??= { value: propagation.inject(span) }
      return carrier.value
    }
  }

  afterPublication(task: () => void): void {
    this.#afterPublication.push(task)
  }

  /** A plain Session drops reports (spec 10.1): the observer is detached and told why, once. */
  #observerFailed(observer: CommitObserver, error: unknown): void {
    if (!this.#observers.delete(observer)) return
    contain(() => observer.end({ kind: "listener_error", error }))
  }

  // Document observers

  /** On the line: the current incarnation at an address, loaded from Storage when not cached at the token's version. */
  #loadDocument(
    definition: AnyDocDefinition,
    id: string,
    address: DocumentAddress,
  ): Effect.Effect<LoadedDocument | undefined, ReadError> {
    return Effect.gen({ self: this }, function* () {
      const cached = this.#cache.get(id)
      // A tracker serves only tokens of the version its value was materialized for; others reload from Storage.
      if (cached?.valueVersion === definition.version) return cached
      if (cached !== undefined) this.#cache.drop(id)
      const record = yield* this.#storageCall(this.#storage.findDocument(address, "current"))
      if (record === undefined) return undefined
      const stored = yield* this.#storageCall(this.#storage.document(record.id, "current"))
      if (stored === undefined) {
        return yield* Effect.die(new Error(`Current document ${record.id} (${record.kind}) cannot be read`))
      }
      const loaded: LoadedDocument = {
        addressId: id,
        record: stored.record,
        storedVersion: stored.version,
        valueVersion: definition.version,
        deltasSinceBase: stored.deltasSinceBase,
        tracker: track(materializeDocument(definition, stored)),
      }
      this.#cache.install(loaded)
      return loaded
    })
  }

  /** On the line: attaches `observer` to the address of `loaded`, pinning the incarnation it follows. */
  #attach(
    definition: AnyDocDefinition,
    loaded: LoadedDocument,
    observer: DocumentObserver<JsonObject>,
  ): DocumentObservation<JsonObject> {
    const value = checkedValue(definition, loaded)
    const attached: Attached = {
      addressId: loaded.addressId,
      address: loaded.record,
      incarnation: loaded.record.id,
      value,
      version: loaded.valueVersion,
      unpin: this.#cache.pin(loaded.addressId, loaded.record.id),
      observer,
    }
    let observers = this.#documentObservers.get(attached.addressId)
    if (observers === undefined) {
      observers = new Set()
      this.#documentObservers.set(attached.addressId, observers)
    }
    observers.add(attached)
    return { value, detach: () => void this.#detach(attached) }
  }

  /** Detaches once: nothing reaches the observer afterwards, and nothing of the Session references it. */
  #detach(attached: Attached): DocumentObserver<JsonObject> | undefined {
    const observer = attached.observer
    if (observer === undefined) return undefined
    attached.observer = undefined
    attached.value = undefined
    attached.unpin()
    const observers = this.#documentObservers.get(attached.addressId)
    observers?.delete(attached)
    if (observers?.size === 0) this.#documentObservers.delete(attached.addressId)
    return observer
  }

  /** At publication: one call per change at the address to each observer there (spec 9.1). */
  #advanceDocumentObservers(change: Extract<DocumentCommitChange, { readonly type: "document" }>): void {
    const observers = this.#documentObservers.get(addressId(change.record))
    if (observers === undefined) return
    for (const attached of [...observers]) {
      const observer = attached.observer
      if (observer === undefined || !atAddress(change.record, attached.address)) continue
      let call: DocumentChange<JsonObject>
      if (change.kind === "retire") {
        if (change.record.id !== attached.incarnation) continue
        // Set with every incarnation.
        call = { value: attached.value!, ops: NO_OPS, retired: true }
        attached.incarnation = undefined
        attached.value = undefined
        attached.unpin()
        attached.unpin = noop
      } else if (change.record.id !== attached.incarnation || change.version !== attached.version) {
        // A new incarnation, or a value of another definition version, whose shape the observer's does not have.
        if (change.record.id !== attached.incarnation) {
          attached.incarnation = change.record.id
          attached.unpin()
          attached.unpin = this.#cache.pin(attached.addressId, change.record.id)
        }
        attached.version = change.version
        attached.value = change.value
        call = { value: change.value, ops: [["r", change.value]], retired: false }
      } else {
        // A migration-only base changes nothing for an observer of the new version.
        if (change.ops.length === 0) continue
        attached.value = change.value
        call = { value: change.value, ops: change.ops, retired: false }
      }
      try {
        const returned: unknown = observer.advance(call)
        if (isPromiseLike(returned))
          returned.then(undefined, (error: unknown) => this.#documentObserverFailed(attached, error))
      } catch (error) {
        this.#documentObserverFailed(attached, error)
      }
    }
  }

  #documentObserverFailed(attached: Attached, error: unknown): void {
    const observer = this.#detach(attached)
    if (observer !== undefined) contain(() => observer.end({ kind: "listener_error", error }))
  }

  // The cache sweep

  /** Asks for a sweep in `delayMs`: on the line at once when due, otherwise by a timer that keeps no process alive. */
  #scheduleSweep(delayMs: number): void {
    if (this.#sealed) return
    const at = this.#now() + delayMs
    if (this.#sweep !== undefined && this.#sweep.at <= at) return
    if (this.#sweep?.timer !== undefined) clearTimeout(this.#sweep.timer)
    const run = (): void => {
      this.#sweep = undefined
      const job: Job = { cancelled: false, callback: undefined, storing: false, run: Effect.void }
      // The line sweeps after every job.
      Queue.offerUnsafe(this.#jobs, job)
    }
    if (delayMs <= 0 || !Number.isFinite(delayMs)) {
      if (!Number.isFinite(delayMs)) return
      this.#sweep = { at, timer: undefined }
      run()
      return
    }
    // A longer delay overflows the timer into 1 ms. Clamped, the timer fires early, the sweep finds nothing expired and
    // schedules the rest: one wake per 24.8 days.
    const timer = setTimeout(run, Math.min(delayMs, MAX_TIMER_MS))
    ;(timer as { unref?: () => void }).unref?.()
    this.#sweep = { at, timer }
  }

  // Failure and close

  /**
   * A storage call of a read job: its `StorageError` fails the Session, and the call fails with it too. A defect, such as
   * a stored record that does not parse, leaves the outcome unknown, so it is a `StorageError` as well.
   */
  #storageCall<A, E>(call: Effect.Effect<A, E>): Effect.Effect<A, E | StorageError> {
    return call.pipe(
      Effect.catchDefect((defect) => Effect.fail(StorageError.of(defect))),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error instanceof StorageError) this.#fail(error)
        }),
      ),
    )
  }

  #sessionFailed(): SessionFailed {
    return SessionFailed.of(this.#failure?.error)
  }

  #admissionError(): SessionFailed | SessionClosed | undefined {
    if (this.#failure !== undefined) return this.#sessionFailed()
    return this.#sealed ? SessionClosed.instance : undefined
  }

  /** Fails the Session with its first error; the line starts closing it after the current job. */
  #fail(error: unknown): void {
    if (this.#failure !== undefined) return
    this.#failure = { error }
    this.#sealed = true
  }

  #beginClose(): void {
    if (this.#closing !== undefined) return
    this.#sealed = true
    if (this.#sweep?.timer !== undefined) clearTimeout(this.#sweep.timer)
    this.#sweep = undefined
    for (const listener of [...this.#closeListeners]) contain(listener)
    // Document observers end at the seal, keeping their last value: no change of a commit settling during close.
    const end: DocumentObserverEnd =
      this.#failure === undefined ? { kind: "ended" } : { kind: "failed", error: this.#failure.error }
    for (const observers of [...this.#documentObservers.values()]) {
      for (const attached of [...observers]) {
        const observer = this.#detach(attached)
        if (observer !== undefined) contain(() => observer.end(end))
      }
    }
    this.#closing = Effect.runFork(this.#closeSession())
  }

  #closeSession(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // Every job admitted before the seal runs; after a failure each gets SessionFailed.
      yield* Queue.end(this.#jobs)
      if (this.#line !== undefined) yield* Fiber.await(this.#line)
      if (this.#offLine > 0) {
        const ended = yield* Deferred.make<void>()
        this.#offLineEnded = ended
        yield* Deferred.await(ended)
      }
      const failure = this.#failure
      const end: CommitObserverEnd =
        failure === undefined ? { kind: "ended" } : { kind: "failed", error: failure.error }
      this.#observersEnded = end
      // An observer's `end` may detach another, which then gets no `end`.
      for (const observer of [...this.#observers]) {
        if (this.#observers.delete(observer)) contain(() => observer.end(end))
      }
      this.#cache.clear()
      for (const step of this.#closingSteps.splice(0)) {
        const stepped = yield* Effect.exit(step((writes) => this.#storeAtClose(writes)))
        if (Exit.isFailure(stepped)) this.#fail(Cause.squash(stepped.cause))
      }
      const closed = yield* Effect.exit(this.#storage.close())
      if (failure !== undefined)
        return yield* Deferred.succeed(this.#closedEnd, { kind: "failed", error: failure.error })
      // A closing step's write that failed fails the close, as Storage's own close does.
      const stepFailure = this.#failure
      if (stepFailure !== undefined) {
        if (stepFailure.error instanceof StorageError) this.#closeError = stepFailure.error
        return yield* Deferred.succeed(this.#closedEnd, { kind: "failed", error: stepFailure.error })
      }
      if (Exit.isFailure(closed)) {
        const error = failureOf(closed)
        this.#failure = { error }
        this.#closeError = error
        return yield* Deferred.succeed(this.#closedEnd, { kind: "failed", error })
      }
      yield* Deferred.succeed(this.#closedEnd, { kind: "closed" })
    })
  }

  /** Writes straight to Storage while closing, after the line: nothing is published. A failure fails the Session. */
  #storeAtClose(writes: readonly StorageWrite[]): Effect.Effect<void> {
    if (writes.length === 0 || this.#failure !== undefined || this.#readOnly) return Effect.void
    return Effect.flatMap(Effect.exit(this.#storage.commit([writes], () => {})), (stored) => {
      if (Exit.isFailure(stored)) this.#fail(failureOf(stored))
      else if (stored.value.refused !== undefined) this.#fail(stored.value.refused)
      return Effect.void
    })
  }
}

const NO_SCOPE: CommitScope = {}

const noop = (): void => {}

/** Storage's reads, each through `guard`. */
function guardedReads(
  storage: Storage,
  guard: <A, E>(call: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageError>,
): StorageReads {
  return {
    conversation: (id) => guard(storage.conversation(id)),
    scanConversations: (query, limit, cursor) => guard(storage.scanConversations(query, limit, cursor)),
    entry: ((first: never, second?: never) =>
      guard(second === undefined ? storage.entry(first) : storage.entry(first, second))) as Storage["entry"],
    findLatestHeadMarker: (conversationId, at) => guard(storage.findLatestHeadMarker(conversationId, at)),
    scanEntries: (query, limit, cursor) => guard(storage.scanEntries(query, limit, cursor)),
    task: (id) => guard(storage.task(id)),
    scanTasks: (query, limit, cursor) => guard(storage.scanTasks(query, limit, cursor)),
    submission: (id) => guard(storage.submission(id)),
    scanSubmissions: (query, limit, cursor) => guard(storage.scanSubmissions(query, limit, cursor)),
    submissionByRequest: (conversationId, requestId) => guard(storage.submissionByRequest(conversationId, requestId)),
    findDocument: (address, at) => guard(storage.findDocument(address, at)),
    document: (id, at) => guard(storage.document(id, at)),
    scanDocuments: (query, limit, cursor) => guard(storage.scanDocuments(query, limit, cursor)),
  }
}

/** A loaded document's value, after checking the token agrees with what is stored. */
function checkedValue(definition: AnyDocDefinition, loaded: LoadedDocument): Readonly<JsonObject> {
  checkRecordScope(definition, loaded.record)
  checkRecordVersion(definition, loaded.record, loaded.storedVersion)
  return loaded.tracker.value
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"

/** Runs a callback that must not fail its caller. A plain Session drops what it throws or rejects with (spec 10.1). */
function contain(callback: () => unknown): void {
  try {
    // A callback may be async; its rejection is dropped like a throw, never left unhandled.
    const returned = callback()
    if (isPromiseLike(returned)) returned.then(undefined, () => {})
  } catch {
    // Dropped: a plain Session has no report handler.
  }
}

/** The typed failure of a storage call's exit; a defect there is also a storage error, since its outcome is unknown. */
function failureOf(exit: Exit.Failure<unknown, StorageError>): StorageError {
  const reason = exit.cause.reasons[0]
  if (reason?._tag === "Fail") return reason.error
  return StorageError.of(reason?._tag === "Die" ? reason.defect : new Error("Storage call was interrupted"))
}

/**
 * `Session.commit` bound to a scope: `tx.createTask()` defaults to its conversation, and entries the commit appends
 * record its task as `byTaskId`.
 */
export const commitIn = <A, E>(
  session: Session,
  scope: CommitScope,
  body: (tx: Tx) => Effect.Effect<A, E>,
): Effect.Effect<A, E | CommitError> => internals(session).commitIn(scope, body)
