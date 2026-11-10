// Document watches (spec section 9.2): a document observer whose changes wait, folded, until the consumer pulls.
//
// The observer runs on the mutation line, so it only records: it pushes each change's operations into one `PendingOps`
// queue and offers a token to a one-slot wake queue (F6: nothing is woken directly from the line). The stream takes
// everything pending as one call per pull. A consumer that keeps up gets each commit's own call; a slow one gets the
// newest value with the folded operations of every commit since its last call, or one root replacement past
// `MAX_PENDING_OPS`, so a stalled consumer neither delays a commit nor holds more than one value and a bounded queue.
import { type JsonValue, type Op, PendingOps } from "@nisse/delta"
import { Cause, Effect, Queue, type Scope, Stream } from "effect"
import { SessionFailed } from "../errors.ts"
import type {
  DocumentChange,
  DocumentObservation,
  DocumentObserver,
  DocumentObserverEnd,
  ReadFailure,
} from "./session.ts"

/**
 * A watch of one document address. `value` is the value at acquisition; `changes` delivers every later change, folded
 * while the consumer is busy. The stream ends when the Session closes or the watch's scope ends. It fails with
 * `SessionFailed` when the Session fails.
 * Pull it once: the watch has one consumer.
 */
export type DocumentWatch<T> = {
  readonly value: Readonly<T>
  readonly changes: Stream.Stream<DocumentChange<T>, SessionFailed>
}

/**
 * A watch over the observer `observe` attaches; `undefined` when it attaches nothing. The scope's end detaches it.
 */
export function makeWatch<T>(
  observe: (observer: DocumentObserver<T>) => Effect.Effect<DocumentObservation<T> | undefined, ReadFailure>,
): Effect.Effect<DocumentWatch<T> | undefined, ReadFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const wake = yield* Queue.dropping<void>(1)
    const pending = new PendingState<T>()
    const observation = yield* Effect.acquireRelease(
      observe({
        advance: (change) => {
          pending.push(change)
          Queue.offerUnsafe(wake, undefined)
        },
        end: (end) => {
          // An end comes at once: what is pending is dropped, and the watch keeps its last value. A task document's
          // end follows its retirement, which is delivered first.
          if (end.kind === "ended" && "retired" in end) pending.finishAfterPending(end)
          else pending.finish(end)
          Queue.offerUnsafe(wake, undefined)
        },
      }),
      // The scope's end detaches the observer, which then gets no end of its own: the stream completes here.
      (attached) =>
        Effect.sync(() => {
          pending.finish({ kind: "ended" })
          Queue.offerUnsafe(wake, undefined)
          attached?.detach()
        }),
    )
    if (observation === undefined) return undefined
    const next: Effect.Effect<DocumentChange<T>, SessionFailed | Cause.Done> = Effect.suspend(
      function loop(): Effect.Effect<DocumentChange<T>, SessionFailed | Cause.Done> {
        if (pending.end === undefined && !pending.has && pending.endAfterPending !== undefined) {
          pending.finish(pending.endAfterPending)
        }
        const end = pending.end
        if (end?.kind === "failed") return Effect.fail(SessionFailed.of(end.error))
        if (end !== undefined) return Cause.done()
        const call = pending.take()
        if (call !== undefined) return Effect.succeed(call)
        return Effect.flatMap(Queue.take(wake), () => Effect.suspend(loop))
      },
    )
    return { value: observation.value, changes: Stream.fromEffectRepeat(next) }
  })
}

/** What waits for the consumer: the folded operations, the newest value, and whether a retirement came between. */
class PendingState<T> {
  readonly #ops = new PendingOps()
  /** The only change pending, passed on as made: a consumer that keeps up pays for no folding. */
  #lone: DocumentChange<T> | undefined
  #newest: Readonly<T> | undefined
  #has = false
  #retired = false
  end: DocumentObserverEnd | undefined
  /** An end that applies once what is pending was taken: a task document's end after its retirement. */
  endAfterPending: DocumentObserverEnd | undefined

  get has(): boolean {
    return this.#has
  }

  finishAfterPending(end: DocumentObserverEnd): void {
    if (this.end === undefined) this.endAfterPending = end
  }

  finish(end: DocumentObserverEnd): void {
    this.end = end
    this.#ops.take()
    this.#lone = undefined
    this.#newest = undefined
    this.#has = false
  }

  push(change: DocumentChange<T>): void {
    if (this.end !== undefined) return
    this.#lone = this.#has ? undefined : change
    this.#ops.push(change.ops)
    this.#newest = change.value
    this.#has = true
    if (change.retired) this.#retired = true
  }

  take(): DocumentChange<T> | undefined {
    if (!this.#has) return undefined
    const lone = this.#lone
    const value = this.#newest!
    const batch = this.#ops.take()
    const retired = this.#retired
    this.#lone = undefined
    this.#newest = undefined
    this.#has = false
    this.#retired = false
    if (lone !== undefined) return lone
    const ops: readonly Op[] = batch.kind === "ops" ? batch.ops : [["r", value as JsonValue]]
    return { value, ops, retired }
  }
}
