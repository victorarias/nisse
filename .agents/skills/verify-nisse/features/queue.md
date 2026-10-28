# Queue

A prompt sent while Nisse works does not interrupt it. It waits in a queue
that every client sees, and runs when the current run ends, in the order sent.

## Sub-features

- `queue-show` shows a waiting prompt as `queued · <text>` under `QUEUE`.
- `queue-run` runs it after the current answer and removes it from the queue.
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
  `drive.ts r tui wait QUEUE`, `drive.ts r tui type second`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'queued · second'`,
  `drive.ts r tui screen queued`. `WORKING`, the slow answer streaming, and
  `queued · second` under `QUEUE`.
- **Shared.** While it is queued, run `drive.ts r rpc conversation/list` and
  `drive.ts r watch <id> --save queued`. The snapshot's `queued` list holds
  `second`.
- **Runs in order.** Run `drive.ts r tui wait --timeout 20000 'fast reply'`,
  `drive.ts r tui wait --gone 'queued · second'`,
  `drive.ts r tui screen drained`. `slow one two three four five six seven eight` answers `first`,
  `fast reply` answers `second`, and the queue is empty.

## Gotchas

- The `QUEUE` panel only appears while Nisse works; wait for it before typing
  the second prompt.
- Each `drive.ts` call takes a few hundred milliseconds, so the first answer
  has to take seconds for the queued state to still be there when you look.
- A submission's `requestId` makes it idempotent: sending the same one twice
  over the wire queues it once.
