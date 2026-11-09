# Documents

Typed JSON documents are committed with entries, scoped, forked, migrated and watched as small changes.

## Sub-features

- `doc-commit` [kernel, pending kernel-documents] Typed JSON documents committed with entries (§3): State that changes atomically with history
- `doc-session-scope` [kernel, pending kernel-documents] Session scope (§3): State shared across conversations
- `doc-conversation-scope` [kernel, pending kernel-documents] Conversation scope (§3): State per conversation
- `doc-task-scope` [kernel, pending harness-views] Task scope (§3): State that dies with the work
- `doc-families` [kernel, pending kernel-documents] Families of documents (§3): Many documents of one kind, listable
- `doc-history` [kernel, pending kernel-documents] History modes: latest, rewindable (§3): Forks and rewinds read old state
- `doc-snapshot-as-of` [kernel, pending kernel-documents] `snapshotAsOf` (§3): Read a document as of a seq
- `doc-checkpoint` [kernel, pending kernel-documents] `checkpointWhen` (§3): Bounds replay cost for rewindable documents
- `doc-lifetime` [kernel, pending kernel-documents] Lifetimes and `retire` (§3): Old state is removed predictably
- `doc-migration` [kernel, pending kernel-documents] Document migrations (§3.6): Old data opens on new versions
- `doc-eviction` [kernel, pending harness-run-core] Document eviction, `documentRetentionMs` (§4): Memory stays bounded with many documents
- `doc-ops` [kernel, pending kernel-documents] Chord ops: structured changes to JSON (§3, Chord): Small changes stay small, in storage and on the wire
- `doc-deltas` [kernel, pending kernel-documents] Document deltas to watchers (§9.1): A client updates a big document cheaply
- `doc-provider` [kernel, pending kernel-documents] Built-in `pi.provider` (§2.2): Provider session survives forks and switches
- `doc-definitions` [kernel, pending harness-shell] A document definition declares its version, scope and history, and bad definitions fail at definition time.
- `doc-tables` [kernel, pending harness-shell] A transaction reads and writes keyed tables as part of the same commit.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area T: spec §2.2, §3, §4, §9.1; README Your Own State; examples 01-documents, 10-extension-state.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
