# Server lifecycle

One server serves a home, shared by every client. The first client to need it
starts it, clients starting at the same moment share it, a second server for
the same home refuses to start, and the server exits 30 s after its last
watch closes, its last run settles and its last live Claude Code process
closes. `sigma serve --restart` replaces a
running server once its runs settle.

## Sub-features

- `server-on-demand` starts a server for the first `exec` or TUI.
- `server-shared` lets clients that start together share one server.
- `server-refuse` makes `sigma serve` refuse a home that already has a server.
- `server-idle-exit` exits the server 30 s after its last watch closes,
  its last run settles and its last live Claude Code process closes, which
  is 30 minutes after that conversation's last run (`claude-idle-release` in
  [Claude](./claude.md)).
- `server-cannot-start` shows a waiting client why the home's server refuses
  to start, such as a `config.toml` that does not read: on the TUI's status
  line, and on `exec`'s stderr. The client starts the next server a second
  after each refusal, and carries on once one starts.
- `server-stop` stops it on `server/stop` once its runs settle, closing its
  live Claude Code processes at once.
- `server-restart` replaces the running server with `sigma serve --restart`
  once its runs settle. A server a client starts meanwhile gives way to it,
  even one that was already waiting for the old server's home.

## How to get to it

### People

- Run `sigma exec` or open the TUI with no server running.
- Run `sigma serve`.
- Run `sigma serve --restart` to replace the running server once its runs settle.

### Agents

- Call `server/stop`.

### Triggers

- The home has no open `conversation/watch`, `status/watch` or `auth/watch` stream, no running run and no live Claude Code process for 30 s. A connection making only single calls does not keep the server alive.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`, which also gives the run a
  signed-in fake Claude; `Restart waits for runs` adds the script it names.

- **On demand.** Run `drive.ts r doctor`: `server none running`. Run
  `drive.ts r sigma exec hi`, then `drive.ts r doctor`: a server pid running
  this checkout's `main.ts serve`.
- **Refuse.** Run `drive.ts r sigma serve`. The saved output shows `--- exit 75`
  about a second later (a starting server waits up to 1 s for a moment's
  contention on the home lock to pass), and stderr says
  `another server already serves /tmp/sigma-verify/r/home`.
- **Shared.** In a fresh run, start eight at once:
  `for i in 1 2 3 4 5 6 7 8; do drive.ts r sigma exec "client $i" & done; wait`.
  The run's evidence holds eight `NNN-sigma.txt` files, each with its own
  `You said: client <i>` and `--- exit 0`, and `doctor` shows one server.
- **Idle exit.** Run `drive.ts r sigma exec hi`; the `steps.log` line
  `saved ...-sigma.txt` is when the last client left. Run `drive.ts r doctor`
  once a second until it shows `none running`, and read the time from
  `date`. The server was gone 30 s to 31 s after that line; less than 30 s is
  a finding. With a TUI open the server stays: `drive.ts r tui start`,
  `tui wait READY`, wait 40 s, and `doctor` still shows the server and
  `tui running`. After `drive.ts r tui key C-c`, it is gone 30 s later.
- **Stop.** Run `drive.ts r serve`, then
  `drive.ts r rpc server/stop`, then `drive.ts r doctor`: `none running`.
  The call answers with a `null` result before the server ends.
- **Stop with a live Claude Code process** (`drive.ts r up --fake-claude text`).
  Run `drive.ts r sigma exec --provider claude 'Reply with exactly: fixture text ok'`:
  stdout `fixture text ok`, and `drive.ts r doctor` still shows the server
  past 30 s, since the process is live. Run `drive.ts r rpc server/stop`:
  `doctor` shows `none running`, and
  `/tmp/sigma-verify/r/evidence/fake-claude/log.ndjson` ends with
  a `{"spawn":0,"exited":...}` line.
- **Restart.** Run `drive.ts r serve` and note the pid, then
  `drive.ts r sigma serve --restart &`. `sigma` runs the new server in the
  foreground, so the command keeps going. Run `drive.ts r doctor` until the
  server pid is a different one (it may show `none running` for an instant), whose command line ends in
  `main.ts serve --restart`. Then stop it with
  `drive.ts r rpc server/stop`; the `--restart` command ends with exit 0 and
  stderr `sigma 0.1.0 serving /tmp/sigma-verify/r/home`.
- **Restart under an open TUI.** Run `drive.ts r tui start --conversation talk`,
  `drive.ts r tui wait READY`, send `one` and wait for `You said: one`. Run
  `drive.ts r serve --restart`, then type `two` and `Enter`:
  `drive.ts r tui wait 'You said: two'`. The TUI watches the new server and
  draws what it answers. Repeat `drive.ts r serve --restart`, adding
  `--read-only` every other time: each prints `serving` and the TUI shows
  `READ ONLY` or `PROMPT` to match.
- **Cannot start.** Run `drive.ts r serve`, `drive.ts r tui start` and
  `drive.ts r tui wait READY`. Write `[extensions.guard` to
  `/tmp/sigma-verify/r/home/config.toml`, run `drive.ts r kill-server`, then
  `drive.ts r tui wait 'cannot start'`: above the prompt, `✗ sigma's server
cannot start: .../config.toml: TOML Parse error ...`. Count
  `TOML Parse error` lines in the home's `sigma.log` twice, 5 s apart: about
  four more, one start a second. Delete `config.toml`: the line goes, and a
  prompt typed then is answered. For `exec`, use a script whose answer has
  `"delayMs": 300`, run `drive.ts r sigma exec count &`, and break the config
  and kill the server a second later: the saved output's stderr has the same
  line once, and once the config is deleted it prints the answer and exits 0.
- **Restart waits for runs.** In a run whose script is
  `[{"text": "one two three four five six seven eight", "delayMs": 300}]`,
  run `drive.ts r serve`, then `drive.ts r sigma exec count &` and, a second
  later, `drive.ts r sigma serve --restart &`. The `exec` prints
  `one two three four five six seven eight` and exits 0, and `doctor` then
  shows a new server pid whose command ends in `main.ts serve --restart`: the
  old server let the run answer first, and the client was not left waiting.

## Contexts

- **Running work.** `serve --restart` and `server/stop` wait for runs to settle.
- **Open clients.** A stop ends every open call and watch the way a lost connection does, so an open TUI watches the next server. A client that loses its server starts one, and while `serve --restart` replaces the server, the one the client started gives way (`another server already serves` in the home's `sigma.log`), so the restart always becomes the home's server. A server that took the home just before the restart and does not answer yet is stopped once it answers: the restart prints `waiting for the server that holds <home> to stop`, stops again on each attempt at the home, and gives up with `another server already serves` 30 s after its last stop reached a server, or after its start when none answered.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- server-idle-exit: the server exits once no client is connected and nothing is running
- server-idle-exit: a submission's run keeps the server up after its client leaves, past the idle grace
- server-idle-exit, child-tools: a subagent's work keeps the server up after its client leaves, past the idle grace
- server-stop, child-tools: stopping the server lets a working subagent finish and report first
- server-stop: stopping the server answers the caller, then the server exits
- server-stop: stopping the server while sigma answers lets the answer finish first

Provider, `packages/sigma/test/claude.test.ts`:

- server-idle-exit, claude-idle-release: a live Claude Code process keeps the server up after its client leaves, until the process closes
- server-stop, claude-live: stopping the server closes its live Claude Code processes at once

Screen, `packages/sigma/test/screen.test.ts`:

- server-restart, serve-read-only: an open TUI keeps drawing while sigma serve --restart replaces its server, read-only and back
- server-cannot-start: an open TUI whose server cannot start shows why, starts one at most once a second, and carries on once it can

Stack, `packages/sigma/test/stack.test.ts`:

- server-stop: sigma serve answers server/stop, then exits 0
- mode-print, answer-exec, server-on-demand: sigma exec starts a server, prints the answer and exits 0
- server-restart: sigma serve --restart replaces the running server once its run settles
- server-restart: sigma exec waiting on a run that serve --restart lets finish prints the answer and exits 0
- server-restart: a server that starts while serve --restart replaces the old one gives way, though it waited on the old one's lock
- server-restart: sigma serve --restart replaces a server that took the home but answered only after the restart began
- server-shared: clients starting at the same moment share one server
- server-refuse: a second server for the same home refuses to start, and says which home
- server-cannot-start: sigma exec whose server cannot come back says why once, and finishes once a server starts

## Gotchas

- A server started with `drive.ts r serve` also exits 30 s after it goes idle.
  Start it just before the journey needs it. A Claude run keeps it up for
  30 minutes: stop it with `drive.ts r rpc server/stop`.
- The idle exit is the one journey that waits on time; give `doctor` 40 s.
- `rpc server/stop` with a run still working waits for it, so the call times
  out after 5 s; start the stop once the run has ended.
- Run `sigma serve --restart &` in the shell, not in a tmux window; kill it
  by the pid `doctor` prints, or `rpc server/stop`.
