# Reset and handoff

A reset starts over with an empty context in the same conversation, history
kept, optionally carrying a brief. `/reset [handoff]` in the TUI or
`conversation/reset` draws `◆ <author> started a new context` in every
client's transcript, with the handoff under it; the model's next run sees only
the handoff and what came after, while the transcript keeps everything.

## Sub-features

- `reset-context` [kernel] `reset()` (R593-604): Start over with an empty context in the same conversation, history kept
- `reset-rpc` The client path for `reset()` (R593-604): Start over with an empty context in the same conversation, history kept
- `reset-handoff` Handoff text on reset (R593-604): Carry a short brief into the fresh context
- `reset-at-boundary` [kernel] Reset while busy applies at a boundary (§6): A reset from one client does not cut another's tool call in half

## How to get to it

### People

- Type `/reset` or `/reset <handoff>` in the TUI's prompt and press `⏎`.

### Agents

- Call `conversation/reset` with `conversation`, `author` and an optional `handoff`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`: sigma echoes `You said: <prompt>`.

- **Reset from the TUI.** Run `drive.ts r tui start --conversation talk`,
  `drive.ts r tui wait READY`, type `prompt one` and `Enter`, then
  `drive.ts r tui wait 'You said: prompt one'` and `drive.ts r tui wait READY`.
  Type `/reset we were counting sheep`, press `Enter`, and
  `drive.ts r tui wait 'started a new context'`: under the first answer,
  `◆ ada started a new context` with `we were counting sheep` on the line
  below. `drive.ts r rpc conversation/context '{"conversation": "talk"}'`
  answers one message, `user` `we were counting sheep`, and one entry, the
  reset's.
- **The model goes on from the handoff.** Type `go on` and `Enter`:
  `You said: go on`, and the transcript above still shows `prompt one` and its
  answer.
- **Reset over the wire.** Run
  `drive.ts r rpc conversation/reset '{"conversation": "talk", "author": {"id": "bo", "name": "bo"}}'`:
  `"result": null`, and the TUI draws `◆ bo started a new context` with no
  handoff. `conversation/context` now answers `"messages": []` and one entry.
  `drive.ts r watch talk --save reset` holds every earlier entry, then
  `pi.reset` entries with `{"author": {"id": "ada", "name": "ada"}}` (its model text the handoff) and
  `{"author": {"id": "bo", "name": "bo"}}`. With `"conversation": "nope"` the call fails
  `NoSuchConversation`.

## Contexts

- **Second client.** The reset is an entry: every TUI on the conversation draws it.

## Sources

Feature ledger area D: spec §6; README Reset and Handoff; example 25-coding-agent.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- reset-rpc, reset-handoff: a reset starts an empty context with the handoff as its first message, and the transcript keeps everything

Screen, `packages/sigma/test/screen.test.ts`:

- reset-rpc, reset-handoff: /reset draws a new context with its handoff, and the conversation goes on after it

Package, `packages/harness/test/harness.test.ts`:

- reset-context, reset-handoff, fork-at-entry: a fork that resets starts a new context with its handoff, and the original and the fork's earlier entries keep theirs

## Gotchas

- The screen keeps everything said before a reset; only
  `conversation/context` shows what the model will be sent. Judge a reset by
  that, not by the transcript.
