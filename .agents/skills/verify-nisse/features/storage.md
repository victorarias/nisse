# Storage

Durable state lives behind a storage contract with a SQLite backend, bounded reads and ids that always increase.

## Sub-features

- `storage-sqlite` [kernel] SQLite backend (§11): Durable local storage
- `storage-port` [kernel] Storage interface, custom backend (R863-921, §10): Plug another store in
- `storage-test-double` [kernel, pending kernel-session] Memory backend (R863-921): Fast tests
- `storage-cursors` [kernel] Cursors and scans in the contract (§10): Big reads stay bounded
- `storage-id-minting` [kernel] Id minting that always increases, also across reopen (§10, 1.5.0): Ids sort by creation
- `storage-conformance` [kernel] Storage conformance suite (`testing/storage-conformance`, 2,099 lines): Any backend can be proven against the contract
- `storage-fork-copy-sources` [kernel] Copy sources for forks (§10): A fork doesn't copy every row
- `storage-commit-writes` [kernel] `commitWrites` test helper (`testing`): Tests seed state
- `storage-sqlite-commit` [kernel] A batch commit is one transaction, matching the memory reference statement for statement.
- `storage-sqlite-migrations` [kernel] The SQLite schema migrates forward on open.
- `storage-sqlite-facade` [kernel] The SQLite facade settles every call the same way on each runtime.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area W: spec §10, §11; README Storage; example 35-durable-on-the-store.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
