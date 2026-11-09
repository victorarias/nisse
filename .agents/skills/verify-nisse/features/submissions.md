# Submissions

Every input handed to a conversation is admitted by written rules, deduplicated, placed at a defined boundary, and ends with a recorded fate.

## Sub-features

- `submission-dedupe` [kernel, pending harness-run-core] `requestId` deduplication (R529-591): A retried send lands once
- `submission-steer` [kernel, pending harness-run-core] `whenBusy: steer` (R529-591): Input reaches the model inside the current run
- `submission-follow-up` [kernel, pending harness-run-core] `whenBusy: followUp` (R529-591): Input waits and runs after the current one
- `submission-busy-reject` [kernel, pending harness-run-core] `whenBusy: reject` (R529-591): A script gets a refusal rather than a queue
- `submission-idle-reject` [kernel, pending harness-run-core] `whenIdle: reject` (R529-591): "Steer only if something is running" does not start a new run
- `submission-write` [kernel, pending harness-run-core] Write entries without a run (R529-591, §6): Add context the next run will see, without starting one
- `submission-display-only` [kernel, pending harness-run-core] Display-only writes (§6): Show people a note the model never sees
- `submission-continue` [kernel, pending harness-run-core] `continue` (R529-591, §6): Let the model go on with no new input, for example after a failure
- `continue-rpc` [pending surface-conversations] The client path for `continue` (R529-591, §6): Let the model go on with no new input, for example after a failure
- `submission-withdraw` [kernel, pending harness-run-core] Withdraw a queued input, `Submission.abort` (R529-591): Take back a queued message before it runs
- `withdraw-rpc` [pending surface-conversations] The client path for Withdraw a queued input, `Submission.abort` (R529-591): Take back a queued message before it runs
- `submission-status` [kernel, pending harness-run-core] `Submission.status`, `wait`, reacquire by id (R529-591): A client waits for its own input's outcome, also after reconnecting
- `submission-in-commit` [kernel, pending harness-run-core] Submit inside a commit, `submit(tx, draft)` (R529-591, example 34): An extension starts a run atomically with its own write
- `submission-custom-entry` [kernel, pending harness-run-core] Custom input entry (R529-591): A submission is a typed record, not only text
- `submission-queue-modes` [kernel, pending harness-run-core] `steeringMode`, `followUpMode`: all or one at a time (§6): Decide whether queued inputs land together or one per step
- `submission-after-failed-run` [kernel, pending harness-run-core] `afterFailedRun` (R214-222, §6): Decide what queued inputs do after a run fails
- `submission-settled` [kernel, pending harness-run-core] Settlement records, answered or unanswered with reason (§6): Every input has a final recorded fate
- `run-failure-reasons` [kernel, pending harness-run-core] Run failure reasons (§8.2): People see why a run ended: model_error, no_model, aborted, reset, faulted, orphaned, interrupted, restart_limit, nothing_to_answer, turn_limit
- `submission-admission` [kernel, pending harness-run-core] Admission table for each state and input kind (§6): Behavior is predictable in every state, with a test per cell
- `submission-boundaries` [kernel, pending harness-run-core] Input boundaries: postTools and final (§6): Inputs are placed at defined points

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `continue-rpc` lands with `surface-conversations`, which adds its entry point and recipe.
- Not reachable yet: `withdraw-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area F: spec §6, §8.2; README Busy Conversations, Failures and Recovery; examples 19-inbox, 34-submit-in-commit, 33-turn-limit-and-continue.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
