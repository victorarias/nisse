// Sign-ins as every connection to a kernel server sees them: each provider's last sign-in state, committed to the
// `nisse.sign_ins` document before anyone sees it. A sign-in runs in the server process, so one a server left
// unfinished cannot go on; the next server records it failed.
import type { Harness } from "@nisse/harness"
import { defineDoc, type JsonObject } from "@nisse/kernel"
import { authEnded, type AuthState } from "@nisse/protocol"
import { Effect, Stream } from "effect"
import type { SignInLog } from "./setup.ts"

// Stored as JSON: an AuthState, as `stored` reads it back.
export const SignInsDoc = defineDoc<{ states: { [provider: string]: JsonObject } }>({
  kind: "nisse.sign_ins",
  version: 1,
  scope: "session",
  initial: () => ({ states: {} }),
  checkpointWhen: () => true,
})

const STOPPED = "the server stopped before this sign-in finished"

const stored = (states: { readonly [provider: string]: JsonObject }) =>
  Object.values(states) as unknown as ReadonlyArray<AuthState>

/** Opens the home's sign-in log, ending the sign-ins a previous server left unfinished. */
export const committedSignIns = (harness: Harness): Effect.Effect<SignInLog> =>
  Effect.gen(function* () {
    const { session } = harness
    yield* Effect.orDie(
      session.commit((tx) =>
        Effect.map(tx.doc(SignInsDoc), (doc) => {
          for (const state of stored(doc.states)) {
            if (!authEnded(state.phase))
              doc.states[state.provider] = {
                provider: state.provider,
                flow: state.flow,
                phase: "failed",
                message: STOPPED,
              }
          }
        }),
      ),
    )
    return {
      record: (state) =>
        Effect.orDie(
          session.commit((tx) =>
            Effect.map(tx.doc(SignInsDoc), (doc) => {
              doc.states[state.provider] = structuredClone(state) as unknown as JsonObject
            }),
          ),
        ),
      // A watcher that falls behind sees each provider's latest state, not every one it passed through.
      watch: Stream.unwrap(
        Effect.gen(function* () {
          const watch = yield* Effect.orDie(session.watchDoc(SignInsDoc))
          if (watch === undefined) return Stream.die(new Error("nisse.sign_ins is created when the server opens"))
          let seen = new Map(stored(watch.value.states).map((state) => [state.provider, JSON.stringify(state)]))
          const changed = (states: { readonly [provider: string]: JsonObject }) => {
            const now = new Map(stored(states).map((state) => [state.provider, JSON.stringify(state)]))
            const fresh = stored(states).filter((state) => now.get(state.provider) !== seen.get(state.provider))
            seen = now
            return fresh
          }
          return Stream.concat(
            Stream.fromIterable(stored(watch.value.states)),
            watch.changes.pipe(
              Stream.orDie,
              Stream.flatMap((change) => Stream.fromIterable(changed(change.value.states))),
            ),
          )
        }),
      ),
    }
  })
