# Per-conversation agent and settings

A conversation's configuration is durable, forkable and watchable, and harness
settings change without a restart. `/instructions [text]` and
`/max-turns [n]` in the TUI, or `conversation/configure`, change a
conversation's instructions and turn limit from its next model request on. Each
change is a `sigma.configured` entry every client draws as
`◆ <author> set the instructions: <text>`, `◆ <author> set the turn limit to <n> turns`,
`cleared the instructions` or `removed the turn limit`.

## Sub-features

- `agent-document` [kernel] `pi.agent` document holding a conversation's configuration (R380-404): Configuration is durable, forkable, watchable
- `agent-instructions` [kernel] `configure()`: instructions change later (R380-404): Change the brief without restarting
- `configure-rpc` The client path for `configure()`: instructions change later (R380-404): Change the brief without restarting
- `agent-cwd` [kernel] `configure()`: working directory change (R380-404): Move a conversation to another directory
- `agent-model` [kernel] `configure()`: model (R380-404): Switch model mid-conversation
- `agent-thinking` [kernel] `configure()`: thinking level (R380-404): Change reasoning depth
- `agent-tools-filter` [kernel] `configure()`: tools filter (R380-404): Limit which tools a conversation has
- `agent-inherit` [kernel] Children and forks inherit agent settings (§3.7): A subagent starts with its parent's setup
- `agent-visible` [kernel] Agent changes visible on the watch and rewindable (§2.2): Every client sees configuration changes and forks can read old ones
- `settings-live` [kernel] Live harness settings (R406-428): Change policy without a restart
- `settings-default-extensions` [kernel] Default extension selection (R406-428): New conversations get a chosen extension set
- `settings-tool-execution` [kernel] `toolExecution`: parallel or sequential (R406-428, §8.5): Trade speed against ordering
- `settings-progress-intervals` [kernel] Output progress intervals (§8.2): Tune how often running output is stored
- `settings-as-functions` [kernel] `models` and `settings` given as functions are read at each decision.
- `agent-resolved` [kernel] `conversation.agent()` returns the resolved agent: model, extensions, offered and callable tools, sections and working directory.
- `settings-context-retention` [kernel] `contextRetentionMs` sets how long an idle conversation's context read is kept.

## How to get to it

### People

- Type `/instructions <text>` (or `/instructions` alone to clear them) in the TUI's prompt and press `⏎`.
- Type `/max-turns <n>` (or `/max-turns` alone for no limit) and press `⏎`.

### Agents

- Call `conversation/configure` with `conversation`, `author`, and `instructions` and/or `maxTurns`; `null` clears either.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`, then
  `drive.ts r tui start --conversation talk` and `drive.ts r tui wait READY`.

- **Set from the TUI.** Type `/instructions answer in French` and `Enter`,
  `drive.ts r tui wait 'set the instructions'`; type `/max-turns 3` and
  `Enter`, `drive.ts r tui wait 'set the turn limit'`. The transcript shows
  `◆ ada set the instructions: answer in French` and
  `◆ ada set the turn limit to 3 turns`. Type `/max-turns zero` and `Enter`:
  `✗ max turns takes a whole number 1 or more, got zero` above the prompt, and
  nothing is committed.
- **The model is told.** Send `one` and wait for `You said: one` and `READY`.
  `drive.ts r rpc conversation/context '{"conversation": "talk"}'`: a message
  whose `sections` hold
  `"instructions": "<instructions>\nanswer in French\n</instructions>"`.
- **Clear over the wire.** Run
  `drive.ts r rpc conversation/configure '{"conversation": "talk", "author": {"id": "bo", "name": "bo"}, "instructions": null, "maxTurns": null}'`:
  `"result": null`, and the TUI draws
  `◆ bo cleared the instructions and removed the turn limit`. Send `two`:
  `conversation/context` now ends with a message whose `sections` hold
  `"instructions": null`. `drive.ts r watch talk --save configured` holds
  three `sigma.configured` entries:
  `{"author": {"id": "ada", "name": "ada"}, "instructions": "answer in French"}`,
  `{"author": {"id": "ada", "name": "ada"}, "maxTurns": 3}` and
  `{"author": {"id": "bo", "name": "bo"}, "instructions": null, "maxTurns": null}`.
  `"maxTurns": 0` fails with a message that holds
  `Expected a value greater than or equal to 1` and `maxTurns`.
- **The limit ends a run.** See [Run limits and resilience](./run-resilience.md).

## Contexts

- **Second client.** A change made over the wire shows in the TUI as its author's.

## Sources

Feature ledger area H: spec §2.2, §3.7, §8.2, §8.5; README Per-Conversation Agent, Settings; example 06-configuration.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- configure-rpc, run-turn-limit: changed instructions reach the model and the transcript says who changed them; a turn limit ends a looping run by name

Screen, `packages/sigma/test/screen.test.ts`:

- configure-rpc, run-turn-limit: /instructions and /max-turns show who changed what, and a looping run ends naming the limit

Package, `packages/harness/test/harness.test.ts`:

- agent-model, agent-thinking, agent-instructions, agent-cwd, agent-tools-filter, agent-resolved: configure changes what the agent resolves to, and null gives the field back to the host
- agent-inherit: a conversation a task creates starts with a copy of its owner's agent, and a fork with the agent as of its entry
- agent-visible: a document watch sees each agent change, and a read as of an earlier entry sees the agent then
- settings-default-extensions: the host's default selection applies to a conversation without its own, which can edit it

## Gotchas

- The scripted model echoes whatever its instructions say; judge the
  instructions by `conversation/context`, not by the answer.
- The TUI has no command that shows the current instructions or limit; the
  newest `sigma.configured` entry for each is the current value.
