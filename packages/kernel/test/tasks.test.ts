// Tasks through the package's public API over real SQLite storage: a Session, a scheduler and task definitions. The
// upstream task tests run against the harness, so they wait for harness-shell; these prove the scheduler until then.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Deferred, Effect, Exit, Fiber, Queue, type Scope } from "effect"
import { TestClock } from "effect/testing"
import {
  type AnyTask,
  type ConversationId,
  defineTask,
  fromPromise,
  openSession,
  openSqliteStorage,
  openTaskScheduler,
  type Session,
  SessionClosed,
  StorageError,
  type Storage,
  type TaskId,
  type TaskRecord,
  type TaskRegistry,
  type TaskReport,
  type TaskScheduler,
  type TaskSchedulerOptions,
} from "../src/index.ts"
import { stepper } from "./support/crash-task.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const databasePath = (): string => {
  const home = mkdtempSync(join(tmpdir(), "nisse-tasks-"))
  homes.push(home)
  return join(home, "kernel.sqlite")
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> => Effect.runPromise(Effect.scoped(effect))

/** A registry the test changes: `set` and `remove` notify the scheduler like an extension loading or unloading. */
const registry = <Svc = never>(...tasks: AnyTask<Svc>[]) => {
  const byKind = new Map(tasks.map((task) => [task.definition.name, task]))
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }
  const value: TaskRegistry<Svc> & { set(task: AnyTask<Svc>): void; remove(kind: string): void } = {
    snapshot: () => {
      const frozen = new Map(byKind)
      return { task: (kind) => frozen.get(kind) }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (task) => {
      byKind.set(task.definition.name, task)
      changed()
    },
    remove: (kind) => {
      byKind.delete(kind)
      changed()
    },
  }
  return value
}

type Opened = {
  readonly session: Session
  readonly scheduler: TaskScheduler
  /** Every report, in order; a report can follow the commit it is about, so take from it to wait for one. */
  readonly reports: Queue.Queue<TaskReport>
}

/** Opens a Session over `storage` and its scheduler, and resumes scheduling. */
const open = <Svc = never>(
  storage: Storage,
  options: Omit<TaskSchedulerOptions<Svc>, "session" | "report">,
): Effect.Effect<Opened, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* openSession(storage)
    const reports = yield* Queue.unbounded<TaskReport>()
    const scheduler = yield* openTaskScheduler<Svc>({
      ...options,
      session,
      report: (_error, report) => Queue.offerUnsafe(reports, report),
    })
    yield* scheduler.resume
    return { session, scheduler, reports }
  })

const conversation = (session: Session): Effect.Effect<ConversationId, unknown> =>
  session.commit((tx) => Effect.map(tx.createConversation({ ownership: { kind: "ownerless" } }), (record) => record.id))

const start = <I>(session: Session, conversationId: ConversationId, task: AnyTask<never>, input: I) =>
  session.commit((tx) => tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId }))

/** Counts to `to`, one checkpoint per phase, and completes with the count. */
const counter = defineTask<{ to: number }, { phase: "count"; n: number }, number>({
  name: "test.counter",
  version: 1,
  initial: () => ({ phase: "count", n: 0 }),
  phases: {
    count: (task, runtime) =>
      runtime.commit(() =>
        Effect.succeed(
          task.state.checkpoint.n >= task.input.to
            ? {
                status: "terminal" as const,
                outcome: { status: "completed" as const, result: task.state.checkpoint.n },
              }
            : { status: "running" as const, checkpoint: { phase: "count" as const, n: task.state.checkpoint.n + 1 } },
        ),
      ),
  },
  abort: (_task, runtime) =>
    runtime.commit(() => Effect.succeed({ status: "terminal" as const, outcome: { status: "aborted" as const } })),
})

/** Never returns from its phase: only an abort or a close ends the invocation. */
const forever = defineTask<null, { phase: "wait" }, null>({
  name: "test.forever",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: { wait: () => Effect.never },
  abort: (_task, runtime) =>
    runtime.commit(() => Effect.succeed({ status: "terminal" as const, outcome: { status: "aborted" as const } })),
})

/** Sleeps `ms` from when it first runs, then completes with the time it woke. */
const napper = defineTask<{ ms: number }, { phase: "nap" } | { phase: "wake" }, number>({
  name: "test.napper",
  version: 1,
  initial: () => ({ phase: "nap" }),
  phases: {
    nap: (task, runtime) => runtime.sleepUntil(runtime.now() + task.input.ms, { phase: "wake" }),
    wake: (_task, runtime) =>
      runtime.commit(() =>
        Effect.succeed({
          status: "terminal" as const,
          outcome: { status: "completed" as const, result: runtime.now() },
        }),
      ),
  },
  abort: () => Effect.void,
})

/** Succeeds with the first committed task record that matches; attach it before the commit that may write it. */
const committedTask = (session: Session, matches: (record: TaskRecord) => boolean) => {
  const found = Deferred.makeUnsafe<TaskRecord>()
  const observation = session.observeCommits({
    advance: (publication) => {
      for (const change of publication.changes) {
        if (change.type === "task" && matches(change.value)) Deferred.doneUnsafe(found, Exit.succeed(change.value))
      }
    },
    end: () => {},
  })
  return Effect.ensuring(
    Deferred.await(found),
    Effect.sync(() => observation.detach()),
  )
}

describe("tasks", () => {
  test("task-terminal: a task runs phase by phase to its outcome, and waitForTask gets the stored receipt", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* openSqliteStorage(databasePath())
        const { session, scheduler } = yield* open(storage, { registry: registry(counter) })
        const conversationId = yield* conversation(session)
        const id = yield* start(session, conversationId, counter, { to: 3 })
        const settled = yield* scheduler.waitForTask(id)
        expect(settled.state.outcome).toEqual({ status: "completed", result: 3 })
        expect(yield* storage.task(id)).toEqual(settled)
      }),
    ))

  test("task-terminal: a phase that fails, throws, or returns without durable progress ends its task faulted and reported", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* openSqliteStorage(databasePath())
        const throws = defineTask<null, { phase: "go" }, null>({
          name: "test.throws",
          version: 1,
          initial: () => ({ phase: "go" }),
          phases: { go: () => Effect.fail(new Error("tool broke")) },
          abort: () => Effect.void,
        })
        const stalls = defineTask<null, { phase: "go" }, null>({
          name: "test.stalls",
          version: 1,
          initial: () => ({ phase: "go" }),
          phases: { go: () => Effect.void },
          abort: () => Effect.void,
        })
        // Extension code that throws before returning an Effect, as on bad input.
        const crashes = defineTask<null, { phase: "go" }, null>({
          name: "test.crashes",
          version: 1,
          initial: () => ({ phase: "go" }),
          phases: {
            go: () => {
              throw new TypeError("input.items is undefined")
            },
          },
          abort: () => Effect.void,
        })
        const { session, scheduler, reports } = yield* open(storage, { registry: registry(throws, stalls, crashes) })
        const conversationId = yield* conversation(session)
        const thrown = yield* scheduler.waitForTask(yield* start(session, conversationId, throws, null))
        const stalled = yield* scheduler.waitForTask(yield* start(session, conversationId, stalls, null))
        const crashed = yield* scheduler.waitForTask(yield* start(session, conversationId, crashes, null))
        expect(crashed.state.outcome).toEqual({ status: "faulted", error: { message: "input.items is undefined" } })
        expect(thrown.state.outcome).toEqual({ status: "faulted", error: { message: "tool broke" } })
        expect(stalled.state.outcome).toEqual({
          status: "faulted",
          error: { message: "Task test.stalls phase go returned without durable progress" },
        })
        const reported = [yield* Queue.take(reports), yield* Queue.take(reports), yield* Queue.take(reports)]
        expect(reported.map((report) => [report.kind, "task" in report ? report.task.id : undefined])).toEqual([
          ["task_faulted", thrown.id],
          ["task_faulted", stalled.id],
          ["task_faulted", crashed.id],
        ])
      }),
    ))

  test("task-wait-for: waitForTask answers a terminal task at once, and a wait still open when the Session closes fails with SessionClosed", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* openSqliteStorage(databasePath())
        const { session, scheduler } = yield* open(storage, { registry: registry(counter, forever) })
        const conversationId = yield* conversation(session)
        const done = yield* start(session, conversationId, counter, { to: 0 })
        yield* scheduler.waitForTask(done)
        expect((yield* scheduler.waitForTask(done)).state.outcome).toEqual({ status: "completed", result: 0 })

        const endless = yield* start(session, conversationId, forever, null)
        const waiting = yield* Effect.forkChild(scheduler.waitForTask(endless))
        yield* session.close
        const exit = yield* Fiber.await(waiting)
        expect(Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" && exit.cause.reasons[0].error).toEqual(
          SessionClosed.instance,
        )
      }),
    ))

  test("session-clock, task-lifecycle-times: a TestClock drives a durable sleep, and the receipt stores when the task started and ended", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* openSqliteStorage(databasePath())
        const { session, scheduler } = yield* open(storage, { registry: registry(napper) })
        const conversationId = yield* conversation(session)
        const startedAt = yield* Clock.currentTimeMillis
        const sleeping = committedTask(session, (record) => record.state.status === "sleeping")
        const id = yield* start(session, conversationId, napper, { ms: 3_600_000 })
        const waiting = yield* Effect.forkChild(scheduler.waitForTask(id))
        yield* sleeping
        expect(scheduler.wake().at).toBe(startedAt + 3_600_000)

        yield* TestClock.adjust("59 minutes")
        expect((yield* storage.task(id))?.state.status).toBe("sleeping")
        yield* TestClock.adjust("1 minute")
        const settled = yield* Fiber.join(waiting)
        expect(settled.state.outcome).toEqual({ status: "completed", result: startedAt + 3_600_000 })
        expect(settled.startedAt).toBe(startedAt)
        expect(settled.endedAt).toBe(startedAt + 3_600_000)
        expect(scheduler.wake().at).toBeUndefined()
      }).pipe(Effect.provide(TestClock.layer())),
    ))

  test("task-children-from-tools, task-id-order: a tool fans out child tasks whose ids increase, listed in id order, and the parent collects their outcomes", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* openSqliteStorage(databasePath())
        const listed: TaskId[][] = []
        const fanOut = defineTask<
          { sizes: number[] },
          | { phase: "spawn" }
          | { phase: "list"; children: TaskId<number>[] }
          | { phase: "collect"; children: TaskId<number>[] },
          number
        >({
          name: "test.fan-out",
          version: 1,
          initial: () => ({ phase: "spawn" }),
          phases: {
            spawn: (task, runtime) =>
              Effect.gen(function* () {
                // The tool is Promise code; its result decides the children.
                const sizes = yield* fromPromise(async () => task.input.sizes)
                yield* runtime.commit((tx) =>
                  Effect.gen(function* () {
                    const children: TaskId<number>[] = []
                    for (const to of sizes) {
                      children.push(
                        yield* tx.createTask(counter, { to }, { ownership: { kind: "task", taskId: task.id } }),
                      )
                    }
                    return { status: "running" as const, checkpoint: { phase: "list" as const, children } }
                  }),
                )
              }),
            list: (task, runtime) =>
              Effect.gen(function* () {
                listed.push((yield* runtime.ownedTasks()).map((record) => record.id))
                const children = task.state.checkpoint.children
                yield* runtime.commit(() =>
                  Effect.succeed({
                    status: "waiting" as const,
                    checkpoint: { phase: "collect" as const, children },
                    on: children,
                    policy: "allSettled" as const,
                  }),
                )
              }),
            collect: (task, runtime) =>
              Effect.gen(function* () {
                const outcomes = yield* runtime.outcomes(task.state.checkpoint.children)
                const sum = outcomes.reduce(
                  (total, outcome) => total + (outcome.status === "completed" ? outcome.result : 0),
                  0,
                )
                yield* runtime.commit(() =>
                  Effect.succeed({
                    status: "terminal" as const,
                    outcome: { status: "completed" as const, result: sum },
                  }),
                )
              }),
          },
          abort: () => Effect.void,
        })
        const { session, scheduler } = yield* open(storage, { registry: registry(counter, fanOut) })
        const conversationId = yield* conversation(session)
        const id = yield* start(session, conversationId, fanOut, { sizes: [3, 1, 2] })
        const settled = yield* scheduler.waitForTask(id)
        expect(settled.state.outcome).toEqual({ status: "completed", result: 6 })

        // Ids follow creation order, and a conversation's tasks list in that order, ended ones included.
        const all = (yield* storage.scanTasks({ conversationId }, 10, undefined)).items
        expect(all.map((task) => [task.kind, task.owner, task.state.status])).toEqual([
          ["test.fan-out", undefined, "terminal"],
          ["test.counter", id, "terminal"],
          ["test.counter", id, "terminal"],
          ["test.counter", id, "terminal"],
        ])
        const ids = all.slice(1).map((child) => child.id)
        expect(ids[0]!).toBeGreaterThan(id)
        expect(listed).toEqual([ids])
        const sizes = all.slice(1).map((child) => (child.input as { to: number }).to)
        expect(sizes).toEqual([3, 1, 2])
      }),
    ))

  test("task-extension-defined: a task whose definition is not registered waits blocked, and runs once an extension registers it", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* openSqliteStorage(databasePath())
        const tasks = registry()
        const { session, scheduler } = yield* open(storage, { registry: tasks })
        const conversationId = yield* conversation(session)
        const id = yield* start(session, conversationId, counter, { to: 2 })
        const record = (yield* storage.task(id))!
        expect(scheduler.blockedReason(record)).toBe("missing_task")
        const inspected = yield* scheduler.inspect
        expect(inspected.tasks.map((task) => [task.record.id, task.state])).toEqual([
          [id, { kind: "blocked", reason: "missing_task" }],
        ])

        tasks.set(counter)
        expect((yield* scheduler.waitForTask(id)).state.outcome).toEqual({ status: "completed", result: 2 })
      }),
    ))

  test("task-terminal: an abort joins the phase's Promise work before the abort handler starts, and close joins the abort handler's before storage closes", () =>
    run(
      Effect.gen(function* () {
        const log: string[] = []
        const path = databasePath()
        const inner = yield* openSqliteStorage(path)
        const storage = new Proxy(inner, {
          get(target, key) {
            if (key === "close")
              return () => Effect.tap(inner.close(), () => Effect.sync(() => log.push("storage closed")))
            const value = Reflect.get(target, key)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as Storage
        /**
         * Promise work, as a tool's: once its signal aborts it announces that and settles only when the test releases
         * it. Until then a correct kernel holds what comes next; a kernel that does not join Promise work runs ahead.
         */
        const tool = (name: string) => {
          const started = Deferred.makeUnsafe<void>()
          const aborted = Deferred.makeUnsafe<void>()
          let release = () => {}
          const work = fromPromise(
            (signal) =>
              new Promise<void>((resolve) => {
                release = () => {
                  log.push(`${name} settled`)
                  resolve()
                }
                signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Exit.void))
                Deferred.doneUnsafe(started, Exit.void)
              }),
          )
          return { work, started, aborted, release: () => release() }
        }
        const phaseTool = tool("phase tool")
        const abortTool = tool("abort tool")
        const working = defineTask<null, { phase: "work" }, null>({
          name: "test.working",
          version: 1,
          initial: () => ({ phase: "work" }),
          phases: {
            work: () =>
              Effect.gen(function* () {
                yield* Effect.yieldNow
                yield* phaseTool.work
              }),
          },
          abort: () =>
            Effect.gen(function* () {
              log.push("abort handler started")
              yield* abortTool.work
            }),
        })
        /** Gives a kernel that runs ahead every chance to: many turns of the event loop, each after the line's queue. */
        const letRunAhead = (session: Session | undefined) =>
          Effect.forEach(Array.from({ length: 50 }), () =>
            Effect.andThen(
              Effect.promise(() => new Promise((resolve) => setImmediate(resolve))),
              session === undefined ? Effect.void : session.read(() => Effect.void),
            ),
          )
        const { session, scheduler } = yield* open(storage, { registry: registry(working) })
        const conversationId = yield* conversation(session)
        const id = yield* start(session, conversationId, working, null)
        yield* Deferred.await(phaseTool.started)
        const aborting = yield* Effect.forkChild(scheduler.abortTask(id))
        yield* Deferred.await(phaseTool.aborted)
        yield* letRunAhead(session)
        log.push("test released the phase tool")
        phaseTool.release()
        yield* Deferred.await(abortTool.started)
        expect(yield* Fiber.join(aborting)).toBe("marked")

        const closing = yield* Effect.forkChild(session.close)
        yield* Deferred.await(abortTool.aborted)
        yield* letRunAhead(undefined)
        log.push("test released the abort tool")
        abortTool.release()
        yield* Fiber.join(closing)
        expect(log).toEqual([
          "test released the phase tool",
          "phase tool settled",
          "abort handler started",
          "test released the abort tool",
          "abort tool settled",
          "storage closed",
        ])

        // A close is not a crash: the task waits for its abort handler again, with no restart counted.
        const reopened = yield* openSqliteStorage(path)
        const stored = (yield* reopened.task(id))!
        expect([stored.state.status, stored.abortRequested, stored.restarts]).toEqual(["pending", true, undefined])
        yield* reopened.close()
      }),
    ))

  test("task-terminal: a task whose process is killed mid-phase resumes from its checkpoint in a new process, with the restart counted", async () => {
    const path = databasePath()
    // The PID is the one spawned here; nothing else is killed.
    const child = Bun.spawn(["bun", join(import.meta.dir, "support/crash-task.ts"), path], { stdout: "pipe" })
    const reader = child.stdout.getReader()
    let output = ""
    while (!output.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`crash-task exited before its second phase: ${output}`)
      output += new TextDecoder().decode(chunk.value)
    }
    child.kill("SIGKILL")
    expect(await child.exited).not.toBe(0)
    const id = Number(output.trim().split(" ")[1]) as TaskId

    await run(
      Effect.gen(function* () {
        let firstRuns = 0
        const resumed = stepper({ first: () => firstRuns++, second: () => Effect.void })
        const storage = yield* openSqliteStorage(path)
        expect((yield* storage.task(id))?.state).toEqual({
          status: "running",
          checkpoint: { phase: "second" },
        })
        const { scheduler } = yield* open(storage, { registry: registry(resumed) })
        const settled = yield* scheduler.waitForTask(id)
        // The new process started at `second`, with the crash counted.
        expect(firstRuns).toBe(0)
        expect(settled.state.outcome).toEqual({ status: "completed", result: { restarts: 1 } })
      }),
    )
  })

  test("session-failed: a close whose write-back of a stopped task fails reports the failure instead of a clean close", () =>
    run(
      Effect.gen(function* () {
        const inner = yield* openSqliteStorage(databasePath())
        let failCommits = false
        const storage = new Proxy(inner, {
          get(target, key) {
            if (key === "commit")
              return (...args: Parameters<Storage["commit"]>) =>
                failCommits ? Effect.fail(StorageError.because("disk full")) : inner.commit(...args)
            const value = Reflect.get(target, key)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as Storage
        const { session } = yield* open(storage, { registry: registry(forever) })
        const conversationId = yield* conversation(session)
        const running = committedTask(session, (record) => record.state.status === "running")
        yield* start(session, conversationId, forever, null)
        yield* running
        failCommits = true
        const closed = yield* Effect.exit(session.close)
        expect(
          Exit.isFailure(closed) && closed.cause.reasons[0]?._tag === "Fail" && closed.cause.reasons[0].error,
        ).toEqual(StorageError.because("disk full"))
        expect((yield* session.closed).kind).toBe("failed")
      }),
    ))

  test("task-terminal: a close while an aborted owner waits for its child's abort handler leaves both resumable, with no restart counted", () =>
    run(
      Effect.gen(function* () {
        const path = databasePath()
        const childAborting = Deferred.makeUnsafe<void>()
        const slowAbort = defineTask<null, { phase: "wait" }, null>({
          name: "test.slow-abort",
          version: 1,
          initial: () => ({ phase: "wait" }),
          phases: { wait: () => Effect.never },
          abort: () =>
            Effect.andThen(
              Effect.sync(() => Deferred.doneUnsafe(childAborting, Exit.void)),
              Effect.never,
            ),
        })
        const parent = defineTask<null, { phase: "spawn" } | { phase: "hold" }, null>({
          name: "test.parent",
          version: 1,
          initial: () => ({ phase: "spawn" }),
          phases: {
            spawn: (task, runtime) =>
              runtime.commit((tx) =>
                Effect.as(tx.createTask(slowAbort, null, { ownership: { kind: "task", taskId: task.id } }), {
                  status: "running" as const,
                  checkpoint: { phase: "hold" as const },
                }),
              ),
            hold: () => Effect.never,
          },
          abort: (_task, runtime) =>
            runtime.commit(() =>
              Effect.succeed({ status: "terminal" as const, outcome: { status: "aborted" as const } }),
            ),
        })
        const { session, scheduler } = yield* open(yield* openSqliteStorage(path), {
          registry: registry(parent, slowAbort),
        })
        const conversationId = yield* conversation(session)
        const holding = committedTask(session, (record) => record.kind === "test.slow-abort")
        const id = yield* start(session, conversationId, parent, null)
        const child = (yield* holding).id
        const aborting = yield* Effect.forkChild(scheduler.abortTask(id))
        yield* Deferred.await(childAborting)
        yield* session.close
        yield* Fiber.await(aborting)

        const reopened = yield* openSqliteStorage(path)
        for (const taskId of [id, child]) {
          const stored = (yield* reopened.task(taskId))!
          expect([stored.state.status, stored.abortRequested, stored.restarts]).toEqual(["pending", true, undefined])
        }
        yield* reopened.close()
      }),
    ))

  test("session-failed: a reservation whose commit fails fails the Session, and it still closes", () =>
    run(
      Effect.gen(function* () {
        const inner = yield* openSqliteStorage(databasePath())
        const storage = new Proxy(inner, {
          get(target, key) {
            if (key === "commit")
              return (...args: Parameters<Storage["commit"]>) =>
                args[0].some((batch) =>
                  batch.some((write) => write.type === "task" && write.value.state.status === "running"),
                )
                  ? Effect.fail(StorageError.because("disk full"))
                  : inner.commit(...args)
            const value = Reflect.get(target, key)
            return typeof value === "function" ? value.bind(target) : value
          },
        }) as Storage
        const { session } = yield* open(storage, { registry: registry(counter) })
        const conversationId = yield* conversation(session)
        yield* start(session, conversationId, counter, { to: 1 })
        expect(yield* session.closed).toEqual({ kind: "failed", error: StorageError.because("disk full") })
      }),
    ))
})
