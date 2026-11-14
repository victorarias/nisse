# Ask and answer

A person types a prompt and Sigma answers under its own name. The words stream
in while Sigma works, and every client of the conversation sees the same
words and the same committed message. `sigma exec` does the same headless,
printing the answer and exiting 0, or 1 when the run fails.

## Sub-features

- `tui-hangup` closing the terminal ends `sigma` instead of leaving it running unseen.
- `answer-failed` a model failure is recorded after what was said, and the conversation goes idle.
- `answer-tui` sends a prompt from the TUI and shows it under `ADA` and the
  answer under `SIGMA`.
- `answer-newline` adds a line to the prompt with `⇧⏎` or `⌥⏎` and sends all
  lines as one message with `⏎`.
- `answer-exec` prints the answer on stdout and exits 0. An exec too slow
  for the run, dropped with `FellBehind`, watches again and reads the entries
  it missed, so every call still prints.
- `answer-exec-fail` prints what was said, reports the failure on stderr and
  exits 1.
- `answer-wire` submits over the protocol and sees the `sigma.user` entry, live
  text, the `pi.assistant` entry and the `sigma.run_end` entry as changes.
- `answer-shared` shows a run started in the TUI to a second client.
- `submit-author` names who wrote each prompt: the `author`, `{id, name}`, of
  `conversation/submit` is on the prompt while it waits in the queue and on its
  entry once it runs, for every client.
- `answer-author` names the TUI's and `exec`'s messages after
  `SIGMA_AUTHOR_NAME`, else `USER`, or the system's user name when neither is
  set ([Authors](./authors.md)).
- `answer-scroll` scrolls the transcript with the mouse wheel.

## How to get to it

### People

- Type in the TUI's `PROMPT` and press Enter; `⇧⏎` or `⌥⏎` starts a new line
  instead.
- Scroll the transcript with the mouse wheel.

### Agents

- Run `sigma exec '<prompt>'`.
- Call `conversation/submit` on the home's socket, naming its `author`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, so Sigma answers `You said: <prompt>`; for
  `answer-exec-fail`, a run whose script is
  `[{"text": "half an ", "fail": "provider went away"}]`.
- Claude is the `models` recording, so the splash lists
  `● claude person@example.com · Claude Max` and `○ openai signed out`; no run
  here starts a real Claude Code.

- **TUI.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'hello sigma'`, `drive.ts r tui screen typed`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'You said: hello sigma'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen answered`. The screen
  shows `ADA` over `hello sigma`, `SIGMA` over `You said: hello sigma`, and
  `READY`.
- **New line.** In a fresh run, run `drive.ts r tui start`,
  `drive.ts r tui wait READY`, `drive.ts r tui type 'first line'`,
  `drive.ts r tui key M-Enter`, `drive.ts r tui type 'second line'`,
  `drive.ts r tui key M-Enter`, `drive.ts r tui type 'third line'`,
  `drive.ts r tui screen lines`: the `PROMPT` panel holds the three lines
  and nothing was sent. `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'You said: first line'`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen sent`: `ADA` over the three lines and `SIGMA` over
  `You said: first line`, `second line`, `third line`; `drive.ts r watch <id>`
  holds one `sigma.user` entry whose text is `first line\nsecond line\nthird line`.
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
  `drive.ts r watch <id> --save shared`. The first view's `entries` hold
  `sigma.user`, a `pi.assistant` with `You said: hello sigma`, and a
  `sigma.run_end` with `"outcome": "answered"`.
- **Exec.** Run `drive.ts r sigma exec 'hello there'`. Exit 0, stdout
  `You said: hello there`, empty stderr.
- **Exec fails.** In the failing run, run `drive.ts r sigma exec go`. Exit 1,
  stdout `half an `, stderr `provider went away`. A prompt `exec` queued
  behind another run that an interrupt withdraws ends `exec` with exit 1 and
  `the prompt was withdrawn before it ran`.
  `exec` learns this, and every other way its prompt ends, from the entries
  committed under its `requestId` (`sigma.user`, then that run's
  `sigma.run_end`, or `sigma.withdrawn`), also after it watches again.
- **Wire.** Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp"}'` and take its `id`, then
  `drive.ts r watch <id> --submit 'tell me about the queue and the steering' --until run_end --save wire`.
  The lines show the view, then the submit reply and one `change` per commit:
  `sigma.user` spliced into `entries`, live words as `"a"` ops on
  `docs.pi.live.generation.message`, then `pi.assistant` and `sigma.run_end`.
  The reply and the `sigma.user` change come in either order.

## Contexts

- **Second client.** Every client sees the prompt and the same answer.
- **Server restart.** A run the crash cut off finishes when the server returns, as [Crash recovery](./crash-recovery.md) says.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- answer-wire, answer-shared: every client of a conversation sees the prompt, the answer and how the run ended
- answer-failed: a model failure is recorded after what was said and the conversation goes idle
- submit-author, queue-shared: every client sees who wrote each prompt, while it waits and once it runs

Screen, `packages/sigma/test/screen.test.ts`:

- answer-tui, answer-author: a person types a prompt, presses enter and reads the answer under their name
- answer-author: without USER the TUI names a person's message after the system's user name
- answer-newline: alt+enter adds a line to the prompt, and enter sends every line as one message
- tui-hangup, idle-closed: closing the terminal ends sigma instead of leaving it running unseen
- answer-scroll, tui-load-earlier: a conversation longer than the window scrolls back to its first message, loading earlier entries on the way, and a reconnect leaves no gap

Stack, `packages/sigma/test/stack.test.ts`:

- mode-print, answer-exec, server-on-demand: sigma exec starts a server, prints the answer and exits 0
- mode-print, answer-exec-fail: sigma exec exits 1 and says why when the run fails
- answer-exec-fail: sigma exec exits 1 when an interrupt withdraws its queued prompt, instead of waiting for good
- answer-exec: sigma exec whose prompt waits behind a run that fails prints its answer, instead of waiting for good
- answer-exec, wire-dropped: a sigma exec whose prompt waits, runs and ends while exec is dropped still prints the answer and exits 0
- answer-exec-fail: sigma exec exits 1 when one interrupt withdraws its prompt among more than its window holds
- answer-exec-fail, wire-dropped: a sigma exec dropped while an interrupt withdraws its queued prompt exits 1 and says so
- answer-exec, wire-dropped: a sigma exec dropped while an earlier prompt runs prints only its own answer
- answer-exec, wire-dropped: a sigma exec too slow for the run watches again when dropped, prints every call it missed, and exits 0

## Gotchas

- `drive.ts` sets `USER=ada`, which is why messages read `ADA`.
- tmux sends `⌥⏎` as `M-Enter`, which adds a line. It sends `S-Enter` as a plain Enter, so in `drive.ts` it sends
  the message; a terminal that reports shifted keys, such as one speaking the kitty keyboard protocol, tells them apart.
- `exec` starts a new conversation each time unless given
  `--conversation <id>`.
- `watch --until run_end` only looks at changes after the first view. To see a
  run that already ended, read the first view instead.
- Live text is committed at most every 100 ms. The echo of a prompt of two or
  three words finishes sooner and commits its `pi.assistant` with no live text
  before it; a longer prompt, or a script with `delayMs`, shows live text
  arrive.
- A failed run ends with a `sigma.run_end` of `"outcome": "failed"` and its `message`; the TUI
  shows it as `✗ <message>`.
