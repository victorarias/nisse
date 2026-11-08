# Interrupt

A person stops Nisse mid-answer. The words said so far stay in the transcript,
the run ends interrupted, and Nisse is ready for the next prompt. Any client
can interrupt any conversation's run.

## Sub-features

- `interrupt-tui` stops the run with `Esc`.
- `interrupt-wire` stops it with `conversation/interrupt` from another client.

## How to get to it (user POV)

- Press `Esc` in the TUI while it shows `WORKING`.
- Call `conversation/interrupt` with the conversation's id.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "one two three four five six seven eight nine ten", "delayMs": 300}]`.

- **Escape.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type count`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait three`, `drive.ts r tui key Escape`,
  `drive.ts r tui wait interrupted`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen interrupted`. The answer stops before `ten`, followed
  by `◆ interrupted`.
- **Committed.** Run `drive.ts r rpc conversation/list`, then
  `drive.ts r watch <id> --save interrupted`. The snapshot holds a `message`
  entry whose text ends before `ten`, then a `run_end` entry with
  `"outcome": "interrupted"`.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `rpc conversation/start '{"cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit count --until run_end --save wire &` in the
  background. Once its output shows a commit whose `live` holds a `text`
  change, run
  `drive.ts r rpc conversation/interrupt '{"conversation": "<id>"}'`. It
  answers with a `null` result, and the watch ends with the partial `message`
  and a `run_end` with `"outcome": "interrupted"` in one commit.

## Gotchas

- `Esc` only interrupts while the TUI shows `WORKING` or `WAITING`; once
  `READY`, it does nothing.
- Where the words stop depends on timing: the committed `message` ends after
  some number of words, always before `ten`.
- With the default 30 ms echo, the run ends before you can press anything.
  Interrupt needs a script with `delayMs`.
