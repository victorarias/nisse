// What the view mounts share: observers that run on the mutation line at a publication, and the end the Session's
// close gives them (spec 9.1). One that throws, or whose `advance` returns a promise that rejects, is detached and
// ended `listener_error`; the others still get their call.
import type { DocumentChange, DocumentObserver, DocumentObserverEnd, Session } from "@sigma/kernel"
import { SessionClosed, SessionFailed } from "@sigma/kernel"

/** One attached observer and what it ends with; `detach` removes it from its mount. */
export type Follower<T> = {
  readonly observer: DocumentObserver<T>
  readonly detach: () => void
}

/** Hands `change` to `follower`; a throw or rejection detaches it and ends it `listener_error`. */
export function advanceFollower<T>(follower: Follower<T>, change: DocumentChange<T>): void {
  try {
    const returned: unknown = follower.observer.advance(change)
    if (isPromiseLike(returned)) returned.then(undefined, (error: unknown) => fault(follower, error))
  } catch (error) {
    fault(follower, error)
  }
}

/** Ends `follower` once with `end`; nothing reaches it afterwards. */
export function endFollower<T>(follower: Follower<T>, end: DocumentObserverEnd): void {
  try {
    const returned: unknown = follower.observer.end(end)
    if (isPromiseLike(returned)) returned.then(undefined, () => {})
  } catch {
    // An observer's end that throws loses nothing: it is already detached.
  }
}

/**
 * `observer` behind a guard: once detached or ended, nothing reaches it, and the guard no longer references it or the
 * mount. `detach` runs once, at the first detach or end.
 */
export function guarded<T>(observer: DocumentObserver<T>, detach: () => void): Follower<T> {
  let attached: { readonly observer: DocumentObserver<T>; readonly detach: () => void } | undefined = {
    observer,
    detach,
  }
  const release = () => {
    const released = attached
    attached = undefined
    released?.detach()
    return released
  }
  return {
    observer: {
      advance: (change) => attached?.observer.advance(change),
      end: (end) => release()?.observer.end(end),
    },
    detach: () => void release(),
  }
}

/** How a close ends what follows the Session: `ended`, or `failed` with the Session's first error. */
export const closeEnd = (session: Session): DocumentObserverEnd => {
  const failure = session.failure
  return failure === undefined ? { kind: "ended" } : { kind: "failed", error: failure.error }
}

/** Why an attachment the close overtook fails. */
export const closedError = (session: Session): SessionClosed | SessionFailed => {
  const failure = session.failure
  return failure === undefined ? SessionClosed.instance : SessionFailed.of(failure.error)
}

/** The guard's end detaches it first, so a fault ends it once whatever it does. */
function fault<T>(follower: Follower<T>, error: unknown): void {
  endFollower(follower, { kind: "listener_error", error })
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"
