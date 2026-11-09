# Run limits and resilience

A run stops at its limits with a named reason, survives provider hiccups and crashes, and keeps what was said.

## Sub-features

- `run-turn-limit` [kernel, pending harness-run-core] Turn limit, `maxTurns` (R380-404): A runaway loop stops with a named reason
- `run-retry` [kernel, pending harness-run-core] Durable retry with backoff, default 3 tries, 2 s to 60 s (§8.3): A provider hiccup doesn't fail the run, and the wait survives a restart
- `run-retry-live` [kernel, pending harness-run-core] Retry visible live (§8.2, §8.3): People see "retrying in 8 s" and can stop it
- `run-stream-options` [kernel, pending harness-run-core] Stream options: timeouts, headers, cache retention (§8.3): Tune or attribute provider requests
- `run-restart-limit` [kernel, pending harness-run-core] Restart limit (§5.4): A run that keeps crashing the server stops
- `run-crash-count-resets` [kernel, pending harness-run-core] Crash count resets on progress (§5.4): A long run that makes progress is never killed by old crashes
- `run-partial-kept` [kernel, pending harness-run-core] Partial answer preserved on abort or crash (§8.3): What was said so far is kept
- `run-failed-attempt` [kernel, pending harness-run-core] Failed attempt recorded as an entry (§8.3): A failed request is visible in history
- `run-abort-mark` [kernel, pending harness-run-core] Abort commits a mark before stopping (§5.4): A crash between Esc and the stop still ends the run as interrupted
- `run-phases` [kernel, pending harness-run-core] Generation phases stored: prepare, request, retry, poll, tools, finish, drain (§8.3): A restart resumes the exact step
- `run-deferred` [kernel, pending harness-run-core] Deferred responses and polling (§8.3): A very long request survives a restart by polling for the result
- `run-error-classes` [kernel, pending harness-run-core] Provider error classification: retryable, overflow, fatal (§8.3): The right recovery runs for each failure
- `run-crash-charges-retry` [kernel, pending harness-run-core] A request the host died during counts as a failed attempt and ends `interrupted` when no retry is left; a clean close re-sends without charge.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area G: spec §5.4, §8.2, §8.3; README Per-Conversation Agent; examples 12-recovery, 33-turn-limit-and-continue, 30-reload-and-restart.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
