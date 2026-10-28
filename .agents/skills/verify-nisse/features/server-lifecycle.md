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

## How to get to it (user POV)

- Run `nisse exec` or open the TUI with no server running.
- Run `nisse serve`.
- Leave the home with no clients for 30 s.
- Call `server/stop`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script.

- **On demand.** Run `drive.ts r doctor`: `server none running`. Run
  `drive.ts r nisse exec hi`, then `drive.ts r doctor`: a server pid running
  this checkout's `main.ts serve`.
- **Refuse.** Run `drive.ts r nisse serve`. It exits at once, with exit code
  0, and stderr says `another server already serves /tmp/nisse-verify/r/home`.
- **Shared.** In a fresh run, start four at once:
  `for i in 1 2 3 4; do drive.ts r nisse exec "client $i" & done; wait`. Each
  prints its own `You said: client <i>`, and `doctor` shows one server.
- **Idle exit.** After the last `exec`, run `drive.ts r doctor` until it shows
  `none running`; it takes about 30 s. With a TUI open, the server stays.
- **Stop.** Run `drive.ts r serve`, then
  `drive.ts r rpc server/stop`, then `drive.ts r doctor`: `none running`.
  The call itself answers with an `Interrupt` error, because the server ends
  as it answers.

## Gotchas

- A server started with `drive.ts r serve` also exits 30 s after it goes idle.
  Start it just before the journey needs it.
- The idle exit is the one journey that waits on time; give `doctor` 40 s.
