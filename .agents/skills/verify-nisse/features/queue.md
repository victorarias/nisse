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
- **Shared.** While it is queued, run `drive.ts r rpc conversation/list` and
  `drive.ts r watch <id> --save queued`. The snapshot's `queued` list holds
  `second` with `"steer": false`.
- **Runs in order.** Run `drive.ts r tui wait --timeout 20000 'fast reply'`,
  `drive.ts r tui wait --gone 'queued · second'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen drained`.
  `slow one two three four five six seven eight` answers `first`,
  `fast reply` answers `second`, and the queue is empty. A `watch <id>` shows
  the `run_end` of `first` before the `user` entry of `second`.

## Gotchas

- The prompt panel reads `PROMPT` while Nisse is ready and `QUEUE · tab` while
  it works; wait for `QUEUE · tab` before typing the second prompt. `Tab`
  switches it to steering, which is a different feature.
- Each `drive.ts` call takes a few hundred milliseconds, so the first answer
  has to take seconds for the queued state to still be there when you look.
- A submission's `requestId` makes it idempotent: sending the same one twice
  over the wire queues it once.
