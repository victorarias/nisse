// A process that runs one task until its second phase, then waits there for the test to kill it. The test resumes
// the task in its own process from the same database. Usage: bun crash-task.ts <database path>
import { Effect } from "effect"
import { defineTask, openSession, openSqliteStorage, openTaskScheduler } from "../../src/index.ts"

export type StepperResult = { readonly firstRuns: number; readonly restarts: number | undefined }

/**
 * Two phases: `first` moves to `second`, counting its runs in the checkpoint; `second` runs the caller's `second` with
 * the task's id and restart count, and completes once it returns.
 */
export const stepper = (second: (id: number, restarts: number | undefined) => Effect.Effect<void>) => {
  let firstRuns = 0
  return defineTask<null, { phase: "first" } | { phase: "second"; firstRuns: number }, StepperResult>({
    name: "test.stepper",
    version: 1,
    initial: () => ({ phase: "first" }),
    phases: {
      first: (_task, runtime) =>
        runtime.commit(() =>
          Effect.succeed({
            status: "running" as const,
            checkpoint: { phase: "second" as const, firstRuns: ++firstRuns },
          }),
        ),
      second: (task, runtime) =>
        Effect.gen(function* () {
          yield* second(task.id, task.restarts)
          const result = { firstRuns: task.state.checkpoint.firstRuns, restarts: task.restarts }
          yield* runtime.commit(() =>
            Effect.succeed({ status: "terminal" as const, outcome: { status: "completed" as const, result } }),
          )
        }),
    },
    abort: () => Effect.void,
  })
}

if (import.meta.main) {
  const path = process.argv[2]!
  const task = stepper((id) =>
    Effect.andThen(
      Effect.sync(() => process.stdout.write(`second ${id}\n`)),
      Effect.never,
    ),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openSession(yield* openSqliteStorage(path))
        const scheduler = yield* openTaskScheduler({ session, registry: { snapshot: () => ({ task: () => task }) } })
        yield* scheduler.resume
        yield* session.commit((tx) =>
          Effect.gen(function* () {
            const conversation = yield* tx.createConversation({ ownership: { kind: "ownerless" } })
            return yield* tx.createTask(task, null, {
              ownership: { kind: "conversation" },
              conversationId: conversation.id,
            })
          }),
        )
        yield* Effect.never
      }),
    ),
  )
}
