# Queue

A prompt sent while Nisse works does not interrupt it. It waits in a queue
that every client sees, and runs as its own run when the current one ends, in
the order sent.

## Sub-features

- `queue-show` shows a waiting prompt as `queued · <text>` while the prompt
  panel is titled `QUEUE · tab`.
- `queue-run` runs it after the current run ends and removes it from the
  queue.
- `queue-shared` shows the queue to a second client.
- `queue-idempotent` queues a submission once however often its `requestId`
  is sent.

## How to get to it (user POV)

- Type and press Enter in the TUI while it shows `WORKING`.
- Call `conversation/submit` while a run works.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "slow one two three four five six seven eight", "delayMs": 1000}, {"text": "fast reply"}]`.

- **Queue a prompt.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type first`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'QUEUE · tab'`, `drive.ts r tui type second`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'queued · second'`,
  `drive.ts r tui screen queued`. `WORKING`, the slow answer streaming, and
  `queued · second` above the `QUEUE · tab` panel.
- **Shared.** While it is queued, run `drive.ts r rpc conversation/list` for
  the conversation's `<id>`, then `drive.ts r watch <id> --save queued`. The
  snapshot's `queued` list holds `second` with `"steer": false`; `status` is
  `working`. `conversation/list` does not show the queue.
- **Runs in order.** Run `drive.ts r tui wait --timeout 20000 'fast reply'`,
  `drive.ts r tui wait --gone 'queued · second'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen drained`. On the screen
  `slow one two three four five six seven eight` answers `first`,
  `fast reply` answers `second`, and the queue is empty. A second `watch <id> --save after` shows the `run_end` of `first` before the
  `user` entry of `second`, and the conversation's `ended` says `answered`
  with `said` `fast reply`.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'`,
  and run
  `drive.ts r watch <id> --submit first --until run_end --timeout 25000 --save wire &`.
  While `first` streams, send `second` twice with the same `requestId` and
  `third` once, each as
  `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "q-1", "author": "bo", "text": "second"}'`
  (`q-2` and `third` for the last). The two `q-1` calls answer with the same
  `submission`. A `drive.ts r watch <id>` while `first` still streams has a
  `queued` list of `second` then `third`, both `"steer": false` and authored
  `bo`. Once the runs settle, a fresh `watch <id>` shows `user` `first`,
  `message` `slow one two three four five six seven eight`, `run_end`, `user`
  `second`, `message` `fast reply`, `run_end`, `user` `third`, `message`
  `You said: third` (the script has run out, so Nisse echoes) and `run_end`:
  `second` once, and an empty queue.

## Gotchas

- Replace `r` in the commands with your run id.
- A scripted run needs no account: Claude is a fake that is signed in, so the
  splash and `providers/list` show it ready.
- The prompt panel reads `PROMPT` while Nisse is ready and `QUEUE · tab` while
  it works; wait for `QUEUE · tab` before typing the second prompt. `Tab`
  switches it to steering, which is a different feature.
- Each `drive.ts` call takes a few hundred milliseconds, so the first answer
  has to take seconds for the queued state to still be there when you look.
