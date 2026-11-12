# Server lifecycle

One server serves a home, shared by every client. The first client to need it
starts it, clients starting at the same moment share it, a second server for
the same home refuses to start, and the server exits 30 s after its last
watch closes and its last run settles. `nisse serve --restart` replaces a
running server once its runs settle.

## Sub-features

- `server-on-demand` starts a server for the first `exec` or TUI.
- `server-shared` lets clients that start together share one server.
- `server-refuse` makes `nisse serve` refuse a home that already has a server.
- `server-idle-exit` exits the server 30 s after its last watch closes
  and its last run settles.
- `server-cannot-start` shows a waiting client why the home's server refuses
  to start, such as a `config.toml` that does not read: on the TUI's status
  line, and on `exec`'s stderr. The client starts the next server a second
  after each refusal, and carries on once one starts.
- `server-stop` stops it on `server/stop` once its runs settle.
- `server-restart` replaces the running server with `nisse serve --restart`
  once its runs settle.
- `server-old-home` keeps working in a home an earlier Nisse used: its
  older databases, such as `nisse.sqlite`, stay as they were, and this Nisse uses
  `kernel.sqlite` beside them.

## How to get to it

### People

- Run `nisse exec` or open the TUI with no server running.
- Run `nisse serve`.
- Run `nisse serve --restart` to replace the running server once its runs settle.

### Agents

- Call `server/stop`.

### Triggers

- The home has no open `conversation/watch`, `status/watch` or `auth/watch` stream and no running run for 30 s. A connection making only single calls does not keep the server alive.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`, which also gives the run a
  signed-in fake Claude; `Restart waits for runs` adds the script it names.

- **On demand.** Run `drive.ts r doctor`: `server none running`. Run
  `drive.ts r nisse exec hi`, then `drive.ts r doctor`: a server pid running
  this checkout's `main.ts serve`.
- **Refuse.** Run `drive.ts r nisse serve`. The saved output shows `--- exit 75`
  about a second later (a starting server waits up to 1 s for a moment's
  contention on the home lock to pass), and stderr says
  `another server already serves /tmp/nisse-verify/r/home`.
- **Shared.** In a fresh run, start eight at once:
  `for i in 1 2 3 4 5 6 7 8; do drive.ts r nisse exec "client $i" & done; wait`.
  The run's evidence holds eight `NNN-nisse.txt` files, each with its own
  `You said: client <i>` and `--- exit 0`, and `doctor` shows one server.
- **Idle exit.** Run `drive.ts r nisse exec hi`; the `steps.log` line
  `saved ...-nisse.txt` is when the last client left. Run `drive.ts r doctor`
  once a second until it shows `none running`, and read the time from
  `date`. The server was gone 30 s to 31 s after that line; less than 30 s is
  a finding. With a TUI open the server stays: `drive.ts r tui start`,
  `tui wait READY`, wait 40 s, and `doctor` still shows the server and
  `tui running`. After `drive.ts r tui key C-c`, it is gone 30 s later.
- **Stop.** Run `drive.ts r serve`, then
  `drive.ts r rpc server/stop`, then `drive.ts r doctor`: `none running`.
  The call answers with a `null` result before the server ends.
- **Restart.** Run `drive.ts r serve` and note the pid, then
  `drive.ts r nisse serve --restart &`. `nisse` runs the new server in the
  foreground, so the command keeps going. Run `drive.ts r doctor` until the
  server pid is a different one (it may show `none running` for an instant), whose command line ends in
  `main.ts serve --restart`. Then stop it with
  `drive.ts r rpc server/stop`; the `--restart` command ends with exit 0 and
  stderr `nisse 0.1.0 serving /tmp/nisse-verify/r/home`.
- **Restart under an open TUI.** Run `drive.ts r tui start --conversation talk`,
  `drive.ts r tui wait READY`, send `one` and wait for `You said: one`. Run
  `drive.ts r serve --restart`, then type `two` and `Enter`:
  `drive.ts r tui wait 'You said: two'`. The TUI watches the new server and
  draws what it answers. Repeat `drive.ts r serve --restart`, adding
  `--read-only` every other time: each prints `serving` and the TUI shows
  `READ ONLY` or `PROMPT` to match.
- **Cannot start.** Run `drive.ts r serve`, `drive.ts r tui start` and
  `drive.ts r tui wait READY`. Write `[extensions.guard` to
  `/tmp/nisse-verify/r/home/config.toml`, run `drive.ts r kill-server`, then
  `drive.ts r tui wait 'cannot start'`: above the prompt, `✗ nisse's server
cannot start: .../config.toml: TOML Parse error ...`. Count
  `TOML Parse error` lines in the home's `nisse.log` twice, 5 s apart: about
  four more, one start a second. Delete `config.toml`: the line goes, and a
  prompt typed then is answered. For `exec`, use a script whose answer has
  `"delayMs": 300`, run `drive.ts r nisse exec count &`, and break the config
  and kill the server a second later: the saved output's stderr has the same
  line once, and once the config is deleted it prints the answer and exits 0.
- **Restart waits for runs.** In a run whose script is
  `[{"text": "one two three four five six seven eight", "delayMs": 300}]`,
  run `drive.ts r serve`, then `drive.ts r nisse exec count &` and, a second
  later, `drive.ts r nisse serve --restart &`. The `exec` prints
  `one two three four five six seven eight` and exits 0, and `doctor` then
  shows a new server pid whose command ends in `main.ts serve --restart`: the
  old server let the run answer first, and the client was not left waiting.

## Contexts

- **Running work.** `serve --restart` and `server/stop` wait for runs to settle.
- **Open clients.** A stop ends every open call and watch the way a lost connection does, so an open TUI watches the next server. A client that loses its server starts one, and while `serve --restart` replaces the server, the one the client started gives way (`another server already serves` in the home's `nisse.log`), so the restart always becomes the home's server.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- server-idle-exit: the server exits once no client is connected and nothing is running
- server-idle-exit: a submission's run keeps the server up after its client leaves, past the idle grace
- server-idle-exit, child-tools: a subagent's work keeps the server up after its client leaves, past the idle grace
- server-stop, child-tools: stopping the server lets a working subagent finish and report first
- server-stop: stopping the server answers the caller, then the server exits
- server-stop: stopping the server while nisse answers lets the answer finish first

Screen, `packages/nisse/test/screen.test.ts`:

- server-restart, serve-read-only: an open TUI keeps drawing while nisse serve --restart replaces its server, read-only and back
- server-cannot-start: an open TUI whose server cannot start shows why, starts one at most once a second, and carries on once it can

Stack, `packages/nisse/test/stack.test.ts`:

- server-stop: nisse serve answers server/stop, then exits 0
- server-old-home: a home an earlier nisse used still starts, and its old stores are left as they were
- mode-print, answer-exec, server-on-demand: nisse exec starts a server, prints the answer and exits 0
- server-restart: nisse serve --restart replaces the running server once its run settles
- server-shared: clients starting at the same moment share one server
- server-refuse: a second server for the same home refuses to start, and says which home
- server-cannot-start: nisse exec whose server cannot come back says why once, and finishes once a server starts

## Gotchas

- A server started with `drive.ts r serve` also exits 30 s after it goes idle.
  Start it just before the journey needs it.
- `server-old-home` is covered by its stack test only: making a Rust home by
  hand is not a user path `drive.ts` can drive.
- The idle exit is the one journey that waits on time; give `doctor` 40 s.
- `rpc server/stop` with a run still working waits for it, so the call times
  out after 5 s; start the stop once the run has ended.
- Run `nisse serve --restart &` in the shell, not in a tmux window; kill it
  by the pid `doctor` prints, or `rpc server/stop`.
