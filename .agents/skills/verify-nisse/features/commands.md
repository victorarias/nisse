# Slash commands

A person types a command such as `/fork` or `/usage` into the TUI's prompt and
presses `⏎`; `/help` lists them all in a `COMMANDS` panel that takes the
transcript's place until `esc`. The splash names `/help  commands` among its
keys. A line that starts with `/` but names no command goes to the model as
an ordinary prompt.

## Sub-features

- `commands-help` `/help` lists every slash command with what it does, in place of the transcript until `esc`.

## How to get to it

### People

- Type `/help` in the TUI's prompt and press `⏎`; `esc` closes the panel.
- The commands it lists: `/model` ([Models](./models.md)), `/fork`
  ([Conversations and forks](./conversations.md)), `/reset`
  ([Reset and handoff](./reset.md)), `/compact` ([Compaction](./compaction.md)),
  `/continue` and `/withdraw` ([Submissions](./submissions.md)),
  `/instructions` and `/max-turns`
  ([Per-conversation agent and settings](./agent-settings.md)), `/usage`
  ([Usage and cost](./usage.md)) and `/tasks` ([Task kernel](./tasks.md)).

### Agents

None. Agents call the RPCs each command's feature file names.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`, then `drive.ts r tui start`
  and `drive.ts r tui wait READY`: the splash's keys end with
  `/help  commands    ^C  quit`.

- **Help.** Type `/help`, press `Enter`, `drive.ts r tui wait COMMANDS` and
  `drive.ts r tui screen help`: `COMMANDS   esc  close` over one line per
  command, `/model  switch the model`,
  `/fork  go on in a new conversation from before your last prompt`,
  `/reset [handoff]  start a new, empty context, with the handoff as its first message`,
  `/compact [instructions]  summarize the context now`,
  `/continue  start a run with no new input, such as after one failed`,
  `/withdraw  take back the newest queued prompt`,
  `/instructions [text]  set the model's instructions; without text, clear them`,
  `/max-turns [n]  end a run after n tool rounds; without n, no limit`,
  `/usage  the tokens this conversation and every conversation spent`,
  `/tasks  the work running now in every conversation` and
  `/help  these commands`.
- **Close.** `drive.ts r tui key Escape` and
  `drive.ts r tui wait --gone COMMANDS`: the splash is back.
- **Not a command.** Type `/nope at all` and `Enter`:
  `drive.ts r tui wait 'You said: /nope at all'`, the text sent as a prompt.

## Contexts

- **Read-only.** Under `nisse serve --read-only` only `/usage`, `/tasks` and `/help` work; see [Commit line and session](./commit-line.md).

## Tests

Screen, `packages/nisse/test/screen.test.ts`:

- commands-help: /help lists every command with what it does, and escape goes back

## Gotchas

- A command's argument is the rest of the line: `/reset` with no text resets
  without a handoff, and `/instructions` alone clears them.
- A mistyped command reaches the model as a prompt, with no warning, and so
  does a command that takes nothing (`/help`, `/fork`, `/continue`,
  `/withdraw`, `/usage`, `/tasks`) typed with text after it: `/continue the
story` is a prompt.
