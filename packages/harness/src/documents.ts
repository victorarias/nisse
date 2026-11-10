// The provider-facing identity document the creation hook writes (spec 7.1). `pi.live`, `pi.inbox` and `pi.usage`
// live with the code that fills them: `live.ts`, `inbox.ts` and `usage.ts`.
import { type CommitError, defineDoc, type InvocationEnded, type ReadFailure, type TaskRuntime } from "@nisse/kernel"
import { Effect } from "effect"
import { uuidv7 } from "@nisse/models"

/** The provider-facing identity; every fork starts with a fresh one. */
export const ProviderDoc = defineDoc<{ sessionId: string }>({
  kind: "pi.provider",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ sessionId: uuidv7() }),
  checkpointWhen: () => true,
})

/** The provider-facing session ID of a task's conversation, created on first use. */
export const providerSessionId = <I, S, R>(
  runtime: TaskRuntime<I, S, R>,
): Effect.Effect<string, InvocationEnded | ReadFailure | CommitError> =>
  Effect.gen(function* () {
    const existing = yield* runtime.snapshot(ProviderDoc, runtime.conversationId)
    if (existing !== undefined) return existing.sessionId
    let created: string | undefined
    yield* runtime.commit((tx) =>
      Effect.map(tx.doc(ProviderDoc, runtime.conversationId), (doc) => {
        created = doc.sessionId
        return undefined
      }),
    )
    if (created === undefined) {
      return yield* Effect.die(new Error(`Conversation ${runtime.conversationId} has no provider session ID`))
    }
    return created
  })
