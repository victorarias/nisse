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
- `crash-claude` resumes a Claude Code run whose server was killed while a
  subagent worked: the cut-off `Agent` call is recorded as interrupted, the
  subagent ends `interrupted`, and Claude Code is resumed to carry on.
- `crash-claude-settled` does not run a finished Claude Code answer again when
  the server dies after it.

## How to get to it (user POV)

- The server dies (SIGKILL, power loss) while Nisse is answering, a call
  runs, or a Claude Code subagent works, with a TUI or `exec` waiting on it.

## Driving it with drive.ts

Preconditions:

- Write the script to a file and start the run with
  `drive.ts r up --script <file>`; a run without `--fake-claude` plays the
  `models` recording, so Claude is signed in and never answers.
- The Claude steps start the run with `drive.ts r up --fake-claude <fixture>`
  and no script.
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

- **Claude subagent cut off.** In a run started with
  `drive.ts r up --fake-claude subagent_working`, run `drive.ts r serve`,
  `drive.ts r tui start --provider claude --auto`, `drive.ts r tui wait READY`,
  type what the recording's user typed,
  `drive.ts r tui type 'Use the Task tool to start a general-purpose subagent that reads notes.txt with the Read tool and reports where the gnome lives. Do not read it yourself. Then reply with where the gnome lives, in three words.'`,
  and `drive.ts r tui key Enter`. Once `drive.ts r tui wait 'Read('` returns,
  the card `Find gnome location in notes (general-purpose)` reads `working`:
  run `drive.ts r tui screen before-kill` and `drive.ts r kill-server`. Then
  `drive.ts r tui wait --timeout 30000 'resumed ok'`,
  `drive.ts r tui wait READY` and `drive.ts r tui screen recovered`: the card
  reads `interrupted` and `resumed ok` follows. `rpc conversation/list` shows
  the parent `answered` with `"said": "resumed ok"` and the subagent
  `interrupted`; `watch <parent>` shows `tool_result`
  `interrupted; it may or may not have taken effect`, `message` `resumed ok`
  and one `run_end` with `"outcome": "answered"`, and `watch <subagent>` ends
  with one `run_end` with `"outcome": "interrupted"`. In
  `evidence/fake-claude/log.ndjson` spawn 0 has `--session-id`, spawn 1 has
  `--resume-session-at` and received the user message `Your Agent call
toolu_01DxmcUXKnbFWBQecJLTs1n3 was cut off: interrupted; it may or may not
have taken effect`.
- **Claude answer already finished.** In a run started with
  `drive.ts r up --fake-claude crash_points`, run `drive.ts r serve`,
  `drive.ts r tui start --provider claude --auto`, `drive.ts r tui wait READY`,
  type the recording's prompt,
  `drive.ts r tui type 'First write one short sentence saying that you will read the notes. Then use the Read tool to read notes.txt. Then reply with where the gnome lives, in three words.'`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'Under the floor'`, and
  `drive.ts r tui wait READY`. Run `drive.ts r kill-server`, and
  `drive.ts r doctor` shows a new server once the TUI has reconnected. The
  screen is unchanged and the log in `evidence/fake-claude/log.ndjson` has
  spawn `0` only: nothing runs the answer again.

## Gotchas

- Each server start begins the script from its first step, so the restarted
  server answers with the same scripted text, and calls the same tool again.
- `crash_points` plays its whole journey the moment the prompt arrives (the
  sentence, the `Read`, `Under the floor.`) and then waits, so no kill lands
  inside the run; only `subagent_working` stalls, at the subagent's call.
  Killing in the middle of a recorded Claude answer needs a helper that holds
  the fake `claude` at a frame.
- Kill only with `kill-server`, which checks the pid holds this run's home.
- Between kills, wait for `three` to go and come back: the restarted run
  clears the live text, and a kill before the run restarts does not count.

## With a real account

Proves that a real Claude Code, not a recording, is resumed after the server
dies while its subagent works. Follow the skill's
[Real accounts](../SKILL.md#real-accounts): one run,
`drive.ts r up --real-claude`, then `drive.ts r serve` and
`drive.ts r rpc providers/list '{}'`: `claude` is `ready` with your account.
Otherwise stop and report what it shows. Give every `tui wait`
`--timeout 120000`, and keep `evidence/`. No step needs a person. The plain
call cut off by a kill is Claude's **Cut off** step in [Claude](./claude.md#with-a-real-account).

- **Subagent cut off.** Run `drive.ts r tui start --provider claude --auto`,
  `drive.ts r tui wait READY`, then
  `drive.ts r tui type 'Use the Task tool to start a general-purpose subagent that runs the Bash command sleep 90 and then reports done. Do not run anything yourself. If the Agent call is cut off or interrupted, do not start another subagent; reply with exactly: resumed ok'`
  and `drive.ts r tui key Enter`. Once `drive.ts r tui wait 'sleep 90'`
  returns and the subagent's card reads `working`, run
  `drive.ts r tui screen before-kill` and `drive.ts r kill-server`. Then
  `drive.ts r tui wait 'resumed ok'` and `drive.ts r tui wait READY`, and
  `drive.ts r tui screen recovered`: the card reads `interrupted` and
  `resumed ok` follows. `drive.ts r rpc conversation/list` shows the parent
  `answered` with `"said": "resumed ok"` and the subagent `interrupted`;
  `drive.ts r watch <parent>` shows a `tool_result` starting
  `interrupted; it may or may not have taken effect`, and one `run_end` with
  `"outcome": "answered"`; `drive.ts r watch <subagent>` ends with one
  `run_end` with `"outcome": "interrupted"`. A new
  `drive.ts r tui start --conversation <parent>` shows the same screen. A
  model may word a reply differently: judge the states, not the wording.
