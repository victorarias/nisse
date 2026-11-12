# Commit line and session

Every change to a conversation goes through one ordered, atomic store commit,
and a session that cannot store fails once and loudly. `nisse serve --read-only`
serves a home without changing it: it resumes no run, answers `initialize`
with `"readOnly": true`, and refuses every write by name with `ReadOnlyServer`.
A ChatGPT sign-in lists its saved models without asking ChatGPT, so viewing a
home never refreshes its sign-in or rewrites its model list.
A TUI on it titles its prompt `READ ONLY`, says it takes no input, and still
runs `/usage`, `/tasks` and `/help`.

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
- `serve-read-only` The client path for Read-only open (R115-138, §2.2): Look at a session without running or changing anything
- `session-clock` [kernel] Injected clock: Effect's `Clock`, or a `now` (R140-212): Tests and hosts control durable time
- `provider-session-id` [kernel] Provider session id, stable per conversation (R115-138): Provider prompt caches keep hitting across requests
- `session-clean-close` [kernel, pending harness-run-core] Explicit `Harness` close without counting a crash (§5.4): A clean shutdown leaves runs resumable without using up their restarts
- `session-types` [kernel] The public types accept a run, a task and a document as written in the spec.
- `conversation-abort` [kernel] `Conversation.abort()` withdraws queued inputs, keeps queued writes, aborts the current work and resolves once the conversation is idle.
- `context-cancels-wait-only` [kernel] Cancelling a call's context stops only that wait, never the work.

## How to get to it

### People

- Run `nisse serve --read-only`, or `nisse serve --read-only --restart` to replace the running server once its runs settle, then open the TUI.

### Agents

- The same commands; `initialize` answers `readOnly`, and every call that would change the home fails `ReadOnlyServer`.

## Driving it with drive.ts

Preconditions:

- A fresh run whose script is
  `[{"text": "answer one"}, {"text": "one two three four five six seven eight", "delayMs": 1000}]`,
  `drive.ts r up --script s.json`.

- **Leave a run in flight.** `drive.ts r tui start --conversation talk`,
  `drive.ts r tui wait READY`, send `prompt one` and wait for `answer one` and
  `READY`, then send `count` and `drive.ts r tui wait 'two three'`. Run
  `drive.ts r tui stop` and then `drive.ts r kill-server`, in that order: a
  TUI still open would start a new server that resumes the run.
- **Serve read-only.** `drive.ts r serve --read-only`, then
  `drive.ts r rpc initialize '{"client": "drive", "version": "0", "protocol": 1}'`:
  `"readOnly": true`. `drive.ts r watch talk --save read-only-view`: the
  entries up to `nisse.user` `count`, and `pi.live` still holding the run and
  its partial answer `one two three `; a second `watch` sees no new commit.
- **The TUI.** `drive.ts r tui start --conversation talk` and
  `drive.ts r tui wait 'READ ONLY'`: the transcript up to `one two three`, the
  status bar at `READY`, since nothing runs, and the prompt panel titled
  `READ ONLY` reading
  `the server shows this home read-only and takes no input; /usage, /tasks and /help still work`.
  Type `prompt two` and `Enter`: it stays in the prompt, unsent, and
  `✗ this server is read-only and sends nothing; stop it and run nisse serve to send`
  shows above it. `/reset` is refused by name and nothing is committed.
  `/usage` opens the `USAGE` panel. The status bar shows no compacting or
  retry for a run the first server left in flight.
- **Refusals.** Each of `conversation/start`, `conversation/submit`,
  `conversation/interrupt`, `conversation/reset`, `conversation/configure`,
  `conversation/fork`, `conversation/compact`, `conversation/continue`,
  `submission/withdraw` and `conversation/select_model`, called with valid
  params through `drive.ts r rpc`, fails `ReadOnlyServer` with
  `the server opened /tmp/nisse-verify/r/home read-only, so it changes nothing; stop it and run nisse serve to make changes`.
  `drive.ts r nisse exec hi` exits 1 with the same line on stderr.
  `usage/get` and `conversation/list` answer.
- **Back to writable.** `drive.ts r serve --restart` replaces the read-only
  server, and `initialize` answers `"readOnly": false`.
  `drive.ts r watch talk --until run_end --timeout 30000 --save resumed`: the
  run left in flight resumes and ends `answered`. A restarted server starts
  its script over, so the answer is `answer one`.

## Contexts

- **Server restart.** Only a server started without `--read-only` resumes the runs a crash cut off.

## Sources

Feature ledger area A: spec §1, §2, §2.2, §4, §10.1; README Persist and Resume, Errors; examples 00-conversation, 12-recovery, 35-durable-on-the-store.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- serve-read-only: a read-only server shows a home's conversations without resuming the run left in flight, and refuses every change by name

Provider, `packages/nisse/test/openai.test.ts`:

- serve-read-only: a read-only server lists ChatGPT's saved models without asking ChatGPT, so an expired sign-in is left as it was

Screen, `packages/nisse/test/screen.test.ts`:

- serve-read-only: under nisse serve --read-only the TUI shows a conversation and runs commands, but keeps a typed message unsent and says why

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
- A TUI left open while `serve --restart` replaces its server keeps drawing
  the old server's state: after a switch from read-only it still shows
  `READ ONLY`, and a prompt typed into an open TUI after any `serve --restart`
  is committed but never drawn. Stop the TUI and start it again after a
  restart.
