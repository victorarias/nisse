# @nisse/kernel

Nisse's durable kernel, rewritten on Effect from pi-durable's specification. `docs/spec.md` is that specification
with nisse's amendments listed at its top; it is the behavioral contract.

So far the kernel holds storage and the session:

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
  the first table write, then conversations, entries and submissions. `entry.ts` has entry drafts and `defineEntry`.
  Documents, forks and tasks join the transaction with the children that own them.

`src/sqlite/{rows,statements,commit,storage}.ts` are derived from pi-durable's `src/storage/sqlite/`, and
`src/session/transaction.ts` from its `src/session/transaction.ts`, at commit `7d073328e` (earendil-works/pi), under the
MIT license in `LICENSE`.

## Tests

The conformance suite (`packages/conformance`) judges storage through its adapter: the `sqlite-*` files and the
storage conformance rows. `test/` holds package tests for what that adapter cannot show, such as which Effect
channel a failure takes.
