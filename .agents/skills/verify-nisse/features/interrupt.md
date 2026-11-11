# Interrupt

A person stops Nisse mid-answer. The words said so far stay in the transcript,
the run ends interrupted, and Nisse is ready for the next prompt. Any client
can interrupt any conversation's run.

## Sub-features

- `interrupt-tui` stops the run with `Esc`.
- `interrupt-wire` stops it with `conversation/interrupt` from another client.

## How to get to it

### People

- Press `Esc` in the TUI while it shows `WORKING`.

### Agents

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
  `drive.ts r watch <id> --save interrupted`. The view holds a `pi.assistant`
  entry whose text ends before `ten`, with `"stopReason": "aborted"`, then a
  `nisse.run_end` entry with `"outcome": "interrupted"`.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `rpc conversation/start '{"cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit count --until run_end --save wire &` in the
  background. Once its output holds a live word such as `"two "`, run
  `drive.ts r rpc conversation/interrupt '{"conversation": "<id>"}'`. The
  watch ends on a `pi.assistant` entry with what was said and
  `"stopReason": "aborted"`, then `nisse.run_end` with
  `{"outcome": "interrupted", "message": "aborted"}`.

## Contexts

- **Second client.** Any client can interrupt, and every client sees the run end `interrupted`.
- **Subagents.** Stopping a run stops every subagent under it. `Esc` in a subagent's own conversation stops it and any subagent under it, not its parent.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- interrupt-wire: interrupting keeps what nisse already said and marks the run interrupted

Screen, `packages/nisse/test/screen.test.ts`:

- interrupt-tui: escape stops nisse mid-answer and the answer shows it was interrupted

Provider, `packages/nisse/test/openai.test.ts`:

- interrupt-wire: a ChatGPT answer streams live, and interrupting it closes the request and keeps what was said

## Gotchas

- `Esc` only interrupts while the TUI shows `WORKING` or `WAITING`; once
  `READY`, it does nothing.
- Where the words stop depends on timing: the committed `pi.assistant` ends after
  some number of words, always before `ten`.
- With the default 30 ms echo, the run ends before you can press anything.
  Interrupt needs a script with `delayMs`.
