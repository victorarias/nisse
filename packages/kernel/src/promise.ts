// Promise work inside Effect code that the join rule covers (F6): an invocation ends only after its last handler
// returned, but interrupting a fiber does not wait for a Promise it awaits. Promise work in a task therefore goes through
// `fromPromise`, whose interruption aborts the work's signal and then waits for the Promise to settle.
import { Effect } from "effect"

/**
 * Runs Promise work as an Effect. A rejection fails it with the rejection. Interruption aborts `signal` and completes
 * only once the Promise has settled, so whatever interrupts the fiber, such as the end of a task invocation, also waits
 * for the work.
 */
export const fromPromise = <A>(evaluate: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, unknown> =>
  Effect.suspend(() => {
    const controller = new AbortController()
    let promise: PromiseLike<A>
    try {
      promise = evaluate(controller.signal)
    } catch (error) {
      return Effect.fail(error)
    }
    const settled = Effect.callback<void>((resume) => {
      promise.then(
        () => resume(Effect.void),
        () => resume(Effect.void),
      )
    })
    return Effect.callback<A, unknown>((resume) => {
      promise.then(
        (value) => resume(Effect.succeed(value)),
        (error: unknown) => resume(Effect.fail(error)),
      )
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.andThen(
          Effect.sync(() => controller.abort()),
          settled,
        ),
      ),
    )
  })
