// Submissions (spec 6): admission in one commit, waits for settlement, and withdrawal. From pi-durable's
// `src/harness/submissions.ts` at 7d073328e (MIT, see LICENSE).
import { copyJson } from "@nisse/delta/json"
import {
  type CommitError,
  type CommitPublication,
  type ConversationId,
  type DocError,
  type JsonObject,
  ReadAfterWrite,
  type ReadError,
  type ReadFailure,
  type Session,
  SessionClosed,
  SessionFailed,
  type StorageError,
  type SubmissionId,
  type SubmissionRecord,
  type Tx,
} from "@nisse/kernel"
import { Data, Effect, Exit, Queue } from "effect"
import { startRun } from "./generation.ts"
import {
  appendInput,
  applyBoundary,
  hasQueuedReset,
  InboxDoc,
  type InboxItem,
  isDisplayOnly,
  isStale,
  pickInputEntry,
  prepareBoundary,
  type QueueModes,
  removeInboxItem,
} from "./inbox.ts"
import { LiveDoc, type Stored } from "./live.ts"
import type { InputEntry, SettledSubmissionRecord, SubmissionDraft } from "./types.ts"

/** A submission reached a busy conversation and was not admitted. */
export class ConversationBusy extends Data.TaggedError("ConversationBusy")<{
  readonly message: string
  readonly conversationId: ConversationId
}> {
  static of(conversationId: ConversationId): ConversationBusy {
    return new ConversationBusy({ message: `Conversation ${conversationId} is busy`, conversationId })
  }
}

/** An input with `whenIdle: "reject"` reached an idle conversation and was not admitted. */
export class ConversationIdle extends Data.TaggedError("ConversationIdle")<{
  readonly message: string
  readonly conversationId: ConversationId
}> {
  static of(conversationId: ConversationId): ConversationIdle {
    return new ConversationIdle({ message: `Conversation ${conversationId} is idle`, conversationId })
  }
}

/** Why an admission refused its submission. */
export type AdmissionError = ConversationBusy | ConversationIdle

export type AbortResult = "aborted" | "already_placed" | "settled"
type Admission = { readonly id: SubmissionId; readonly status: "queued" | "placed" | "done" }
type Waiter = Queue.Queue<Exit.Exit<SettledSubmissionRecord, SessionFailed | SessionClosed>>

/** A durably admitted submission. */
export interface Submission {
  readonly id: SubmissionId
  readonly status: Effect.Effect<SubmissionRecord, ReadFailure>
  /** Succeeds once the submission settles; interrupting the wait leaves the submission as it is. */
  readonly wait: Effect.Effect<SettledSubmissionRecord, ReadFailure>
  /** Withdraws it while queued; a placed input is not withdrawn, `Conversation.abort` stops its run. */
  readonly abort: Effect.Effect<AbortResult, ReadFailure | CommitError>
}

/** Admission, waits and withdrawal of the durable submissions of one Harness. */
export class Submissions {
  readonly #session: Session
  readonly #now: () => number
  /** Read at each admission, on the Session line. */
  readonly #queueModes: () => QueueModes
  /** Enables task scheduling; submitting or waiting asks for progress. */
  readonly #resume: Effect.Effect<void, unknown>
  readonly #waiters = new Map<SubmissionId, Set<Waiter>>()
  #closed = false

  constructor(session: Session, now: () => number, queueModes: () => QueueModes, resume: Effect.Effect<void, unknown>) {
    this.#session = session
    this.#now = now
    this.#queueModes = queueModes
    this.#resume = resume
    session.observeCommits({ advance: (publication) => this.#observe(publication), end: () => {} })
    session.subscribeClose(() => {
      this.#closed = true
      const closed = this.#closedExit()
      for (const waiters of this.#waiters.values()) for (const waiter of waiters) Queue.offerUnsafe(waiter, closed)
      this.#waiters.clear()
    })
  }

  /** Admits a submission in its own commit; see `admitSubmission`. */
  submit(conversationId: ConversationId, draft: SubmissionDraft): Effect.Effect<Submission, AdmissionError | CommitError> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.ignore(this.#resume)
      const { id } = yield* this.#session.commit((tx) =>
        admitSubmission(tx, conversationId, draft, this.#now(), this.#queueModes()),
      )
      return this.handle(id)
    })
  }

  /**
   * Admits a submission inside the caller's commit `tx`, with the rules of `submit`. The admission is stored or lost
   * with that commit. It must come before the commit's first table write, another admission's included.
   */
  admit(
    tx: Tx,
    conversationId: ConversationId,
    draft: SubmissionDraft,
  ): Effect.Effect<SubmissionId, AdmissionError | ReadError | DocError> {
    return Effect.gen({ self: this }, function* () {
      // Enforced on every path: admission reads tables only on some (request IDs, an idle boundary).
      if (tx.hasTableWrite) return yield* Effect.die(new ReadAfterWrite("submit(tx, draft)"))
      yield* Effect.ignore(this.#resume)
      const admission = yield* admitSubmission(tx, conversationId, draft, this.#now(), this.#queueModes())
      return admission.id
    })
  }

  /** The handle of submission `id`; it need not exist. */
  handle(id: SubmissionId): Submission {
    return {
      id,
      status: this.status(id),
      wait: this.wait(id),
      abort: Effect.flatMap(this.abort(id), (result) =>
        result === "not_found" ? Effect.die(new Error(`Submission ${id} does not exist`)) : Effect.succeed(result),
      ),
    }
  }

  /** The handle of an existing submission, or `undefined`. */
  get(id: SubmissionId): Effect.Effect<Submission | undefined, ReadFailure> {
    return Effect.map(this.#session.read((storage) => storage.submission(id)), (record) =>
      record === undefined ? undefined : this.handle(record.id),
    )
  }

  status(id: SubmissionId): Effect.Effect<SubmissionRecord, ReadFailure> {
    return Effect.flatMap(this.#session.read((storage) => storage.submission(id)), (record) =>
      record === undefined ? Effect.die(new Error(`Submission ${id} does not exist`)) : Effect.succeed(record),
    )
  }

  wait(id: SubmissionId): Effect.Effect<SettledSubmissionRecord, ReadFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.ignore(this.#resume)
      const waiter: Waiter = yield* Queue.bounded<Exit.Exit<SettledSubmissionRecord, SessionFailed | SessionClosed>>(1)
      let interrupted = false
      // Checked and registered on the line, so no settling publication falls between them.
      const exit = yield* this.#session
        .read((storage) =>
          Effect.gen({ self: this }, function* () {
            const record = yield* storage.submission(id)
            if (record === undefined) return yield* Effect.die(new Error(`Submission ${id} does not exist`))
            if (isSettled(record)) return Exit.succeed(record)
            // Close offers to registered waiters synchronously and may begin during the read.
            if (this.#closed) return this.#closedExit()
            if (!interrupted) {
              const set = this.#waiters.get(id) ?? new Set()
              this.#waiters.set(id, set.add(waiter))
            }
            return undefined
          }),
        )
        .pipe(
          Effect.flatMap((settled) => (settled === undefined ? Queue.take(waiter) : Effect.succeed(settled))),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
              const set = this.#waiters.get(id)
              set?.delete(waiter)
              if (set?.size === 0) this.#waiters.delete(id)
            }),
          ),
        )
      return yield* exit
    })
  }

  /** Withdraws a queued submission and removes its inbox item; placed inputs and settled submissions are reported. */
  abort(
    id: SubmissionId,
    conversationId?: ConversationId,
  ): Effect.Effect<AbortResult | "not_found", ReadFailure | CommitError> {
    return this.#session.commit((tx) =>
      Effect.gen(function* () {
        const record = yield* tx.submission(id)
        if (record === undefined || (conversationId !== undefined && record.conversationId !== conversationId)) {
          return "not_found" as const
        }
        if (record.status === "queued") {
          yield* tx.settleSubmission(id, { status: "unanswered", reason: "aborted" })
          yield* removeInboxItem(tx, record.conversationId, id)
          return "aborted" as const
        }
        return record.status === "placed" ? ("already_placed" as const) : ("settled" as const)
      }),
    )
  }

  #closedExit(): Exit.Exit<never, SessionFailed | SessionClosed> {
    const failure = this.#session.failure
    return Exit.fail(failure === undefined ? SessionClosed.instance : SessionFailed.of(failure.error))
  }

  /** On the line: offers each settlement to its waiters, which resume after every observer saw the commit. */
  #observe(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type !== "submission" || !isSettled(change.value)) continue
      const waiters = this.#waiters.get(change.value.id)
      if (waiters === undefined) continue
      this.#waiters.delete(change.value.id)
      const settled = Exit.succeed(change.value)
      for (const waiter of waiters) Queue.offerUnsafe(waiter, settled)
    }
  }
}

function isSettled(record: SubmissionRecord): record is SettledSubmissionRecord {
  return record.status === "done" || record.status === "unanswered"
}

/** Rejects an input entry an untyped caller got wrong: its kind must be a non-empty string outside the `pi.` prefix. */
function checkInputEntry(entry: InputEntry): Effect.Effect<void> {
  const { kind } = entry
  if (typeof kind === "string" && kind.length > 0 && !kind.startsWith("pi.")) return Effect.void
  return Effect.die(
    new TypeError(`An input entry's kind must be a non-empty string not starting with "pi.", got ${String(kind)}`),
  )
}

/**
 * Admits a submission inside a commit (spec 6). A known request ID returns its existing submission without writing. A
 * display-only write (only `kind` and `data`) is appended and settled `done` at once, busy or not; only behind a queued
 * reset it queues, so it lands after the reset. A busy conversation queues anything else in `pi.inbox`, or rejects
 * `whenBusy: "reject"` input and any continue with `ConversationBusy`; an idle one rejects `whenIdle: "reject"` input
 * with `ConversationIdle`. An idle continue places queued items and starts a run with them and itself. An idle
 * conversation with queued items queues the submission behind them and runs a final boundary. Otherwise idle input
 * places its entry and starts a run, and an idle write appends its entry and settles `done`, or `stale` when its head
 * reaches before the active range.
 */
export const admitSubmission = (
  tx: Tx,
  conversationId: ConversationId,
  draft: SubmissionDraft,
  now: number,
  queueModes: QueueModes,
): Effect.Effect<Admission, AdmissionError | ReadError | DocError | StorageError> =>
  Effect.gen(function* () {
    if (draft.type === "input" && draft.entry !== undefined) yield* checkInputEntry(draft.entry)
    if (draft.requestId !== undefined) {
      const existing = yield* tx.submissionByRequest(conversationId, draft.requestId)
      if (existing !== undefined) {
        if (existing.type !== draft.type) {
          return yield* Effect.die(
            new Error(`Request ${draft.requestId} already identifies a submission of type ${existing.type}`),
          )
        }
        return { id: existing.id, status: existing.status === "unanswered" ? "done" : existing.status } as Admission
      }
    }
    const fields = { conversationId, ...(draft.requestId === undefined ? {} : { requestId: draft.requestId }) }
    if (
      draft.type === "write" &&
      isDisplayOnly(draft.entry) &&
      !hasQueuedReset((yield* tx.doc(InboxDoc, conversationId)).items as InboxItem[])
    ) {
      const entry = yield* tx.appendEntry(conversationId, draft.entry)
      const write = yield* tx.createSubmission({ ...fields, type: "write", status: "done", entry: entry.id })
      return { id: write.id, status: "done" } as Admission
    }
    const live = yield* tx.doc(LiveDoc, conversationId)
    const busy = live.run !== undefined
    if (busy && draft.type === "input" && draft.whenBusy === "reject") {
      return yield* Effect.fail(ConversationBusy.of(conversationId))
    }
    if (!busy && draft.type === "input" && draft.whenIdle === "reject") {
      return yield* Effect.fail(ConversationIdle.of(conversationId))
    }
    if (draft.type === "continue") {
      // Never queued: whether a run can continue depends on how the current one ends. Rejected before any write.
      if (busy) return yield* Effect.fail(ConversationBusy.of(conversationId))
      const boundary = yield* prepareBoundary(tx, conversationId, queueModes)
      const { id } = yield* tx.createSubmission({ ...fields, type: "continue", status: "placed" })
      // Items an earlier failed run left queued are placed first and join the run. Its history starts with the failed
      // run's, so `afterRun` hooks see what that run did.
      const { users, first } = yield* applyBoundary(tx, boundary, "final", now)
      yield* startRun(tx, conversationId, live, { inputs: [...users, id], first: live.runFailure?.first ?? first })
      return { id, status: "placed" } as Admission
    }
    // A boundary reads the table, so it is prepared before the first table write; a busy one needs none.
    const boundary = busy ? undefined : yield* prepareBoundary(tx, conversationId, queueModes)
    if (boundary === undefined || boundary.inbox.items.length > 0) {
      const { id } = yield* tx.createSubmission({ ...fields, type: draft.type, status: "queued" })
      // Hosts may leave optional fields `undefined`; drafts take strict JSON.
      const value = copyJson(draft.type === "write" ? draft.entry : draft.content, { omitUndefinedProperties: true })
      const items = (boundary?.inbox ?? (yield* tx.doc(InboxDoc, conversationId))).items
      if (draft.type === "write") items.push({ id, mode: "write", entry: value as JsonObject })
      else {
        const mode = draft.whenBusy === "steer" ? "steer" : "followUp"
        const content = value as Stored<Extract<InboxItem, { mode: "steer" }>["content"]>
        const entry = draft.entry === undefined ? {} : { entry: pickInputEntry(draft.entry) }
        items.push({ id, mode, content, ...entry })
      }
      if (boundary === undefined) return { id, status: "queued" } as Admission
      const { users, first } = yield* applyBoundary(tx, boundary, "final", now)
      if (users.length > 0) yield* startRun(tx, conversationId, live, { inputs: users, first })
      return {
        id,
        status: draft.type === "write" ? "done" : users.at(-1) === id ? "placed" : "queued",
      } as Admission
    }
    if (draft.type === "write") {
      if (isStale(boundary, draft.entry)) {
        const stale = yield* tx.createSubmission({ ...fields, type: "write", status: "unanswered", reason: "stale" })
        return { id: stale.id, status: "done" } as Admission
      }
      const entry = yield* tx.appendEntry(conversationId, draft.entry)
      const write = yield* tx.createSubmission({ ...fields, type: "write", status: "done", entry: entry.id })
      return { id: write.id, status: "done" } as Admission
    }
    const entry = yield* appendInput(tx, conversationId, draft.content, draft.entry, now)
    const { id } = yield* tx.createSubmission({ ...fields, type: "input", status: "placed", entry: entry.id })
    yield* startRun(tx, conversationId, live, { inputs: [id], first: entry.id })
    return { id, status: "placed" } as Admission
  })
