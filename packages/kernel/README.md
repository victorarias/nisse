# @nisse/kernel

Nisse's durable kernel, rewritten on Effect from pi-durable's specification. `docs/spec.md` is that specification
with nisse's amendments listed at its top; it is the behavioral contract.

So far the kernel holds storage, the session, documents and tasks:

- `src/records.ts`: the records storage keeps and the shapes of its reads and writes. Names, fields and JSON are
  pi-durable's, so a database and the upstream suite read the same.
- `src/storage.ts`: the `Storage` port (spec section 10), every method an Effect.
- `src/sqlite/`: the port over `bun:sqlite`. `database.ts` is the `SqliteDatabase` facade, chord's shape with Effect
  calls; the real one runs each call synchronously and holds other calls while a transaction is open, and a test
  double may suspend. `migrations.ts` holds the schema
  history. `storage.ts`, `commit.ts`, `statements.ts` and `rows.ts` implement the port.
- `src/session/`: the Session (spec sections 1, 4 and 10.1). `session.ts` runs the mutation line: one fiber takes
  commit jobs in order, sends each commit to Storage in one call, publishes it once stored, and hands the outcome back
  through a queue, so no waiting fiber resumes inside the line. `transaction.ts` is a commit's `Tx`: table reads before
  the first table write, then conversations, forks, entries, submissions and documents. `entry.ts` has entry drafts and
  `defineEntry`. `documents.ts` is the cache of loaded documents: one tracker per incarnation, kept while observed or
  until its retention passes. `watch.ts` turns a document observer into an Effect Stream that folds what waits for a
  slow consumer (spec 9.2). `Tx.createTask` stages a task; a commit that makes a task terminal retires its task
  documents. The Session's clock defaults to Effect's `Clock`, so a `TestClock` controls lifecycle times and sleeps.
- `src/documents/definition.ts`: `defineDoc` and `defineDocFamily`, addresses, and the scope and version checks
  (spec sections 3.1, 3.2 and 3.6).
- `src/tasks/`: tasks (spec section 5). `task.ts` has `defineTask`, the registry and the `TaskRuntime` a phase gets;
  phases and abort handlers are Effects whose services come from the scheduler's per-phase `services` Layer.
  `scheduler.ts` runs them over one Session: reservation, one invocation per task, the step before each phase, abort
  and its cascade, held outcomes, waits, durable sleeps on Effect's `Clock`, restart counting, and the close that
  joins every invocation before Storage closes. Every decision is one commit on the Session line, which awaits each
  storage call, so a decision reads exactly the committed state.
- `src/promise.ts`: `fromPromise`, for Promise work inside a phase. Interrupting it aborts the work's signal and waits
  for the Promise to settle, so an invocation ends only after its last handler did.

`src/sqlite/{rows,statements,commit,storage}.ts` are derived from pi-durable's `src/storage/sqlite/`,
`src/session/transaction.ts` from its `src/session/transaction.ts`, `src/documents/definition.ts` from its
`src/documents.ts`, and `src/tasks/scheduler.ts` from its `src/harness/scheduler.ts`, at commit `7d073328e` (earendil-works/pi), under the
MIT license in `LICENSE`.

## Tests

The conformance suite (`packages/conformance`) judges storage through its adapter: the `sqlite-*` files and the
storage conformance rows, and the session and documents through its Promise wrapper. `test/` holds package tests for
what that adapter cannot show, such as which Effect channel a failure takes, the Effect surface of documents and
watches, the commit latency and memory of a stalled watch, and tasks until the harness wraps the scheduler: phases
to their outcome, sleeps under a `TestClock`, an abort and a close joining Promise work, and a task resumed in a new
process after its first was killed.
