# Quiet when idle

Nisse draws only when something changes. An open TUI with nothing happening,
and its server, use no CPU.

## Sub-features

- `idle-tui` keeps the TUI's CPU time flat while nothing changes.
- `idle-server` keeps the server's CPU time flat while no run works.

## How to get to it (user POV)

- Leave the TUI open on a finished conversation.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script.

- **Settle.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type hi`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'You said: hi'`, `drive.ts r tui wait READY`, and
  `drive.ts r tui screen settled`.
- **Measure.** Run `drive.ts r idle`. It reports each of the TUI's and the
  server's CPU time over 10 s and saves `idle.txt`. Both read `0.00s`; a
  hundredth of a second is the measuring tick, more is a finding.

## Gotchas

- Measure after the answer settles: the TUI may still be drawing the last
  frame right after `wait` returns, so save a screen first.
- tmux redraws its own client, not the TUI; it does not count against Nisse.
