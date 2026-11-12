# Run limits and resilience

A run stops at its limits with a named reason, survives provider hiccups and
crashes, and keeps what was said. A conversation limited with `/max-turns` or
`conversation/configure` ends a run that takes more tool rounds than that as
`✗ reached the turn limit of <n> turn(s)`. While a provider's failed request
waits to be retried, the status bar counts down
`↻ retrying in <n>s · <error>`, and `Esc` stops the run.

## Sub-features

- `run-turn-limit` Turn limit, `maxTurns` (R380-404): A runaway loop stops with a named reason
- `run-retry` [kernel] Durable retry with backoff, default 3 tries, 2 s to 60 s (§8.3): A provider hiccup doesn't fail the run, and the wait survives a restart
- `run-retry-live` Retry visible live (§8.2, §8.3): People see "retrying in 8 s" and can stop it
- `run-stream-options` [kernel] Stream options: timeouts, headers, cache retention (§8.3): Tune or attribute provider requests
- `run-restart-limit` [kernel] Restart limit (§5.4): A run that keeps crashing the server stops
- `run-crash-count-resets` [kernel] Crash count resets on progress (§5.4): A long run that makes progress is never killed by old crashes
- `run-partial-kept` [kernel] Partial answer preserved on abort or crash (§8.3): What was said so far is kept
- `run-failed-attempt` [kernel] Failed attempt recorded as an entry (§8.3): A failed request is visible in history
- `run-abort-mark` [kernel] Abort commits a mark before stopping (§5.4): A crash between Esc and the stop still ends the run as interrupted
- `run-phases` [kernel] Generation phases stored: prepare, request, retry, poll, tools, finish, drain (§8.3): A restart resumes the exact step
- `run-deferred` [kernel] Deferred responses and polling (§8.3): A very long request survives a restart by polling for the result
- `run-error-classes` [kernel] Provider error classification: retryable, overflow, fatal (§8.3): The right recovery runs for each failure
- `run-crash-charges-retry` [kernel] A request the host died during counts as a failed attempt and ends `interrupted` when no retry is left; a clean close re-sends without charge.

## How to get to it

### People

- Set a limit with `/max-turns <n>`, see [Per-conversation agent and settings](./agent-settings.md).
- Watch the status bar while a run works; press `Esc` to stop a retry.

### Agents

- Call `conversation/configure` with `maxTurns`.
- Watch a conversation: its view's `pi.live` `generation.retry` holds `at` (when the retry goes) and `error`; `conversation/interrupt` stops it.

### Triggers

- A tool round past the limit ends the run; a retryable provider error, such as a 503, schedules a retry.

## Driving it with drive.ts

Preconditions:

- A fresh run whose script is two calls of
  `{"tool": {"name": "bash", "input": {"command": "echo again"}}}` and four of
  `{"fail": "503 service unavailable"}`, `drive.ts r up --script s.json`, then
  `drive.ts r tui start --conversation talk --auto` and
  `drive.ts r tui wait READY`.

- **Turn limit.** Type `/max-turns 1` and `Enter`,
  `drive.ts r tui wait 'set the turn limit'` (`◆ ada set the turn limit to 1 turn`), then type `loop` and `Enter`,
  `drive.ts r tui wait 'turn limit'` and `drive.ts r tui wait READY`: under
  `NISSE`, `▸ bash(echo again)` and `again`, then
  `✗ reached the turn limit of 1 turn`. `drive.ts r watch talk --save turn-limit`
  ends with a `nisse.run_end`
  `{"outcome": "failed", "message": "reached the turn limit of 1 turn"}`.
  The model's next call was never asked for: `/continue` runs the second
  `bash` and ends at the limit again.
- **Retry, live.** Type `/max-turns` and `Enter`
  (`◆ ada removed the turn limit`), then `hi` and `Enter`, and
  `drive.ts r tui wait 'retrying in'`: the status bar reads
  `WORKING 0s  ↻ retrying in 2s · 503 service unavailable`.
  `drive.ts r watch talk --save retry-live` shows `pi.live`
  `"generation": {"attempt": 1, "retry": {"at": <ms>, "error": "503 service unavailable"}}`.
- **Stop the retry.** Press `drive.ts r tui key Escape` at once, before the
  2 s are up, then `drive.ts r tui wait interrupted`: `◆ interrupted` under
  `hi`, and the run ends `interrupted`.
- **A retry that recovers.**
  `drive.ts r watch talk --submit again --until run_end --timeout 40000 --save retry-recovered`:
  `pi.live` shows `attempt` 1 and then 2, each with a later `at`, and the run
  ends `answered` with `You said: again` once the script runs out of failures.

## Contexts

- **Second client.** The countdown is the conversation's live state; the
  `watch` sees the same retry the TUI draws.

## Sources

Feature ledger area G: spec §5.4, §8.2, §8.3; README Per-Conversation Agent; examples 12-recovery, 33-turn-limit-and-continue, 30-reload-and-restart.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- configure-rpc, run-turn-limit: changed instructions reach the model and the transcript says who changed them; a turn limit ends a looping run by name
- run-retry-live: a provider hiccup shows its retry and when it comes, and stopping it ends the run

Screen, `packages/nisse/test/screen.test.ts`:

- configure-rpc, run-turn-limit: /instructions and /max-turns show who changed what, and a looping run ends naming the limit
- run-retry-live: the status bar counts down a provider's retry, and escape stops it

`bun run coverage` lists the kernel ids here with their tests, their mapped upstream rows or their owning child.

## Gotchas

- The first retry waits 2 s: `Escape` must land inside that window to stop a
  waiting retry, so press it straight after the wait returns.
- `/max-turns` counts tool rounds, and the end line counts turns: the same
  number under two names.
