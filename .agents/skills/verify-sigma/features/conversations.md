# Conversations and forks

A conversation is created with its settings, listed, reopened, owned by a task
or another conversation, and forked at any entry. `/fork` in the TUI forks the
conversation from before the last prompt a person typed and moves the screen
to the fork, a new conversation with the same model, settings and approvals
as the conversation has now (not as they were at the fork's entry), so the
prompt can be tried another way. The fork's header says what it forked,
`⑂ fork of <id> · <that conversation's first prompt>`, and `conversation/list`
gives each fork `fork: {of, at}`. `conversation/fork` forks at any
entry, with a chosen id. The conversation it left is unchanged.

## Sub-features

- `conversation-options` [kernel] Create a conversation with options (§2.2): Start with model, instructions, tools, extensions and limits
- `conversation-owner` [kernel] Ownership kinds (§2, §3): A conversation is owned by a task or another conversation, and goes away with it
- `fork-at-entry` [kernel] Fork at any entry (R716-723, §3.7): Try another direction from an earlier point
- `fork-rpc` The client path for Fork at any entry (R716-723, §3.7): Try another direction from an earlier point
- `fork-shown` The TUI's header marks a fork and names the conversation it forked, and `conversation/list` gives each fork the conversation and entry it goes on from
- `fork-document-policy` [kernel] Fork document policies: asOf, current, initial (§3.7): Each kind of state chooses what a fork inherits
- `fork-provider-identity` [kernel] Each fork has its own provider session identity (§3.7, R716): Forks don't collide in provider session or cache
- `conversation-list` [kernel] Conversation list (§2.2): Find conversations
- `conversation-reopen` [kernel] Reopen by id and continue (§2.2): Come back to a conversation
- `conversation-init` [kernel] `init` on create, fork and root writes per-call data in the creating commit.

## How to get to it

### People

- Type `/fork` in the TUI's prompt and press `⏎`.

### Agents

- Call `conversation/fork` with `conversation`, `author`, `at` (the last entry the fork inherits) and an optional `id`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`: sigma echoes `You said: <prompt>`.

- **Fork from the TUI.** Run `drive.ts r tui start --conversation talk`,
  `drive.ts r tui wait READY`, send `prompt one` and then `prompt two`
  (`tui type`, `tui key Enter`, `tui wait 'You said: <prompt>'`,
  `tui wait READY`), and `drive.ts r tui screen before-fork`. Type `/fork`,
  press `Enter`, and `drive.ts r tui wait --gone 'prompt two'`: the title bar
  now names a new conversation and what it forked, such as
  `conversation 25  ⑂ fork of talk · prompt one`, and the transcript
  holds `prompt one` and `You said: prompt one` only. Send `prompt three`:
  `You said: prompt three` under them. `drive.ts r tui stop` ends with
  `resume with: sigma --conversation <the fork's id>`, and
  `drive.ts r tui start --conversation talk` still shows `prompt two` and its
  answer.
- **The fork in the list.** `drive.ts r rpc conversation/list`: the fork's
  entry has `"fork": {"of": "talk", "at": <the first run_end's id>}` and
  `"title": "prompt one"`; `talk`'s has no `fork`.
- **The fork's view.** `drive.ts r watch <fork id> --save fork-view`:
  `"conversation": {"id": <fork>, "parent": {"conversationId": <talk's number>, "at": <the first run_end's id>}}`,
  and the inherited entries keep `"conversationId"` of `talk`.
- **Fork over the wire.** Take the first `sigma.run_end`'s id from
  `drive.ts r watch talk --save talk-view`, then
  `drive.ts r rpc conversation/fork '{"author": {"id": "ada", "name": "ada"}, "conversation": "talk", "at": <id>, "id": "other-way"}'`:
  `"result": {"conversation": "other-way"}`.
  `drive.ts r watch other-way --submit 'prompt four' --until run_end --save other-way`:
  the first exchange, then `prompt four` and `You said: prompt four`.
  `drive.ts r rpc conversation/context '{"conversation": "other-way"}'` lists
  only those entries. Without `id` the answer is a new number. The same `id`
  again fails `InvalidConversationId` (`other-way already names a conversation`),
  and `"at": 9999` fails `NoSuchEntry`.

## Sources

Feature ledger area C: spec §2, §2.2, §3.7; README More Conversations and Forks; examples 02-forks, 03-owned-conversations, 07-harness-conversations.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- fork-rpc, fork-shown: a fork goes on from an earlier entry with only what came before it and the settings as they are now, the list says what it forked, and the conversation it left is unchanged

Screen, `packages/sigma/test/screen.test.ts`:

- fork-rpc, fork-shown: /fork moves the screen to a new conversation that goes on from before the last prompt, and its header says what it forked

Package, `packages/harness/test/harness.test.ts`:

- fork-provider-identity: the root and each of its forks have their own provider session id
- conversation-list, conversation-reopen: conversations are found again after a restart, with their agent and history
- reset-context, reset-handoff, fork-at-entry: a fork that resets starts a new context with its handoff, and the original and the fork's earlier entries keep theirs

## Gotchas

- `/fork` names the fork by number, so its title bar shows `conversation <n>`
  and nothing on screen says which conversation it came from; the view's
  `parent` does.
- `/fork` refuses with a notice above the prompt instead of forking somewhere
  else: `✗ nothing to fork yet: no prompt has been sent` in a new
  conversation, and `… is not loaded; scroll up to it and fork again` when
  the last prompt, or the entry before it, is above the loaded transcript.
