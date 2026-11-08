# Server lifecycle

One server serves a home, shared by every client. The first client to need it
starts it, clients starting at the same moment share it, a second server for
the same home refuses to start, and the server exits 30 s after its last
client leaves and its last run settles.

## Sub-features

- `server-on-demand` starts a server for the first `exec` or TUI.
- `server-shared` lets clients that start together share one server.
- `server-refuse` makes `nisse serve` refuse a home that already has a server.
- `server-idle-exit` exits the server 30 s after it goes idle.
- `server-stop` stops it on `server/stop` once its runs settle.
- `server-restart` replaces the running server with `nisse serve --restart`
  once its runs settle.

## How to get to it

### People

- Run `nisse exec` or open the TUI with no server running.
- Run `nisse serve`.
- Run `nisse serve --restart` to replace the running server once its runs settle.

### Agents

- Call `server/stop`.

### Triggers

- The home has no clients and no running run for 30 s.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script.

- **On demand.** Run `drive.ts r doctor`: `server none running`. Run
  `drive.ts r nisse exec hi`, then `drive.ts r doctor`: a server pid running
  this checkout's `main.ts serve`.
- **Refuse.** Run `drive.ts r nisse serve`. It exits at once, with exit code
  1, and stderr says `another server already serves /tmp/nisse-verify/r/home`.
- **Shared.** In a fresh run, start four at once:
  `for i in 1 2 3 4; do drive.ts r nisse exec "client $i" & done; wait`. Each
  prints its own `You said: client <i>`, and `doctor` shows one server.
- **Idle exit.** After the last `exec`, run `drive.ts r doctor` until it shows
  `none running`; it takes about 30 s. With a TUI open, the server stays.
- **Stop.** Run `drive.ts r serve`, then
  `drive.ts r rpc server/stop`, then `drive.ts r doctor`: `none running`.
  The call answers with a `null` result before the server ends.
- **Restart.** Run `drive.ts r serve` and note its pid, then
  `drive.ts r tui start serve --restart`, `drive.ts r tui wait serving`, and
  `drive.ts r doctor`: a new pid running `main.ts serve --restart`.
  `drive.ts r tui stop` stops it.

## Contexts

- **Running work.** `serve --restart` and `server/stop` wait for runs to settle.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- the server exits once no client is connected and nothing is running
- stopping the server answers the caller, then the server exits

Stack, `packages/nisse/test/stack.test.ts`:

- nisse exec starts a server when none runs, prints the answer and exits 0
- a home the Rust version used still works and keeps its database
- clients starting at the same moment share one server
- nisse exec says why the server it started could not run
- a second server for the same home refuses to start

## Gotchas

- A server started with `drive.ts r serve` also exits 30 s after it goes idle.
  Start it just before the journey needs it.
- The idle exit is the one journey that waits on time; give `doctor` 40 s.
