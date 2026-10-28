# Ask and answer

A person types a prompt and Nisse answers under its own name. The words stream
in while Nisse works, and every client of the conversation sees the same
words and the same answer. `nisse exec` does the same headless, printing the
answer and exiting 0, or 1 when the run fails.

## Sub-features

- `answer-tui` sends a prompt from the TUI and shows it under `ADA` and the
  answer under `NISSE`.
- `answer-exec` prints the answer on stdout and exits 0.
- `answer-exec-fail` prints what was said, reports the failure on stderr and
  exits 1.
- `answer-wire` submits over the protocol and sees the user entry, live text
  and the answer entry as commits.
- `answer-shared` shows a run started in the TUI to a second client.

## How to get to it (user POV)

- Type in the TUI's `PROMPT` and press Enter.
- Run `nisse exec '<prompt>'`.
- Call `conversation/submit` on the home's socket.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, so Nisse answers `You said: <prompt>`; for
  `answer-exec-fail`, a run whose script is
  `[{"text": "half an ", "fail": "provider went away"}]`.

- **TUI.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'hello nisse'`, `drive.ts r tui screen typed`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'You said: hello nisse'`,
  `drive.ts r tui screen answered`. The screen shows `ADA` over `hello nisse`,
  `NISSE` over `You said: hello nisse`, and `READY`.
- **Shared.** With the TUI still open, run `drive.ts r rpc conversation/list`
  and take the conversation's `id`, then
  `drive.ts r watch <id> --save shared`. The snapshot holds the user entry
  and the `answer` entry with `"interrupted": false`.
- **Exec.** Run `drive.ts r nisse exec 'hello there'`. Exit 0, stdout
  `You said: hello there`, empty stderr.
- **Exec fails.** In the failing run, run `drive.ts r nisse exec go`. Exit 1,
  stdout `half an `, stderr contains `provider went away`.
- **Wire.** Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'` and take its `id`, then
  `drive.ts r watch <id> --submit 'hi there' --until answer --save wire`. The
  lines show the submit reply, a commit with `enqueued`, a commit with the
  `user` entry, one or more commits with `live` text, and a commit with the
  `answer` entry.

## Gotchas

- `exec` starts a new conversation each time unless given
  `--conversation <id>`.
- `watch --until answer` only looks at commits after the snapshot. To see an
  answer that already exists, read the snapshot instead.
- The echo answers in one live commit; use a script with `delayMs` to see
  live text arrive word by word.
