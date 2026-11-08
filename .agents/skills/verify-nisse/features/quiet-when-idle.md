# Quiet when idle

Nisse draws only when something changes. An open TUI with nothing happening,
and its server, use no CPU.

## Sub-features

- `idle-tui` keeps the TUI's CPU time flat while nothing changes.
- `idle-server` keeps the server's CPU time flat while no run works.
- `idle-closed` ends the TUI when its terminal closes, so nothing keeps the
  server from its idle exit.

## How to get to it (user POV)

- Leave the TUI open on a finished conversation.
- Close the terminal the TUI runs in.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`. Claude is then the fake that
  plays `models`, so the splash lists `● claude` with its account and the
  server's one probe of it runs before the measuring, not against a real
  `claude`. `evidence/fake-claude/log.ndjson` holds that single probe.

- **Settle.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen splash` (`● claude person@example.com · Claude Max`),
  `drive.ts r tui type hi`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'You said: hi'`, `drive.ts r tui wait READY`, and
  `drive.ts r tui screen settled`.
- **Measure.** Run `drive.ts r idle`. It reports each of the TUI's and the
  server's CPU time over 10 s and saves `idle.txt`. Both read `0.00s` or `0.01s`: a
  hundredth of a second is the measuring tick. `0.02s` or more, twice in a row,
  is a finding. Right after the answer the TUI or the server may read `0.02s`
  or `0.03s` once; run `idle` again. Measured with the default fake Claude: a
  first reading of `0.03s` and `0.02s`, then `0.01s` and `0.01s`, then
  `0.00s` and `0.01s`.
- **Close.** Run `drive.ts r doctor` and note the TUI's pid, then close its
  terminal with `tmux -L nisse-verify-r kill-server`. `drive.ts r doctor`
  shows no TUI, and within 3 s `ps -p <pid>` finds nothing. Within 40 s `doctor` shows
  `server   none running`; it was 30 s after the terminal closed.

## Gotchas

- Measure after the answer settles: the TUI may still be drawing the last
  frame right after `wait` returns, so save a screen first.
- tmux redraws its own client, not the TUI; it does not count against Nisse.
