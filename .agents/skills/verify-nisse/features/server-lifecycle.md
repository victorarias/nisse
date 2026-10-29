# Server lifecycle

One server serves a home, shared by every client. The first client to need it
starts it, clients starting at the same moment share it, a second server for
the same home refuses to start, and the server exits 30 s after its last
client leaves and its last run settles. `nisse serve --restart` replaces a
running server once its runs settle, and `nisse schema` prints the protocol's
JSON Schema.

## Sub-features

- `server-on-demand` starts a server for the first `exec` or TUI.
- `server-shared` lets clients that start together share one server.
- `server-refuse` makes `nisse serve` refuse a home that already has a server.
- `server-idle-exit` exits the server 30 s after its last client leaves.
- `server-stop` stops it on `server/stop` once its runs settle.
- `server-restart` replaces the server with `nisse serve --restart` once its
  runs settle.
- `schema-print` prints the protocol's JSON Schema with `nisse schema`.

## How to get to it (user POV)

- Run `nisse exec` or open the TUI with no server running.
- Run `nisse serve`, or `nisse serve --restart` to replace a running server.
- Leave the home with no clients for 30 s.
- Call `server/stop`.
- Run `nisse schema`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`, which also gives the run a
  signed-in fake Claude; `Restart waits for runs` adds the script it names.

- **On demand.** Run `drive.ts r doctor`: `server none running`. Run
  `drive.ts r nisse exec hi`, then `drive.ts r doctor`: a server pid running
  this checkout's `main.ts serve`.
- **Refuse.** Run `drive.ts r nisse serve`. The saved output shows `--- exit 1`
  at once, and stderr says `another server already serves /tmp/nisse-verify/r/home`.
- **Shared.** In a fresh run, start four at once:
  `for i in 1 2 3 4; do drive.ts r nisse exec "client $i" & done; wait`. Each
  prints its own `You said: client <i>`, and `doctor` shows one server.
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
- **Restart waits for runs.** In a run whose script is
  `[{"text": "starting", "tool": {"name": "Bash", "input": {"command": "sleep 8; echo woke"}}}, {"text": "finished"}]`,
  run `drive.ts r serve`, `drive.ts r tui start --auto`,
  `drive.ts r tui wait READY`, `drive.ts r tui type go`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'sleep 8'`, then
  `drive.ts r nisse serve --restart &` and `doctor` as above: the pid does not
  change until the call has run, about 8 s. Then `drive.ts r tui wait finished`
  and `drive.ts r tui wait READY` show the finished run, and
  `drive.ts r watch <id>` from a new connection shows `tool_result` `woke`,
  `message` `finished` and one `run_end` with `"outcome": "answered"`.
  This step fails today: the server is replaced, `watch` shows the whole run
  committed, but the open TUI stays `WORKING` with no call output for good.
  `nisse exec --auto go` in place of the TUI never exits either, and
  `rpc server/stop` in place of `--restart` finishes the TUI as it should.
- **Schema.** Run `drive.ts r nisse schema`. Exit 0 and no server started
  (`doctor` still shows `none running`); the saved stdout, between `--- stdout`
  and `--- stderr`, is the same text as `schema/nisse.schema.json`, whose
  `"protocol"` matches the `protocol` that `doctor` prints once a server runs.

## Gotchas

- A server started with `drive.ts r serve` also exits 30 s after it goes idle.
  Start it just before the journey needs it.
- The idle exit is the one journey that waits on time; give `doctor` 40 s.
- `rpc server/stop` with a run still working waits for it, so the call times
  out after 5 s; start the stop once the run has ended.
- Run `nisse serve --restart &` in the shell, not in a tmux window; kill it
  by the pid `doctor` prints, or `rpc server/stop`.
