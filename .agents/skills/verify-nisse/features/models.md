# Models

A conversation's model is a provider, a model and a reasoning effort. A new
conversation takes `--provider`, `--model` and `--effort`, else the
`default_model` of the nearest `.nisse/config.toml` above its directory, then
of `NISSE_HOME/config.toml`, then the model chosen last. `/model` in the TUI
lists every provider's models and their efforts; switching is a `model` entry
every client sees, the status bar follows it, and it takes effect from the
next run. Switching providers keeps the conversation.

## Sub-features

- `model-list` lists each provider's models, best first, with their efforts:
  Claude Code's models and `its own choice`, ChatGPT's from ChatGPT, else the
  list it sent last, else the one nisse ships.
- `model-flags` starts a conversation with `--model` and `--effort` from the
  TUI or `exec`, or `model` and `effort` on `conversation/start`. A model
  named without a provider goes to the default model's provider.
- `model-default` takes the project's `default_model`, then the home's, then
  the model chosen last, by a start or a switch.
- `model-switch` switches with `/model` (`↑↓` model, `←→` effort, `⏎`
  switch, `Esc` close) or `conversation/select_model`, commits a `model`
  entry shown as `◆ <name> switched to <provider> · <model> · <effort>`, and
  refuses a provider nisse does not have.
- `model-status` shows the conversation's model at the right of the status
  bar, from its start and after every switch, in every TUI.
- `model-switch-provider` keeps the conversation across providers: the new
  provider is told what was said.

## How to get to it (user POV)

- Run `nisse --model <model> --effort <effort>`, with `--provider`, or the
  same on `nisse exec`.
- Type `/model` in the TUI's prompt and press `⏎`.
- Write `default_model = { provider = "...", model = "...", effort = "..." }`
  in `NISSE_HOME/config.toml` or a project's `.nisse/config.toml`.
- Call `models/list`, `conversation/start` with `model` and `effort`, and
  `conversation/select_model`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script, `drive.ts r up`. Its Claude is the recorded
  fake `models`, so the Claude lines come from a recorded Claude Code probe
  instead of any real `claude` on the machine.
- **Switch providers** uses `--fake-claude text` or `--fake-openai text_answer`
  instead, as it says.

- **List.** Run `drive.ts r serve` and `drive.ts r rpc models/list '{}'`: one
  entry per provider. `script` has `"defaultModel": "script"`; `claude` has
  no `defaultModel` and Claude Code's models, `sonnet`, `fable`, `opus` and
  `haiku`, each with `"efforts": ["low", "medium", "high", "xhigh", "max"]`;
  `openai` has `"defaultModel": "gpt-5.5"` and the list nisse ships, from
  `gpt-6.1-sol` to `gpt-5.5`, with `efforts` and a `defaultEffort`.
- **Pick.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`: the
  status bar ends `script  nisse <version>`. Type `/model`, press `Enter`,
  `drive.ts r tui wait ' MODEL '`, `drive.ts r tui screen models`: the
  `MODEL` panel lists `script · Script`, `claude · its own choice`,
  `claude · Sonnet`, `claude · Fable`, `claude · Opus`, `claude · Haiku`,
  then `openai · GPT-6.1-Sol` down to `openai · GPT-5.5`, over
  `↑↓  model   ←→  effort   ⏎  switch   esc  close`. Press
  `drive.ts r tui key Down Down Right` and
  `drive.ts r tui wait 'claude · Sonnet ‹ low ›'`. Press `Enter` and
  `drive.ts r tui wait 'switched to'`: `◆ ada switched to claude · sonnet · low`
  in the transcript and `claude · sonnet · low` in the status bar.
  `drive.ts r watch <id> --save switched` shows one `model` entry by
  `{"_tag": "person", "name": "ada"}` with
  `"selection": {"provider": "claude", "model": "sonnet", "effort": "low"}`,
  and the snapshot's `conversation.model` is the same.
- **Effort.** Open `/model` again: it opens on `claude · Sonnet ‹ low ›`.
  `drive.ts r tui key Right Right Right Right` shows `‹ max ›`, and one more
  `Right` wraps to `‹ default ›`, which switches without an effort.
- **Close.** With the picker open, press `Escape` and
  `drive.ts r tui wait --gone ' MODEL '`: `watch <id>` still shows one
  `model` entry.
- **Switch over the wire.** With a TUI open on a conversation, run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": "bo", "selection": {"provider": "claude", "model": "opus", "effort": "max"}}'`:
  `"result": null`, and the TUI shows `◆ bo switched to claude · opus · max`
  and `claude · opus · max` in its status bar. With
  `"selection": {"provider": "nope"}` it exits 1 with `UnknownProvider` and
  commits nothing; with `"conversation": "nope"` the error is
  `NoSuchConversation`.
- **Flags.** Run
  `drive.ts r tui start --provider claude --model haiku --effort high` and
  `drive.ts r tui wait READY`: the status bar shows `claude · haiku · high`,
  and `/model` opens on `claude · Haiku ‹ high ›`.
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "provider": "openai", "effort": "low"}'`
  answers `"model": {"provider": "openai", "effort": "low"}`.
- **Chosen last.** In a fresh run, `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'` answers
  `{"provider": "script"}`. After a start or a switch to
  `{"provider": "openai", "effort": "low"}`, the same call answers that, and
  `'{"cwd": "/tmp", "effort": "high"}'` answers
  `{"provider": "openai", "effort": "high"}`. A new TUI's status bar then
  ends `openai · high`.
- **Defaults from config.** In a fresh run, before the server starts, write
  `default_model = { provider = "openai", model = "gpt-5.5", effort = "high" }`
  to `/tmp/nisse-verify/r/home/config.toml`, and
  `default_model = { provider = "script", effort = "low" }` to
  `/tmp/nisse-verify/r/project/.nisse/config.toml`, and make
  `/tmp/nisse-verify/r/project/src`. Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'`:
  `{"provider": "openai", "model": "gpt-5.5", "effort": "high"}`;
  `'{"cwd": "/tmp/nisse-verify/r/project/src"}'`:
  `{"provider": "script", "effort": "low"}`;
  `'{"cwd": "/tmp", "model": "gpt-other"}'`:
  `{"provider": "openai", "model": "gpt-other"}`. A TUI opened in the
  checkout shows `openai · gpt-5.5 · high` in its status bar.
- **Switch providers.** `drive.ts r up --fake-claude text`, run
  `drive.ts r nisse exec --provider script 'The code word is pelican.'`, take
  the conversation's id from `drive.ts r rpc conversation/list`, run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": "bo", "selection": {"provider": "claude", "model": "haiku"}}'`,
  then
  `drive.ts r nisse exec --conversation <id> 'What code word did I give you earlier in this conversation? Reply with the word only.'`:
  exit 0. The `text` recording stands in for Claude Code here: its user sent
  only `Reply with exactly: fixture text ok`, so the spawn departs from it,
  and stdout is the recording's `fixture text ok`, not `pelican`. Judge what
  nisse sent: `evidence/fake-claude/log.ndjson` shows Claude Code spawned
  with `--model=haiku` and sent one user message whose texts are
  `This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.`,
  `The code word is pelican.`,
  `You answered: You said: The code word is pelican.` and the question.
  `drive.ts r tui start --conversation <id>` shows
  `◆ bo switched to claude · haiku` between the runs and `claude · haiku` in
  the status bar. To OpenAI: `drive.ts r up --fake-openai text_answer`, the
  same first `exec`, a switch to `{"provider": "openai", "model": "gpt-5.5"}`,
  then `drive.ts r nisse exec --conversation <id> hello`: `Hello there`. The
  request in `fake-openai.ndjson` is `differs`, since the recording held one
  prompt with no history: its `input` carries the first exchange,
  `The code word is pelican.` and `You said: The code word is pelican.`,
  before `hello`.

## Gotchas

- Nisse does not check a model or effort against the list when a
  conversation starts or switches; `--model haiku` with no provider goes to
  the default model's provider, whatever it is.
- The model chosen last is per home, so one journey's choice is the next
  one's default; start from a fresh run or name `--provider`.
- The picker's chosen row shows `‹ <effort> ›` only for a model with efforts.

## With a real account

A recording proves what nisse sends; only a real provider proves it is
understood. Follow SKILL.md's [Real accounts](../SKILL.md#real-accounts).
Save `evidence/` with each run. Before a later `rpc`, if `drive.ts r doctor`
shows `none running`, run `drive.ts r serve` again.

- **To Claude.** `drive.ts r up --real-claude`. First check:
  `drive.ts r serve` and `drive.ts r rpc providers/list '{}'` list `claude`
  as `"status": "ready"` with your account; otherwise stop and report what
  it shows. Run the three commands of **Switch providers**: the second
  `exec` exits 0 with stdout `pelican`. Run
  `drive.ts r tui start --conversation <id>`,
  `drive.ts r tui wait READY` and `drive.ts r tui screen switched`. The
  session lands in your own Claude Code configuration.
- **To ChatGPT.** In a new run, `drive.ts r up --openai-auth <your sign-in file>`.
  First check: `drive.ts r serve` and `drive.ts r rpc providers/list '{}'`
  list `openai` as `"status": "ready"` with your account; otherwise stop and
  report what it shows. Run the same first `exec` and question, switching to
  `{"provider": "openai", "model": "gpt-5.5"}` instead: stdout `pelican`.
  `drive.ts r rpc models/list '{}'` lists `openai`'s models as ChatGPT
  serves them today, the same slugs as
  `/tmp/nisse-verify/r/home/cache/openai-models.json`; copy that file into
  `evidence/`. `drive.ts r down` writes a refreshed sign-in back.
