// The `sigma.run_end` entry (D15): written in the commit that ends a run, whatever ended it, so a client reads how
// every run ended from the transcript alone. It names the answer's entry rather than copying its text: the commit has
// written before the run ends, and a commit reads tables only before its first write. The same commit applies a model
// a person switched to while the run worked, so a run keeps the model it started on.
import {
  type AgentState,
  configure,
  type ModelRef,
  type EndedRun,
  LiveDoc,
  type RunFailureReason,
} from "@sigma/harness"
import {
  type ConversationDocToken,
  type ConversationId,
  defineDoc,
  type DocError,
  type EntryId,
  type JsonObject,
  type Tx,
} from "@sigma/kernel"
import { RUN_END_KIND, type Outcome, type RunEnd } from "@sigma/protocol"
import { Effect } from "effect"

const OUTCOMES: Record<RunFailureReason, Outcome> = {
  aborted: "interrupted",
  reset: "interrupted",
  // The host stopped while the model answered more often than the retries allow.
  interrupted: "restart_limit",
  restart_limit: "restart_limit",
  model_error: "failed",
  no_model: "failed",
  faulted: "failed",
  orphaned: "failed",
  nothing_to_answer: "failed",
  turn_limit: "failed",
}

const describe = (reason: RunFailureReason, detail: unknown): string => {
  const said = typeof detail === "string" && detail !== "" ? detail : undefined
  // The turn limit's detail is only its count, such as `1 turn`.
  if (reason === "turn_limit") return `reached the turn limit of ${said ?? "its turns"}`
  return said ?? reason.replaceAll("_", " ")
}

/** The conversation's newest `sigma.run_end`, so how its last run ended is read without scanning its transcript. */
export const LastRunEndDoc = defineDoc<{ end?: { id: EntryId; data: RunEnd } }>({
  kind: "sigma.last_run_end",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  // A fork's last run is the one that ended before its fork entry.
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
})

/** A model and effort a person switched to; `null` effort clears it. */
export type ModelSwitch = { model: ModelRef; thinkingLevel: NonNullable<AgentState["thinkingLevel"]> | null }

/** A model switch made while a run worked, applied when that run ends. */
const PendingModelDoc = defineDoc<{ change?: ModelSwitch }>({
  kind: "sigma.pending_model",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => true,
})

// A document access refuses a request only when this code got it wrong.
const orBug = <A>(effect: Effect.Effect<A, DocError>) => Effect.catchTag(effect, "StorageRequestError", Effect.die)
const doc = <T extends JsonObject>(tx: Tx, token: ConversationDocToken<T>, id: ConversationId) =>
  orBug(tx.doc(token, id))

/** Switches the conversation's model now, or when its run ends if one works. */
export const switchModel = (tx: Tx, id: ConversationId, change: ModelSwitch) =>
  Effect.gen(function* () {
    const live = yield* doc(tx, LiveDoc, id)
    if (live.run === undefined) return yield* orBug(configure(tx, id, change))
    ;(yield* doc(tx, PendingModelDoc, id)).change = change
  })

/** Ends the conversation's run with `data`, in the commit that ends it. */
export const endRun = (tx: Tx, id: ConversationId, data: RunEnd) =>
  Effect.gen(function* () {
    const pending = yield* doc(tx, PendingModelDoc, id)
    if (pending.change !== undefined) {
      yield* orBug(configure(tx, id, pending.change))
      delete pending.change
    }
    const entry = yield* tx.appendEntry(id, { kind: RUN_END_KIND, data })
    ;(yield* doc(tx, LastRunEndDoc, id)).end = { id: entry.id, data }
  })

export const writeRunEnd = (tx: Tx, run: EndedRun) => {
  const { end } = run
  const data: RunEnd =
    end.status === "done"
      ? { outcome: "answered", answer: end.answer }
      : run.answered
        ? { outcome: "answered" }
        : { outcome: OUTCOMES[end.reason], message: describe(end.reason, end.detail) }
  return endRun(tx, run.conversationId, data)
}
