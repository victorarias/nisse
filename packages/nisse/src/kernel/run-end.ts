// The `nisse.run_end` entry (D15): written in the commit that ends a run, whatever ended it, so a client reads how
// every run ended from the transcript alone. It names the answer's entry rather than copying its text: the commit has
// written before the run ends, and a commit reads tables only before its first write.
import type { EndedRun, RunFailureReason } from "@nisse/harness"
import { defineDoc, type EntryId, type Tx } from "@nisse/kernel"
import { RUN_END_KIND, type Outcome, type RunEnd } from "@nisse/wire"
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

const describe = (reason: RunFailureReason, detail: unknown): string =>
  typeof detail === "string" && detail !== "" ? detail : reason.replaceAll("_", " ")

/** The conversation's newest `nisse.run_end`, so how its last run ended is read without scanning its transcript. */
export const LastRunEndDoc = defineDoc<{ end?: { id: EntryId; data: RunEnd } }>({
  kind: "nisse.last_run_end",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  // A fork's last run is the one that ended before its fork entry.
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
})

export const writeRunEnd = (tx: Tx, run: EndedRun) =>
  Effect.gen(function* () {
    const { end } = run
    let data: RunEnd
    if (end.status === "done") {
      data = { outcome: "answered", answer: end.answer }
    } else if (run.answered) {
      data = { outcome: "answered" }
    } else {
      data = { outcome: OUTCOMES[end.reason], message: describe(end.reason, end.detail) }
    }
    // Read before the entry is written, while the commit may still read; a refusal is a bug here.
    const last = yield* Effect.catchTag(tx.doc(LastRunEndDoc, run.conversationId), "StorageRequestError", Effect.die)
    const entry = yield* tx.appendEntry(run.conversationId, { kind: RUN_END_KIND, data })
    last.end = { id: entry.id, data }
  })
