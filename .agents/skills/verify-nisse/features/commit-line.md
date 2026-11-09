# Commit line and session

Every change to a conversation goes through one ordered, atomic store commit, and a session that cannot store fails once and loudly.

## Sub-features

- `commit-atomic` [kernel, pending kernel-documents] One mutation line, each commit atomic with a `seq` (§1, §4): Every client sees the same ordered history
- `commit-published-after-store` [kernel, pending harness-run-core] Published only after stored (§1): A client never sees something a crash can erase
- `commit-tx-api` [kernel, pending kernel-session] Multi-record commit open to extensions: the `Tx` API (R816, §4): An extension writes an entry and a document as one atomic change
- `commit-tx-read` [kernel, pending kernel-session] Reads inside a transaction, `Tx.submission(id)` (Unreleased): A tool finds the entries of its run's inputs without scanning
- `entry-immutable` [kernel, pending kernel-session] Immutable entries (§2): History can be trusted and replayed
- `entry-custom` [kernel, pending kernel-session] Custom entry kinds with `defineEntry` (§8.1, R816): An extension stores its own record type in the transcript
- `conversation-root` [kernel, pending harness-run-core] Reserved `root` conversation (§2.2): A single-conversation app needs no id handling
- `conversation-created-hook` [kernel, pending harness-run-core] `conversationCreated` hook (R816-853): An extension sets up state in the same commit that creates a conversation
- `session-init` [kernel, pending kernel-session] Session `init` on first open (§2.2): The host seeds state once, atomically
- `commit-read-after-write` [kernel, pending kernel-session] Read-after-write rule while commits are in flight (§4): Reads never see half-stored data
- `session-failed` [kernel, pending harness-run-core] Session failure on storage error: `SessionFailed`, `closed` promise (§10.1, R923-939): The host learns once that the session is dead, and nothing keeps running on bad state
- `error-model` [kernel, pending harness-run-core] Three-rule error model (R923-939): An extension author knows which errors throw, which become records, and which go to reports
- `session-resume-explicit` [kernel, pending harness-run-core] `resume()` as an explicit start of scheduling (R115-138): The host installs extensions before any work restarts
- `session-read-only` [kernel, pending harness-run-core] Read-only open (R115-138, §2.2): Look at a session without running or changing anything
- `serve-read-only` [pending surface-conversations] The client path for Read-only open (R115-138, §2.2): Look at a session without running or changing anything
- `session-clock` [kernel, pending kernel-session] Injected clock, `now` and `setTimer` (R140-212): Tests and hosts control durable time
- `provider-session-id` [kernel, pending harness-run-core] Provider session id, stable per conversation (R115-138): Provider prompt caches keep hitting across requests
- `session-clean-close` [kernel, pending harness-run-core] Explicit `Harness` close without counting a crash (§5.4): A clean shutdown leaves runs resumable without using up their restarts
- `session-types` [kernel, pending harness-shell] The public types accept a run, a task and a document as written in the spec.
- `conversation-abort` [kernel, pending harness-run-core] `Conversation.abort()` withdraws queued inputs, keeps queued writes, aborts the current work and resolves once the conversation is idle.
- `context-cancels-wait-only` [kernel, pending harness-run-core] Cancelling a call's context stops only that wait, never the work.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `serve-read-only` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area A: spec §1, §2, §2.2, §4, §10.1; README Persist and Resume, Errors; examples 00-conversation, 12-recovery, 35-durable-on-the-store.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
