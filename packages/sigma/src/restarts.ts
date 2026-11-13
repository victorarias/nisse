// The run restart counter (D12): a run during which the server stopped three times in a row ends with `restart_limit`
// instead of running again. That bounds a model that keeps issuing a call that kills the server, which the kernel's
// own count does not, since each restart there counts as progress.
import { type Harness, isRunTask, LiveDoc } from "@sigma/harness"
import { type ConversationId, defineDoc } from "@sigma/kernel"
import { Effect } from "effect"

/** Stops of the server during the conversation's run in flight, which `run` names. */
export const RestartsDoc = defineDoc<{ run: string; stops: number }>({
  kind: "sigma.restarts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ run: "", stops: 0 }),
  checkpointWhen: () => true,
})

/** Stops in a row during one run that end it. */
export const RESTART_LIMIT = 3

export const restartLimitMessage = (stops: number) => `the server stopped during this run ${stops} times in a row`

/**
 * At server start, before scheduling resumes: counts a stop for every run in flight, one commit each, and returns the
 * conversations whose run reached the limit, with its count. A run is named by its first input, which stays while it
 * runs, or by its task once it has none.
 */
export const countStops = (harness: Harness) =>
  Effect.gen(function* () {
    const { tasks } = yield* harness.inspect
    const conversations = new Set(
      tasks.filter((task) => isRunTask(harness.runTasks, task.record.kind)).map((task) => task.record.conversationId),
    )
    const limited = new Map<ConversationId, number>()
    for (const id of conversations) {
      yield* harness.session.commit((tx) =>
        Effect.gen(function* () {
          const run = (yield* tx.doc(LiveDoc, id)).run
          if (run === undefined) return
          const key = run.inputs[0] === undefined ? `task ${run.taskId}` : `submission ${run.inputs[0]}`
          const counted = yield* tx.doc(RestartsDoc, id)
          if (counted.run !== key) {
            counted.run = key
            counted.stops = 0
          }
          counted.stops += 1
          if (counted.stops >= RESTART_LIMIT) limited.set(id, counted.stops)
        }),
      )
    }
    return limited
  })
