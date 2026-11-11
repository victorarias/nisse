// The `nisse.run_end` entry (D15): written in the commit that ends a run, whatever ended it, so a client reads how
// every run ended from the transcript alone. It names the answer's entry rather than copying its text: the commit has
// written before the run ends, and a commit reads tables only before its first write.
import type { EndedRun, RunFailureReason } from "@nisse/harness"
import type { Tx } from "@nisse/kernel"
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
    yield* tx.appendEntry(run.conversationId, { kind: RUN_END_KIND, data })
  })
