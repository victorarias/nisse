# Ask and answer

A person types a prompt and Nisse answers under its own name. The words stream
in while Nisse works, and every client of the conversation sees the same
words and the same committed message. `nisse exec` does the same headless,
printing the answer and exiting 0, or 1 when the run fails.

## Sub-features

- `tui-hangup` closing the terminal ends `nisse` instead of leaving it running unseen.
- `answer-failed` a model failure is recorded after what was said, and the conversation goes idle.
- `answer-tui` sends a prompt from the TUI and shows it under `ADA` and the
  answer under `NISSE`.
- `answer-newline` [pending tui-views] adds a line to the prompt with `⇧⏎` or `⌥⏎` and sends all
  lines as one message with `⏎`.
- `answer-exec` prints the answer on stdout and exits 0.
- `answer-exec-fail` prints what was said, reports the failure on stderr and
  exits 1.
- `answer-wire` submits over the protocol and sees the user entry, live text,
  the `message` entry and the `run_end` entry as commits.
- `answer-shared` shows a run started in the TUI to a second client.
- `submit-author` names who wrote each prompt: the `author` of
  `conversation/submit` is on the prompt while it waits in the queue and on its
  entry once it runs, for every client.
- `answer-author` [pending tui-views] names the TUI's and `exec`'s messages after `USER`, or the
  system's user name when `USER` is not set.
- `answer-scroll` [pending tui-views] scrolls the transcript with the mouse wheel.

## How to get to it

### People

- Type in the TUI's `PROMPT` and press Enter; `⇧⏎` or `⌥⏎` starts a new line
  instead.
- Scroll the transcript with the mouse wheel.

### Agents

- Run `nisse exec '<prompt>'`.
- Call `conversation/submit` on the home's socket, naming its `author`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, so Nisse answers `You said: <prompt>`; for
  `answer-exec-fail`, a run whose script is
  `[{"text": "half an ", "fail": "provider went away"}]`.
- Claude is the `models` recording, so the splash lists
  `● claude person@example.com · Claude Max` and `○ openai signed out`; no run
  here starts a real Claude Code.

- **TUI.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'hello nisse'`, `drive.ts r tui screen typed`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'You said: hello nisse'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen answered`. The screen
  shows `ADA` over `hello nisse`, `NISSE` over `You said: hello nisse`, and
  `READY`.
- **New line.** In a fresh run, run `drive.ts r tui start`,
  `drive.ts r tui wait READY`, `drive.ts r tui type 'first line'`,
  `drive.ts r tui key S-Enter`, `drive.ts r tui type 'second line'`,
  `drive.ts r tui key M-Enter`, `drive.ts r tui type 'third line'`,
  `drive.ts r tui screen lines`: the `PROMPT` panel holds the three lines
  and nothing was sent. `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'You said: first line'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen sent`: `ADA` over the three lines and `NISSE` over
  `You said: first line`, `second line`, `third line`; `drive.ts r watch <id>`
  holds one `user` entry whose `text` is `first line\nsecond line\nthird line`.
  Then, in a fresh run, type `aa`, press `drive.ts r tui key C-j`, type
  `bb`: the panel holds two lines and nothing was sent. This fails today:
  `C-j` sends `aa` at once.
- **Scroll.** In a fresh run whose script is one `text` of 60 lines, `row1` to
  `row60` joined with `\n`, run `drive.ts r tui start`,
  `drive.ts r tui wait READY`, `drive.ts r tui type go`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait row60`, then three times
  `drive.ts r tui type $'\e[<64;10;10M'`, a wheel-up as the terminal sends it,
  and `drive.ts r tui wait --gone row60`: earlier rows show.
- **Shared.** With the TUI still open, run `drive.ts r rpc conversation/list`
  and take the conversation's `id`, then
  `drive.ts r watch <id> --save shared`. The snapshot holds the `user` entry,
  a `message` entry with `You said: hello nisse`, and a `run_end` entry with
  `"outcome": "answered"`.
- **Exec.** Run `drive.ts r nisse exec 'hello there'`. Exit 0, stdout
  `You said: hello there`, empty stderr.
- **Exec fails.** In the failing run, run `drive.ts r nisse exec go`. Exit 1,
  stdout `half an `, stderr `provider went away`.
- **Wire.** Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'` and take its `id`, then
  `drive.ts r watch <id> --submit 'tell me about the queue and the steering' --until run_end --save wire`.
  The lines show the submit reply, a commit with `enqueued`, a commit with the
  `user` entry and `"status": "working"`, commits whose `live` changes append
  text, a commit with the `message` entry, and a commit with the `run_end`
  entry and `"status": "idle"`.

## Contexts

- **On the kernel.** In a fresh run made with `drive.ts r up --kernel`, `drive.ts r nisse exec 'hello there'`
  prints `You said: hello there`, exit 0. With the `answer-exec-fail` script, `drive.ts r nisse exec go` prints
  `half an ` on stdout and `provider went away` on stderr, exit 1. A prompt `exec` queued behind another run that an
  interrupt withdraws ends `exec` with exit 1 and `the prompt was withdrawn before it ran, as an interrupt withdraws
what waits`.
- **Second client.** Every client sees the prompt and the same answer.
- **Server restart.** A run the crash cut off finishes when the server returns, as [Crash recovery](./crash-recovery.md) says.

## Tests

Kernel stack, `packages/nisse/test/kernel/stack.test.ts`, on a server under `NISSE_KERNEL=1`:

- mode-print, answer-exec, server-on-demand: nisse exec on the kernel starts a server, prints the answer and exits 0
- mode-print, answer-exec-fail: nisse exec on the kernel exits 1 and says why when the run fails
- answer-exec-fail: nisse exec on the kernel exits 1 when an interrupt withdraws its queued prompt, instead of waiting for good

Kernel wire, `packages/nisse/test/kernel/wire.test.ts`, on a server under `NISSE_KERNEL=1`:

- answer-wire, answer-shared: every client of a conversation sees the prompt, the answer and how the run ended
- answer-failed: a model failure is recorded after what was said and the conversation goes idle
- submit-author, queue-shared: every client sees who wrote each prompt, while it waits and once it runs

Wire, `packages/nisse/test/wire.test.ts`:

- answer-wire, answer-shared: every client of a conversation sees the prompt and the same answer
- answer-failed: a model failure is recorded after what was said and the conversation goes idle

Screen, `packages/nisse/test/screen.test.ts`:

- answer-tui: a person types a prompt, presses enter and reads the answer under their name

Stack, `packages/nisse/test/stack.test.ts`:

- answer-exec-fail: nisse exec exits 1 and reports the failure when the run fails
- answer-exec: nisse exec finishes when nisse answers with nothing

No committed test covers scrolling with the mouse wheel.

## Gotchas

- `drive.ts` sets `USER=ada`, which is why messages read `ADA`.
- tmux sends `⇧⏎` as `S-Enter` and `⌥⏎` as `M-Enter`; both add a line.
- `exec` starts a new conversation each time unless given
  `--conversation <id>`.
- `watch --until run_end` only looks at commits after the snapshot. To see a
  run that already ended, read the snapshot instead.
- Live text is committed at most every 100 ms. The echo of a prompt of two or
  three words finishes sooner and commits its `message` with no `live` text
  before it; a longer prompt, or a script with `delayMs`, shows live text
  arrive.
- A failed run ends with `"outcome": "failed"` and its `message`; the TUI
  shows it as `✗ <message>`.
