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
- `provider-binary` runs a Claude provider's Claude Code from `binary`,
  with `env` added to its environment and `args` added to each run's command
  line; `NISSE_CLAUDE` names the `claude` every Claude provider without a
  `binary` runs. One that does not start is `unavailable`, saying why.
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
  server reads it. Set `NISSE_CLAUDE` in the environment of the command that
  starts the server. `providers/list` and the TUI's splash list every provider.

## Driving it with drive.ts

Preconditions:

- A fresh run made with `drive.ts r up`, with no script; its Claude is the
  fake playing `models`, signed in as `person@example.com · Claude Max`.
  `drive.ts` sets `NISSE_MODEL_SCRIPT`, so the provider a conversation falls
  back to is `script`.
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
- **Signed in.** In a fresh run made with
  `drive.ts r up --fake-openai text_answer`, run
  `drive.ts r nisse exec --provider openai hello`: stdout `Hello there`, exit
  0, and the request in `evidence/fake-openai.ndjson` is `as recorded`.
  `rpc providers/list '{}'` shows `openai` `ready` as
  `ada@example.com · ChatGPT Plus`. In another fresh run made with
  `drive.ts r up --fake-claude text`, run
  `drive.ts r nisse exec --provider claude 'Reply with exactly: fixture text ok'`:
  stdout `fixture text ok`, exit 0, and `rpc conversation/list` shows
  `"model": {"provider": "claude"}`.
- **Config.** In a fresh run made with `drive.ts r up`, before anything starts the server, write
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
  `signIn` and `health`. `openai-work` is `signed_out`; `claude` and
  `claude-alt` are `ready`. Run
  `drive.ts r nisse exec --provider openai-work hi`: exit 1, stderr
  `not signed in to ChatGPT: could not read /tmp/nisse-verify/r/home/auth/openai-work.json: ...`.
  Run `drive.ts r tui start`, `drive.ts r tui wait openai-work`,
  `drive.ts r tui screen splash`: `○ openai-work signed out` and
  `● claude-alt` in the list, and the status bar ends with `openai-work`,
  the provider chosen last.

- **Binary, env and args.** In a fresh run made with
  `drive.ts r up --fake-claude text`, before anything starts the server,
  write `/tmp/nisse-verify/r/home/config.toml`:

  ```toml
  [providers.claude-alt]
  driver = "claude"
  env = { FAKE_CLAUDE_DIR = "/tmp/nisse-verify/r/evidence/claude-alt" }
  args = ["--add-dir", "/tmp"]

  [providers.claude-gone]
  driver = "claude"
  binary = "/tmp/nisse-verify/r/no-claude"
  ```

  Run `drive.ts r serve` and `drive.ts r rpc providers/list '{}'`:
  `claude-alt` is `ready`, and `claude-gone` is `unavailable` with a message
  that says Claude Code's binary was not found at
  `/tmp/nisse-verify/r/no-claude` and ends
  `install Claude Code or set its binary`. That message fails today: it
  reads `An error occurred in Effect.tryPromise; install Claude Code or set its binary`.
  Run
  `drive.ts r nisse exec --provider claude-alt 'Reply with exactly: fixture text ok'`:
  stdout `fixture text ok`, exit 0. `evidence/claude-alt/log.ndjson`, where
  `env` sent the fake's log, holds that provider's probe and its spawn,
  whose `argv` has `"--add-dir","/tmp"`; the probe's has not.
  `evidence/fake-claude/log.ndjson` holds only the `claude` provider's probe.

- **NISSE_CLAUDE.** In a fresh run made with `drive.ts r up --real-claude`,
  run `NISSE_CLAUDE=/tmp/nisse-verify/r/no-claude drive.ts r serve` and
  `drive.ts r rpc providers/list '{}'`: `claude` is `unavailable` with the
  same message as `claude-gone` above, so no Claude Code ran. In every run
  without `--real-claude`, `drive.ts` points `NISSE_CLAUDE` at the fake,
  which is why `claude` is `ready` as `person@example.com · Claude Max`.
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
  per Claude provider to ask how it is signed in, without asking Claude
  anything. Every run but a `--real-claude` one starts the fake. The `models`
  recording answers one such probe, so with two Claude providers one names
  `person@example.com · Claude Max` and the other shows only `ready`.
- The scripted provider's steps are shared by every conversation of a server
  that uses it, and start over when the server restarts.
- A conversation keeps its provider until someone switches its model;
  reopening it with `--provider` does not change it.
- `drive.ts` always sets `NISSE_MODEL_SCRIPT`, so it cannot show Claude as the
  last default; name `--provider claude` instead.

## With a real account

Proves that providers from `config.toml` answer on their own accounts. Follow
the skill's [Real accounts](../SKILL.md#real-accounts). Give every
`tui wait` `--timeout 120000` and keep `evidence/`.

- **Claude from config.** In a run made with `drive.ts r up --real-claude`,
  write `[providers.claude-own]` with `driver = "claude"` and
  `args = ["--add-dir", "/tmp/nisse-verify/r"]` to the home's
  `config.toml`. Run `drive.ts r serve` and
  `drive.ts r rpc providers/list '{}'`: `claude` and `claude-own` are both
  `ready` with your account; otherwise stop and report what it shows. Run
  `drive.ts r nisse exec --provider claude-own 'Reply with one word: ok'`:
  stdout `ok`, exit 0.
- **openai-work from a saved sign-in.** In a run made with plain
  `drive.ts r2 up`, write `/tmp/nisse-verify/r2/home/config.toml`:

  ```toml
  [providers.openai-work]
  driver = "openai"
  ```

  Copy your ChatGPT sign-in to
  `/tmp/nisse-verify/r2/home/auth/openai-work.json` with mode 0600
  (`--openai-auth` only fills `auth/openai.json`). Run
  `drive.ts r2 serve` and `drive.ts r2 rpc providers/list '{}'`:
  `openai-work` is `ready` with your account and `openai` is `signed_out`.
  `drive.ts r2 nisse exec --provider openai-work 'Reply with one word: ok'`
  prints `ok`, and `drive.ts r2 nisse exec --provider openai hi` still fails
  `not signed in to ChatGPT`. `down` does not write this file back: before
  `drive.ts r2 down`, copy it over your saved sign-in if it changed.

- **openai-work sign-in (needs a person).** In that run, after
  `drive.ts r2 nisse logout openai-work`, run
  `drive.ts r2 tui start login openai-work --device-code`; the person enters
  the code it shows at the address it names.
  `drive.ts r2 tui wait --timeout 300000 'signed in to openai-work'` and
  `drive.ts r2 tui stop`:
  `signed in to openai-work as <email> · ChatGPT <plan>`, and
  `auth/openai-work.json` exists beside no `auth/openai.json`.
- **claude-alt sign-in (needs a person).** In a run made with
  `drive.ts r3 up --real-claude`, write `/tmp/nisse-verify/r3/home/config.toml`
  before anything starts the server:

  ```toml
  [providers.claude-alt]
  driver = "claude"
  config_dir = "/tmp/nisse-verify/r3/claude-alt"
  ```

  Run `drive.ts r3 serve` and `drive.ts r3 rpc providers/list '{}'`:
  `claude-alt` is `signed_out`, its login kept in the empty
  `/tmp/nisse-verify/r3/claude-alt`. Run
  `drive.ts r3 tui start login claude-alt`; the person finishes Claude Code's
  sign-in. `drive.ts r3 tui stop` shows `signed in to claude-alt as <account>`,
  `/tmp/nisse-verify/r3/claude-alt` holds that login, and `providers/list`
  shows `claude-alt` `ready` with it while `claude` keeps your own. Where
  Claude Code is signed in by its environment, as in a hosted session,
  `claude-alt` is `ready` from the start and there is nothing to sign in to;
  report that instead.

Save the `nisse` outputs and `providers/list` in `evidence/`.
