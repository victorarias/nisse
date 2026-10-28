# Crash recovery

A run cut off by a crashed server answers again when the server comes back.
The client that was watching reconnects, starts a new server if none runs, and
shows the whole answer once.

## Sub-features

- `crash-tui` finishes the answer in the open TUI after the server is killed.
- `crash-exec` finishes the answer for a waiting `nisse exec`, which exits 0.
- `crash-committed` commits the answer once, not interrupted.

## How to get to it (user POV)

- The server dies (SIGKILL, power loss) while Nisse is answering, with a TUI
  or `exec` waiting on it.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "one two three four five six seven eight nine ten", "delayMs": 300}]`.

- **Kill mid-answer.** Run `drive.ts r serve`, `drive.ts r tui start`,
  `drive.ts r tui wait READY`, `drive.ts r tui type count`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait three`,
  `drive.ts r tui screen before-kill`, `drive.ts r kill-server`.
- **Recovered.** Run `drive.ts r tui wait --timeout 30000 ten`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen recovered`, and
  `drive.ts r doctor`. The whole answer under `NISSE`, and a new server pid.
- **Committed once.** Run `drive.ts r rpc conversation/list` and
  `drive.ts r watch <id> --save recovered`. The snapshot holds one `answer`
  entry with the whole text and `"interrupted": false`.
- **Exec.** In a fresh run with the same script, run `drive.ts r serve`, then
  `drive.ts r nisse exec count > /tmp/nisse-verify/r-exec.txt &`. `nisse`
  prints stdout as it arrives: once that file shows `three`, run
  `drive.ts r kill-server`, then `wait`. The saved `nisse` output shows the
  whole answer once and exit 0.

## Gotchas

- Each server start begins the script from its first step, so the restarted
  server answers with the same scripted text.
- Kill only with `kill-server`, which checks the pid holds this run's home.
