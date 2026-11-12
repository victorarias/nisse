# Commit line and session

Every change to a conversation goes through one ordered, atomic store commit, and a session that cannot store fails once and loudly.

## Sub-features

- `commit-atomic` [kernel] One mutation line, each commit atomic with a `seq` (§1, §4): Every client sees the same ordered history
- `commit-published-after-store` [kernel] Published only after stored (§1): A client never sees something a crash can erase
- `commit-tx-api` [kernel] Multi-record commit open to extensions: the `Tx` API (R816, §4): An extension writes an entry and a document as one atomic change
- `commit-tx-read` [kernel] Reads inside a transaction, `Tx.submission(id)` (Unreleased): A tool finds the entries of its run's inputs without scanning
- `entry-immutable` [kernel] Immutable entries (§2): History can be trusted and replayed
- `entry-custom` [kernel] Custom entry kinds with `defineEntry` (§8.1, R816): An extension stores its own record type in the transcript
- `conversation-root` [kernel] Reserved `root` conversation (§2.2): A single-conversation app needs no id handling
- `conversation-created-hook` [kernel] `conversationCreated` hook (R816-853): An extension sets up state in the same commit that creates a conversation
- `session-init` [kernel] Session `init` on first open (§2.2): The host seeds state once, atomically
- `commit-read-after-write` [kernel] Read-after-write rule while commits are in flight (§4): Reads never see half-stored data
- `session-failed` [kernel] Session failure on storage error: `SessionFailed`, `closed` promise (§10.1, R923-939): The host learns once that the session is dead, and nothing keeps running on bad state
- `error-model` [kernel] Three-rule error model (R923-939): An extension author knows which errors throw, which become records, and which go to reports
- `session-resume-explicit` [kernel] `resume()` as an explicit start of scheduling (R115-138): The host installs extensions before any work restarts
- `session-read-only` [kernel] Read-only open (R115-138, §2.2): Look at a session without running or changing anything
- `serve-read-only` [pending surface-conversations] The client path for Read-only open (R115-138, §2.2): Look at a session without running or changing anything
- `session-clock` [kernel] Injected clock: Effect's `Clock`, or a `now` (R140-212): Tests and hosts control durable time
- `provider-session-id` [kernel] Provider session id, stable per conversation (R115-138): Provider prompt caches keep hitting across requests
- `session-clean-close` [kernel, pending harness-run-core] Explicit `Harness` close without counting a crash (§5.4): A clean shutdown leaves runs resumable without using up their restarts
- `session-types` [kernel] The public types accept a run, a task and a document as written in the spec.
- `conversation-abort` [kernel] `Conversation.abort()` withdraws queued inputs, keeps queued writes, aborts the current work and resolves once the conversation is idle.
- `context-cancels-wait-only` [kernel] Cancelling a call's context stops only that wait, never the work.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `serve-read-only` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area A: spec §1, §2, §2.2, §4, §10.1; README Persist and Resume, Errors; examples 00-conversation, 12-recovery, 35-durable-on-the-store.

## Tests

Package, `packages/harness/test/harness.test.ts`:

- session-init: the host's init seeds the root once, in the commit that creates it, and never again after a restart

Package, `packages/kernel/test/tasks.test.ts`:

- session-clock, task-lifecycle-times: a TestClock drives a durable sleep, and the receipt stores when the task started and ended
- session-failed: a close whose write-back of a stopped task fails reports the failure instead of a clean close
- session-failed: a reservation whose commit fails fails the Session, and it still closes

Package, `packages/kernel/test/session.test.ts`:

- commit-atomic, commit-published-after-store: commits from many fibers form one ordered line, each published only after it is stored
- commit-atomic: a waiter's code after its commit runs only once the next commit on the line is published
- commit-read-after-write: a commit admitted while another is in storage starts only once that one is stored, and reads it
- commit-tx-api: a conversation, an entry and a submission commit as one change, and a failing callback stores none of them
- commit-tx-api: a table read after the commit's first table write is a ReadAfterWrite defect, and nothing is stored
- commit-tx-api: a Tx call that dies after its checks fails the commit even when the callback caught it, and nothing is stored
- commit-tx-api: a refusal a Tx call raises before touching the transaction, once caught, still commits
- commit-tx-read: a commit finds a placed input's entry through Tx.submission and answers it
- entry-immutable: an appended entry is a frozen copy of its draft, and storage keeps it as committed
- entry-custom: a defineEntry token sets the kind, and reading with it finds only that kind
- session-failed: a storage error fails the commit that hit it, every later commit with SessionFailed, and closes the Session
- session-failed: a commit whose callback caught a failed read fails with SessionFailed
- session-read-only: a read-only Session refuses a commit with writes before storage, and keeps answering reads
- commit-atomic: close lets admitted commits finish, then refuses new ones and ends observers
- commit-tx-api: a caller that stops waiting before its commit reaches storage abandons it, also while its writes are assembled
- commit-atomic: an observer whose async advance rejects is detached and ended listener_error, and commits go on
- commit-tx-api: a conversation cannot be owned by a task that is finishing, finished or abort-marked
- session-failed: a close listener or observer end that returns a rejecting promise has the rejection contained
- commit-atomic: an observer attached while close drains admitted commits gets them, then ends; one attached after close ends at once
- session-failed: a storage read that dies on a corrupt record fails the Session like a storage error
- commit-atomic: an observer that another observer's end detached during close gets no end

## Gotchas

- A commit observer's `advance` runs on the mutation line, before the commit resolves: it should only capture what it needs, because anything slow there delays every commit.
- A commit's callback runs on the line too. Code after `session.commit` returns runs later, on the caller's fiber, so it never delays the next commit.
