# Providers

Each conversation's model names a provider: `claude` and `openai` always
exist, and `config.toml` in the home adds more, each with its own sign-in.
A conversation takes the provider named with `--provider`, or `provider` on
`conversation/start`, else the default model's, as [Models](./models.md) says.
Nisse refuses a provider it does not know before any conversation starts. A
provider that cannot run, such as one whose sign-in is missing, ends the run
failed with a message saying why, in every client.

## Sub-features

- `provider-choose` starts a conversation with `--provider <name>` from the
  TUI or `exec`, or `provider` on `conversation/start`.
- `provider-default` starts with the default model's provider when none is
  named: the project's, the home's, the one chosen last, then Claude, or the
  scripted provider when `NISSE_MODEL_SCRIPT` is set.
- `provider-unknown` refuses an unknown provider by name, exit 1.
- `provider-signed-out` ends a run failed with the provider's sign-in error.
- `provider-config` adds the providers `config.toml` names under
  `[providers.<id>]`, with `driver = "claude"` or `"openai"`, beside the
  built-in ones; each lists, signs in and starts conversations on its own.
- `provider-config-invalid` refuses to serve a home whose `config.toml` does
  not read, naming the file and the field.
- `provider-claude` and `provider-openai` are the real journeys, in
  [Claude](./claude.md) and [OpenAI](./openai.md); signing in is in
  [Sign-in](./sign-in.md).

## How to get to it (user POV)

- Run `nisse --provider <name>` or `nisse exec --provider <name> '<prompt>'`.
- Call `conversation/start` with `"provider": "<name>"`.
- `conversation/list` and each snapshot's `conversation` show the provider in
  its `model`.
- Write `NISSE_HOME/config.toml` with `[providers.<id>]` tables; the next
  server reads it. `providers/list` and the TUI's splash list every provider.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script. `drive.ts` sets `NISSE_MODEL_SCRIPT`, so the
  provider a conversation falls back to is `script`.
- No `auth/openai.json` in the run's home, which a fresh run never has.

- **Choose over the wire.** Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'`:
  `"model": {"provider": "script"}`. Then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "provider": "openai"}'`:
  `"model": {"provider": "openai"}`. Run the first again: it now starts with
  `openai`, the provider chosen last.
- **Unknown over the wire.** Run
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "provider": "nope"}'`.
  It exits 1 with an `error` whose data holds
  `{"_tag": "UnknownProvider", "provider": "nope"}`, and
  `rpc conversation/list` shows no new conversation.
- **Unknown from the CLI.** Run `drive.ts r nisse exec --provider nope hi`:
  exit 1, empty stdout, stderr `nisse has no provider named nope`. Run
  `drive.ts r tui start --provider nope`, then `drive.ts r doctor` until it
  shows `tui      exited with 1`, then `drive.ts r tui stop`: what the TUI
  left is `nisse has no provider named nope`.
- **Signed out, exec.** Run `drive.ts r nisse exec --provider openai hi`.
  Exit 1, empty stdout, stderr
  `not signed in to ChatGPT: could not read /tmp/nisse-verify/r/home/auth/openai.json: ...`.
  `rpc conversation/list` shows the conversation with
  `"model": {"provider": "openai"}`.
- **Signed out, TUI.** Run `drive.ts r tui start --provider openai`,
  `drive.ts r tui wait READY`, `drive.ts r tui type hi`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'not signed in to ChatGPT'`,
  `drive.ts r tui screen signed-out`. `ADA` over `hi`, then
  `✗ not signed in to ChatGPT: ...`, and `READY`.
- **Config.** In a fresh run, before anything starts the server, write
  `/tmp/nisse-verify/r/home/config.toml`:

  ```toml
  [providers.openai-work]
  driver = "openai"

  [providers.claude-alt]
  driver = "claude"
  config_dir = "/tmp/nisse-verify/r/claude-alt"
  ```

  Run `drive.ts r serve` and `drive.ts r rpc providers/list '{}'`: `script`,
  `claude`, `openai`, `openai-work` and `claude-alt`, each with its `driver`,
  `signIn` and `health`. `openai-work` is `signed_out`. Run
  `drive.ts r nisse exec --provider openai-work hi`: exit 1, stderr
  `not signed in to ChatGPT: could not read /tmp/nisse-verify/r/home/auth/openai-work.json: ...`.
  Run `drive.ts r tui start`, `drive.ts r tui wait openai-work`,
  `drive.ts r tui screen splash`: `○ openai-work signed out` and
  `● claude-alt <account>` in the list.

- **Invalid config.** In a fresh run, write `[providers.gem]` and
  `driver = "gemini"` to that file and run `drive.ts r nisse serve`: exit 1,
  stderr `/tmp/nisse-verify/r/home/config.toml: Expected "claude" | "openai"`
  and `at ["providers"]["gem"]["driver"]`. Run `drive.ts r nisse exec hi`:
  exit 1, empty stdout, and the same stderr from the server it tried to start.

## Gotchas

- The provider runs in the server, with the server's environment and sign-ins.
  A sign-in or `config.toml` changed after the server started reaches it only
  after `rpc server/stop`; the next client starts a new server.
- The provider chosen last becomes the default, so name `--provider` when a
  journey needs a particular one, and check the default before naming any.
- Listing providers, which the TUI does when it opens, starts Claude Code once
  to ask how it is signed in, without asking Claude anything. Inside a Claude
  Code session, start the run's server without that session's variables, as
  [Claude](./claude.md) says.
- The scripted provider's steps are shared by every conversation of a server
  that uses it, and start over when the server restarts.
- A conversation keeps its provider until someone switches its model;
  reopening it with `--provider` does not change it.
- `drive.ts` always sets `NISSE_MODEL_SCRIPT`, so it cannot show Claude as the
  last default; name `--provider claude` instead.
