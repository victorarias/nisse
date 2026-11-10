// The Session: one mutation line over Storage (spec sections 1, 4 and 10.1).
//
// A line fiber takes commit jobs from a queue one at a time. A job runs its callback against a fresh transaction, sends
// the transaction's writes to Storage in one call (no group commit, D5), publishes the stored commit, and hands the
// outcome back. Because the line waits for each storage call to settle, no job ever runs while another commit is
// unpublished, so reads never see half-stored data without any key gates (spec 4, ledger A12).
//
// Nothing is woken directly from the line (F6). Completing a Deferred resumes the fiber waiting on it inside the
// completer's call, which on the line would run that fiber's code before the next job; outcomes therefore go back
// through a queue, whose waiter resumes later. Commit observers are called on the line, so they must only capture.
import { type Cause, Deferred, Effect, Exit, Fiber, Queue, type Scope } from "effect"
import { type CommitRefused, ReadOnlySession, SessionClosed, SessionFailed, StorageError } from "../errors.ts"
import type { Seq, StorageWrite } from "../records.ts"
import type { Storage } from "../storage.ts"
import { Transaction, type Tx } from "./transaction.ts"

/** How a Session ended: closed, or failed with the first error (spec 10.1). */
export type SessionEnd = { readonly kind: "closed" } | { readonly kind: "failed"; readonly error: unknown }

/** A table record a commit stored. Documents join with `kernel-documents`. */
export type CommitChange = Extract<StorageWrite, { readonly type: "conversation" | "entry" | "task" | "submission" }>

/** Every change one storage transaction stored, with its `seq`. Change order is unspecified. */
export type CommitPublication = { readonly seq: Seq; readonly changes: readonly CommitChange[] }

/**
 * How a commit observer ended: the Session closed after its last publication (`ended`), failed (`failed`), or the
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

/** Why a commit failed apart from its callback's own failure. */
export type CommitError = SessionFailed | SessionClosed | ReadOnlySession | StorageError | CommitRefused

export type SessionOptions = {
  /**
   * Opens a viewer: a commit with writes fails with `ReadOnlySession` before it reaches Storage, and the Session stays
   * healthy; a commit that writes nothing succeeds.
   */
  readonly readOnly?: boolean
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
}

/** Opens a Session over `storage`, which it then owns. The scope's end closes it. */
export const openSession = (
  storage: Storage,
  options: SessionOptions = {},
): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.acquireRelease(SessionImpl.make(storage, options), (session) => Effect.ignore(session.close))

type Job = {
  /** Set by the caller once it stops waiting; the line skips a job not started, and interrupts its callback. */
  cancelled: boolean
  /** The callback's fiber, while it runs. */
  callback: Fiber.Fiber<unknown, unknown> | undefined
  /** Set once the commit goes to Storage; from then on it stands. */
  storing: boolean
  readonly run: Effect.Effect<void>
}

class SessionImpl implements Session {
  readonly #storage: Storage
  readonly #readOnly: boolean
  readonly #jobs: Queue.Queue<Job, Cause.Done>
  readonly #closedEnd: Deferred.Deferred<SessionEnd>
  readonly #observers = new Set<CommitObserver>()
  readonly #closeListeners = new Set<() => void>()
  #line: Fiber.Fiber<void> | undefined
  /** The first error that failed the Session. */
  #failure: { readonly error: unknown } | undefined
  /** Admission is sealed: closing or failed. */
  #sealed = false
  #closing: Fiber.Fiber<void> | undefined
  /** A failure of `Storage.close()` during a clean close, which `close` fails with. */
  #closeError: StorageError | undefined

  private constructor(
    storage: Storage,
    options: SessionOptions,
    jobs: Queue.Queue<Job, Cause.Done>,
    closed: Deferred.Deferred<SessionEnd>,
  ) {
    this.#storage = storage
    this.#readOnly = options.readOnly === true
    this.#jobs = jobs
    this.#closedEnd = closed
  }

  static make(storage: Storage, options: SessionOptions): Effect.Effect<SessionImpl> {
    return Effect.gen(function* () {
      const session = new SessionImpl(
        storage,
        options,
        yield* Queue.unbounded<Job, Cause.Done>(),
        yield* Deferred.make<SessionEnd>(),
      )
      // Detached: the line ends when close ends its queue, never by interruption.
      session.#line = yield* Effect.forkDetach(session.#runLine())
      return session
    })
  }

  commit<A, E>(body: (tx: Tx) => Effect.Effect<A, E>): Effect.Effect<A, E | CommitError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const refused = this.#admissionError()
        if (refused !== undefined) return yield* Effect.fail(refused)
        const reply = yield* Queue.bounded<Exit.Exit<A, E | CommitError>>(1)
        const job: Job = {
          cancelled: false,
          callback: undefined,
          storing: false,
          run: Effect.suspend(() => (job.cancelled ? Effect.void : this.#runCommit(job, body, reply))),
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
    if (this.#sealed) {
      observer.end(this.#failure === undefined ? { kind: "ended" } : { kind: "failed", error: this.#failure.error })
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

  // The line

  #runLine(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const next = yield* Effect.exit(Queue.take(this.#jobs))
        if (Exit.isFailure(next)) return
        yield* next.value.run
        if (this.#failure !== undefined) this.#beginClose()
      }
    })
  }

  #runCommit<A, E>(job: Job, body: (tx: Tx) => Effect.Effect<A, E>, reply: Queue.Queue<Exit.Exit<A, E | CommitError>>) {
    const deliver = (exit: Exit.Exit<A, E | CommitError>) => Queue.offer(reply, exit)
    return Effect.gen({ self: this }, function* () {
      if (this.#failure !== undefined) return yield* deliver(Exit.fail(this.#sessionFailed()))
      const tx = new Transaction({ storage: this.#storage, failed: (error) => this.#fail(error) })
      const callback = yield* Effect.forkChild(
        Effect.suspend(() => body(tx)),
        { startImmediately: true },
      )
      job.callback = callback
      const done = yield* Fiber.await(callback)
      job.callback = undefined
      tx.seal()
      if (job.cancelled) return
      // A callback that failed keeps its own outcome, also when a storage error it passed on failed the Session.
      if (Exit.isFailure(done)) return yield* deliver(done)
      // A callback that caught a failed read cannot commit.
      if (this.#failure !== undefined) return yield* deliver(Exit.fail(this.#sessionFailed()))
      const assembled = yield* Effect.exit(tx.writes())
      if (Exit.isFailure(assembled)) return yield* deliver(Exit.failCause(assembled.cause))
      const writes = assembled.value
      if (writes.length === 0) return yield* deliver(done)
      if (this.#readOnly) return yield* deliver(Exit.fail(ReadOnlySession.instance))

      job.storing = true
      let seq: Seq | undefined
      const stored = yield* Effect.exit(this.#storage.commit([writes], (_index, received) => void (seq = received)))
      // A commit Storage gave a receipt for is durable: it is published even when the call then fails.
      if (seq !== undefined) this.#publish({ seq, changes: writes as readonly CommitChange[] })
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
        const error = StorageError.because("Storage reported a commit stored without its receipt")
        this.#fail(error)
        return yield* deliver(Exit.fail(error))
      }
      return yield* deliver(done)
    })
  }

  #publish(publication: CommitPublication): void {
    for (const observer of [...this.#observers]) {
      if (!this.#observers.has(observer)) continue
      try {
        observer.advance(publication)
      } catch (error) {
        // A plain Session drops reports (spec 10.1); the observer is detached and told why.
        this.#observers.delete(observer)
        contain(() => observer.end({ kind: "listener_error", error }))
      }
    }
  }

  // Failure and close

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
    for (const listener of [...this.#closeListeners]) contain(listener)
    this.#closing = Effect.runFork(this.#closeSession())
  }

  #closeSession(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // Every job admitted before the seal runs; after a failure each gets SessionFailed.
      yield* Queue.end(this.#jobs)
      if (this.#line !== undefined) yield* Fiber.await(this.#line)
      const failure = this.#failure
      const end: CommitObserverEnd =
        failure === undefined ? { kind: "ended" } : { kind: "failed", error: failure.error }
      for (const observer of [...this.#observers]) contain(() => observer.end(end))
      this.#observers.clear()
      const closed = yield* Effect.exit(this.#storage.close())
      if (failure !== undefined)
        return yield* Deferred.succeed(this.#closedEnd, { kind: "failed", error: failure.error })
      if (Exit.isFailure(closed)) {
        const error = failureOf(closed)
        this.#failure = { error }
        this.#closeError = error
        return yield* Deferred.succeed(this.#closedEnd, { kind: "failed", error })
      }
      yield* Deferred.succeed(this.#closedEnd, { kind: "closed" })
    })
  }
}

/** Runs a callback that must not fail its caller. A plain Session drops what it throws (spec 10.1). */
function contain(callback: () => void): void {
  try {
    callback()
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
