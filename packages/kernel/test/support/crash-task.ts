// A process that runs one task until its second phase, then waits there for the test to kill it. The test resumes
// the task in its own process from the same database. Usage: bun crash-task.ts <database path>
import { Effect } from "effect"
import { defineTask, openSession, openSqliteStorage, openTaskScheduler } from "../../src/index.ts"

export type StepperHooks = {
  /** Called each time phase `first` runs in this process. */
  readonly first?: () => void
  /** Runs inside phase `second` with the task's id and restart count; the task completes once it returns. */
  readonly second: (id: number, restarts: number | undefined) => Effect.Effect<void>
}

/** Two phases: `first` moves to `second`; `second` completes with the restart count it saw. */
export const stepper = (hooks: StepperHooks) =>
  defineTask<null, { phase: "first" } | { phase: "second" }, { restarts: number | undefined }>({
    name: "test.stepper",
    version: 1,
    initial: () => ({ phase: "first" }),
    phases: {
      first: (_task, runtime) =>
        Effect.andThen(
          Effect.sync(() => hooks.first?.()),
          runtime.commit(() =>
            Effect.succeed({ status: "running" as const, checkpoint: { phase: "second" as const } }),
          ),
        ),
      second: (task, runtime) =>
        Effect.gen(function* () {
          yield* hooks.second(task.id, task.restarts)
          const result = { restarts: task.restarts }
          yield* runtime.commit(() =>
            Effect.succeed({ status: "terminal" as const, outcome: { status: "completed" as const, result } }),
          )
        }),
    },
    abort: () => Effect.void,
  })

if (import.meta.main) {
  const path = process.argv[2]!
  const task = stepper({
    second: (id) =>
      Effect.andThen(
        Effect.sync(() => process.stdout.write(`second ${id}\n`)),
        Effect.never,
      ),
  })
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
