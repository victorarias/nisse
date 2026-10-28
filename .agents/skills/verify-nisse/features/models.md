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

- A fresh run with no script. The model list and the Claude lines need the
  run's server started without the session's Claude variables, as
  [Claude](./claude.md) says.
- `model-switch-provider` to Claude makes one real Claude run and needs a
  signed-in Claude Code; to OpenAI it needs a ChatGPT sign-in.

- **List.** Run `drive.ts r serve` and `drive.ts r rpc models/list '{}'`: one
  entry per provider. `script` has `"defaultModel": "script"`; `claude` has
  no `defaultModel` and Claude Code's models, such as `sonnet`, `opus` and
  `haiku`, each with `"efforts": ["low", "medium", "high", "xhigh", "max"]`;
  `openai` has `"defaultModel": "gpt-5.5"` and models with `efforts` and a
  `defaultEffort`.
- **Pick.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`: the
  status bar ends `script  nisse <version>`. Type `/model`, press `Enter`,
  `drive.ts r tui wait ' MODEL '`, `drive.ts r tui screen models`: the
  `MODEL` panel lists `script · Script`, `claude · its own choice`,
  `claude · Sonnet` and the rest, then `openai · ...`, over
  `↑↓  model   ←→  effort   ⏎  switch   esc  close`. Press
  `drive.ts r tui key Down Down Right` and
  `drive.ts r tui wait 'claude · Sonnet ‹ low ›'`. Press `Enter` and
  `drive.ts r tui wait 'switched to'`: `◆ ada switched to claude · sonnet · low`
  in the transcript and `claude · sonnet · low` in the status bar.
  `drive.ts r watch <id> --save switched` shows one `model` entry by
  `{"_tag": "person", "name": "ada"}` with
  `"selection": {"provider": "claude", "model": "sonnet", "effort": "low"}`,
  and the snapshot's `conversation.model` is the same.
- **Close.** Open `/model` again, press `Escape`,
  `drive.ts r tui wait --gone ' MODEL '`: no new entry in `watch`.
- **Effort.** With the picker open on a model with efforts, `Right` steps
  through them and wraps to `‹ default ›`, which switches without an effort.
  The picker opens on the conversation's model and effort.
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
- **Chosen last.** In a fresh run, `rpc conversation/start '{"cwd": "/tmp"}'`
  answers `{"provider": "script"}`. After a start or a switch to
  `{"provider": "openai", "effort": "low"}`, the same call answers that, and
  `'{"cwd": "/tmp", "effort": "high"}'` answers
  `{"provider": "openai", "effort": "high"}`. A new TUI's status bar shows it.
- **Defaults from config.** In a fresh run, before the server starts, write
  `default_model = { provider = "openai", model = "gpt-5.5", effort = "high" }`
  to `/tmp/nisse-verify/r/home/config.toml`, and
  `default_model = { provider = "script", effort = "low" }` to
  `/tmp/nisse-verify/r/project/.nisse/config.toml`, and make
  `/tmp/nisse-verify/r/project/src`. Run `drive.ts r serve`, then
  `rpc conversation/start '{"cwd": "/tmp"}'`:
  `{"provider": "openai", "model": "gpt-5.5", "effort": "high"}`;
  `'{"cwd": "/tmp/nisse-verify/r/project/src"}'`:
  `{"provider": "script", "effort": "low"}`;
  `'{"cwd": "/tmp", "model": "gpt-other"}'`:
  `{"provider": "openai", "model": "gpt-other"}`. A TUI opened in the
  checkout shows `openai · gpt-5.5 · high` in its status bar.
- **Switch to Claude.** In a run whose server has the Claude Code sign-in, run
  `drive.ts r nisse exec --provider script 'The code word is pelican.'`, take
  the conversation's id from `rpc conversation/list`, run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": "bo", "selection": {"provider": "claude", "model": "haiku"}}'`,
  then
  `drive.ts r nisse exec --conversation <id> 'What code word did I give you earlier in this conversation? Reply with the word only.'`:
  exit 0, stdout `pelican`. `watch <id>` shows the first run, the `model`
  entry, then the second run. `drive.ts r tui start --conversation <id>`
  shows `◆ bo switched to claude · haiku` between them and `claude · haiku`
  in the status bar.

## Gotchas

- Nisse does not check a model or effort against the list when a
  conversation starts or switches; `--model haiku` with no provider goes to
  the default model's provider, whatever it is.
- The model chosen last is per home, so one journey's choice is the next
  one's default; start from a fresh run or name `--provider`.
- The picker's chosen row shows `‹ <effort> ›` only for a model with efforts.
