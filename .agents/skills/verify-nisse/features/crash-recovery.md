# Crash recovery

A run cut off by a crashed server carries on when the server comes back. The
client that was watching reconnects, starts a new server if none runs, and
shows the whole answer once. A call that was running when the server died is
recorded as interrupted and the model carries on. A run that crashes the
server three times in a row ends instead of looping.

## Sub-features

- `crash-tui` finishes the answer in the open TUI after the server is killed.
- `crash-exec` finishes the answer for a waiting `nisse exec`, which exits 0.
- `crash-committed` commits the answer once, in a run that ends `answered`.
- `crash-call` records a running call as
  `interrupted; it may or may not have taken effect` and goes on.
- `crash-limit` ends the run with `restart_limit` after the server stopped
  during it three times in a row.

## How to get to it (user POV)

- The server dies (SIGKILL, power loss) while Nisse is answering or a call
  runs, with a TUI or `exec` waiting on it.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "one two three four five six seven eight nine ten", "delayMs": 300}]`;
  for `crash-call`, a run whose script is
  `[{"text": "waiting", "tool": {"name": "Bash", "input": {"command": "sleep 5; echo slept"}}}, {"text": "carried on"}]`.

- **Kill mid-answer.** Run `drive.ts r serve`, `drive.ts r tui start`,
  `drive.ts r tui wait READY`, `drive.ts r tui type count`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait three`,
  `drive.ts r tui screen before-kill`, `drive.ts r kill-server`.
- **Recovered.** Run `drive.ts r tui wait --timeout 30000 ten`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen recovered`, and
  `drive.ts r doctor`. The whole answer under `NISSE`, and a new server pid.
- **Committed once.** Run `drive.ts r rpc conversation/list` and
  `drive.ts r watch <id> --save recovered`. The snapshot holds one `message`
  entry with the whole text and one `run_end` with `"outcome": "answered"`.
- **Exec.** In a fresh run with the same script, run `drive.ts r serve`, then
  `drive.ts r nisse exec count > /tmp/nisse-verify/r-exec.txt &`. `nisse`
  prints stdout as it arrives: once that file shows `three`, run
  `drive.ts r kill-server`, then `wait`. The saved `nisse` output shows the
  whole answer once and exit 0.
- **Call cut off.** In the `crash-call` run, run `drive.ts r serve`,
  `drive.ts r tui start --auto`, `drive.ts r tui wait READY`,
  `drive.ts r tui type nap`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'Bash(sleep 5; echo slept)'`, `drive.ts r kill-server`,
  `drive.ts r tui wait --timeout 30000 'carried on'`,
  `drive.ts r tui screen call-cut-off`. The first call shows
  `interrupted; it may or may not have taken effect`; the restarted script
  calls it again, which shows `slept`, then `carried on`. `watch <id>` shows
  the interrupted `tool_result` with `"error": true` and one `run_end` with
  `"outcome": "answered"`.
- **Limit.** In a fresh `count` run, start the run as in the first step, then
  three times: `drive.ts r tui wait three`, `drive.ts r kill-server`,
  `drive.ts r tui wait --gone three`. Then
  `drive.ts r tui wait --timeout 30000 'times in a row'`,
  `drive.ts r tui screen restart-limit`:
  `✗ the server stopped during this run 3 times in a row` and `READY`. The
  snapshot's last entry is a `run_end` with `"outcome": "restart_limit"`.

## Gotchas

- Each server start begins the script from its first step, so the restarted
  server answers with the same scripted text, and calls the same tool again.
- Kill only with `kill-server`, which checks the pid holds this run's home.
- Between kills, wait for `three` to go and come back: the restarted run
  clears the live text, and a kill before the run restarts does not count.
