# Steering

A person redirects Nisse mid-run without stopping it. While Nisse works, `Tab`
switches the prompt from queueing to steering; a steering prompt shows as
`steering · <text>` and reaches the model at its next step, inside the same
run, instead of waiting for the run to end.

## Sub-features

- `steer-toggle` switches the prompt panel between `QUEUE · tab` and
  `STEER · tab` with `Tab` while Nisse works.
- `steer-show` shows a waiting steer as `steering · <text>`, to every client.
- `steer-place` places the steer after the step that was running and goes on
  in the same run.
- `steer-wire` steers with `conversation/submit` and `"steer": true`.

## How to get to it (user POV)

- Press `Tab` in the TUI while it shows `WORKING`, type, and press Enter.
- Call `conversation/submit` with `"steer": true` while a run works.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "slow one two three four five six seven eight", "delayMs": 500, "tool": {"name": "Read", "input": {"file_path": "/etc/hostname"}}}, {"text": "steered reply"}]`.

- **Steer.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type first`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'QUEUE · tab'`, `drive.ts r tui key Tab`,
  `drive.ts r tui wait 'STEER · tab'`, `drive.ts r tui type 'go left'`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'steering · go left'`,
  `drive.ts r tui screen steering`. `WORKING`, the slow text streaming,
  `steering · go left`, and the `STEER · tab` panel.
- **Placed.** Run `drive.ts r tui wait --timeout 20000 'steered reply'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen steered`. Under `NISSE`
  the slow text and `▸ Read(/etc/hostname)`, then `ADA` over `go left`, then
  `NISSE` over `steered reply`.
- **Committed.** Run `drive.ts r rpc conversation/list` and
  `drive.ts r watch <id> --save steered`. The snapshot's entries run `user`
  `first`, `message`, `tool_call`, `tool_result`, `user` `go left`,
  `message` `steered reply`, and one `run_end`: one run, not two.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `rpc conversation/start '{"cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit first --until run_end --timeout 20000 --save wire &`.
  Once a commit's `live` holds a `text` change, run
  `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "steer-1", "author": "bo", "text": "go left", "steer": true}'`.
  The watch shows an `enqueued` commit with `"steer": true`, then the same
  entries as above, ending in one `run_end`.

## Gotchas

- A steer is placed when the model takes its next step, after the running
  call. A run that ends before then runs the steer next, like a queued
  prompt.
- `Tab` does nothing while Nisse is ready; the panel then reads `PROMPT`.
