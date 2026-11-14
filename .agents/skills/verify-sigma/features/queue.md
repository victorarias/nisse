# Queue

A prompt sent while Sigma works does not interrupt it. It waits in a queue
that every client sees, and runs as its own run when the current one ends, in
the order sent.

## Sub-features

- `queue-show` shows a waiting prompt as `queued · <text>` while the prompt
  panel is titled `QUEUE · tab`.
- `queue-run` runs it after the current run ends, answered or failed, and
  removes it from the queue. A run whose task faults on a bug withdraws the
  prompts queued behind it instead, each marked `sigma.withdrawn`.
- `queue-shared` shows the queue to a second client.
- `queue-idempotent` queues a submission once however often its `requestId`
  is sent.

## How to get to it

### People

- Type and press Enter in the TUI while it shows `WORKING` and the panel reads `QUEUE · tab`.

### Agents

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
  view's `docs.pi.inbox.items` holds `second` with `"mode": "followUp"`, and
  `docs.pi.live.run` is set while the run works. `conversation/list` does not
  show the queue.
- **Runs in order.** Run `drive.ts r tui wait --timeout 20000 'fast reply'`,
  `drive.ts r tui wait --gone 'queued · second'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen drained`. On the screen
  `slow one two three four five six seven eight` answers `first`,
  `fast reply` answers `second`, and the queue is empty. A second `watch <id> --save after` shows the `sigma.run_end` of `first` before the
  `sigma.user` entry of `second`, and `conversation/list` shows the
  conversation's `ended` as `answered` with `said` `fast reply`.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp"}'`,
  and run
  `drive.ts r watch <id> --submit first --until run_end --timeout 25000 --save wire &`.
  While `first` streams, send `second` twice with the same `requestId` and
  `third` once, each as
  `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "q-1", "author": {"id": "bo", "name": "bo"}, "text": "second"}'`
  (`q-2` and `third` for the last). The two `q-1` calls answer with the same
  `submission`. A `drive.ts r watch <id>` while `first` still streams has
  `docs.pi.inbox.items` of `second` then `third`, both `"mode": "followUp"`,
  each carrying a `sigma.user` entry with `{"author": {"id": "bo", "name": "bo"}}`. Once the runs
  settle, a fresh `watch <id>` shows `sigma.user` `first`, `pi.assistant`
  `slow one two three four five six seven eight`, `sigma.run_end`, `sigma.user`
  `second`, `pi.assistant` `fast reply`, `sigma.run_end`, `sigma.user` `third`,
  `pi.assistant` `You said: third` (the script has run out, so Sigma echoes)
  and `sigma.run_end`: `second` once, and an empty inbox.

- **After a failure.** In a fresh run whose script is
  `[{"text": "one two three four five six seven eight", "delayMs": 1000, "fail": "provider went away"}, {"text": "fast reply"}]`,
  queue `second` behind `first` in the TUI as in **Queue a prompt**, then run
  `drive.ts r tui wait --timeout 20000 'fast reply'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen after-failure`. The screen shows the failed run's
  `provider went away`, then `fast reply` answering `second`, and the queue is
  empty.

## Contexts

- **Second client.** The queue shows to every client.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- queue-idempotent: submitting again with the same request id is answered once
- queue-run: prompts sent while sigma is working wait and run in order, each to its own end
- queue-run: a prompt sent while sigma works runs after the run fails, instead of waiting for another prompt
- queue-run, interrupt-withdraw: a prompt sent after an interrupt, while the run still stops, runs once it stopped
- submit-author, queue-shared: every client sees who wrote each prompt, while it waits and once it runs

Screen, `packages/sigma/test/screen.test.ts`:

- queue-show: a prompt sent while sigma works waits in the queue, then runs

Package, `packages/harness/test/harness.test.ts` (no wire test can make a run task fault):

- queue-run: an input queued behind a run whose task faults is withdrawn, unless afterFailedRun keeps it

Provider, `packages/sigma/test/claude.test.ts`:

- queue-run: a prompt sent while Claude works runs once Claude answers, resuming the same session

## Gotchas

- Replace `r` in the commands with your run id.
- A scripted run needs no account: Claude is a fake that is signed in, so the
  splash and `providers/list` show it ready.
- The prompt panel reads `PROMPT` while Sigma is ready and, while it works,
  `QUEUE · tab`, or `STEER · tab` if `Tab` switched this TUI to steering
  earlier: the switch lasts across runs until `Tab` is pressed again. Wait for
  `QUEUE · tab` before typing the second prompt. Steering is a different
  feature. No committed test covers the switch lasting across runs.
- Each `drive.ts` call takes a few hundred milliseconds, so the first answer
  has to take seconds for the queued state to still be there when you look.
