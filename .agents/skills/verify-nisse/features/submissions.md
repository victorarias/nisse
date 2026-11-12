# Submissions

Every input handed to a conversation is admitted by written rules,
deduplicated, placed at a defined boundary, and ends with a recorded fate.
`/continue` or `conversation/continue` starts a run with no new input, such as
after one failed, and the model goes on from where it was. `/withdraw` takes
back the newest prompt waiting in the queue, shown as `withdrew: <text>`, and
`submission/withdraw` takes back any queued submission; a withdrawn prompt
never runs.

## Sub-features

- `submission-dedupe` [kernel] `requestId` deduplication (R529-591): A retried send lands once
- `submission-steer` [kernel] `whenBusy: steer` (R529-591): Input reaches the model inside the current run
- `submission-follow-up` [kernel] `whenBusy: followUp` (R529-591): Input waits and runs after the current one
- `submission-busy-reject` [kernel] `whenBusy: reject` (R529-591): A script gets a refusal rather than a queue
- `submission-idle-reject` [kernel] `whenIdle: reject` (R529-591): "Steer only if something is running" does not start a new run
- `submission-write` [kernel] Write entries without a run (R529-591, §6): Add context the next run will see, without starting one
- `submission-display-only` [kernel] Display-only writes (§6): Show people a note the model never sees
- `submission-continue` [kernel] `continue` (R529-591, §6): Let the model go on with no new input, for example after a failure
- `continue-rpc` The client path for `continue` (R529-591, §6): Let the model go on with no new input, for example after a failure
- `submission-withdraw` [kernel] Withdraw a queued input, `Submission.abort` (R529-591): Take back a queued message before it runs
- `withdraw-rpc` The client path for Withdraw a queued input, `Submission.abort` (R529-591): Take back a queued message before it runs
- `submission-status` [kernel] `Submission.status`, `wait`, reacquire by id (R529-591): A client waits for its own input's outcome, also after reconnecting
- `submission-in-commit` [kernel, pending harness-run-core] Submit inside a commit, `submit(tx, draft)` (R529-591, example 34): An extension starts a run atomically with its own write
- `submission-custom-entry` [kernel] Custom input entry (R529-591): A submission is a typed record, not only text
- `submission-queue-modes` [kernel] `steeringMode`, `followUpMode`: all or one at a time (§6): Decide whether queued inputs land together or one per step
- `submission-after-failed-run` [kernel] `afterFailedRun` (R214-222, §6): Decide what queued inputs do after a run fails
- `submission-settled` [kernel] Settlement records, answered or unanswered with reason (§6): Every input has a final recorded fate
- `run-failure-reasons` [kernel] Run failure reasons (§8.2): People see why a run ended: model_error, no_model, aborted, reset, faulted, orphaned, interrupted, restart_limit, nothing_to_answer, turn_limit
- `submission-admission` [kernel] Admission table for each state and input kind (§6): Behavior is predictable in every state, with a test per cell
- `submission-boundaries` [kernel] Input boundaries: postTools and final (§6): Inputs are placed at defined points

## How to get to it

### People

- Type `/continue` in the TUI's prompt and press `⏎`.
- Type `/withdraw` while a prompt waits as `queued · <text>`, and press `⏎`.

### Agents

- Call `conversation/continue` with `conversation`; it answers the run's `submission`.
- Call `submission/withdraw` with `conversation` and `submission` (an id from `conversation/submit`'s answer or the view's `pi.inbox` items); it answers `withdrawn`, `already_placed` or `settled`.

## Driving it with drive.ts

Preconditions:

- A fresh run whose script is
  `[{"fail": "provider went away"}, {"text": "back on it now", "delayMs": 300}, {"text": "slow one two three four five six seven eight", "delayMs": 1000}]`,
  `drive.ts r up --script s.json`, and
  `drive.ts r tui start --conversation talk`, `drive.ts r tui wait READY`.

- **Continue after a failure.** Type `hi` and `Enter`,
  `drive.ts r tui wait 'provider went away'` and `drive.ts r tui wait READY`:
  `✗ provider went away` under `hi`. Type `/continue` and `Enter`, then
  `drive.ts r tui wait 'back on it now'`: a `NISSE` answer follows with no new
  `ADA` prompt. `drive.ts r watch talk --save continued` holds `nisse.user` `hi`,
  a `nisse.run_end` `failed` `provider went away`, then a `pi.assistant`
  `back on it now` and a `nisse.run_end` `answered`, with no user entry
  between them.
- **Continue while busy.** Type `first` and `Enter`, `drive.ts r tui wait slow`,
  and while it streams run
  `drive.ts r rpc conversation/continue '{"conversation": "talk"}'`: it fails
  `ConversationBusy`.
- **Withdraw from the TUI.** While `first` still streams, type `second` and
  `Enter`, `drive.ts r tui wait 'queued · second'`, then type `/withdraw` and
  `Enter`: `drive.ts r tui wait 'withdrew: second'` shows
  `◆ withdrew: second` above the prompt and the queued line is gone. Once
  `eight` and `READY` show, the transcript has no `second` and no
  `You said: second`.
- **Withdraw over the wire.** Run
  `drive.ts r rpc conversation/submit '{"conversation": "talk", "requestId": "three", "author": "bo", "text": "three"}'`:
  `"result": {"submission": <n>}`. Once `You said: three` shows,
  `drive.ts r rpc submission/withdraw '{"conversation": "talk", "submission": <n>}'`
  answers `"result": "settled"`, and `"submission": 9999` fails
  `NoSuchSubmission`.

## Sources

Feature ledger area F: spec §6, §8.2; README Busy Conversations, Failures and Recovery; examples 19-inbox, 34-submit-in-commit, 33-turn-limit-and-continue.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- continue-rpc: a conversation whose run failed goes on with no new input, and one that works is refused by name
- withdraw-rpc: a queued prompt taken back never runs, and one already run cannot be

Screen, `packages/nisse/test/screen.test.ts`:

- continue-rpc: /continue goes on after a failed run with no new input
- withdraw-rpc: /withdraw takes back the queued prompt before it runs

Package, `packages/harness/test/harness.test.ts`:

- submission-dedupe: a submission retried with its request ID after a restart lands once

## Gotchas

- `/continue` in a conversation with nothing to answer commits a failed run,
  drawn `✗ nothing to answer`; in a new conversation that line replaces the
  splash.
- With nothing queued, `/withdraw` shows `✗ nothing queued to withdraw`.
- A withdrawn prompt leaves no entry: the proof is what the transcript lacks.
