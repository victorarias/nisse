# Providers

Each conversation is bound to one provider when it starts: Claude unless the
person names another with `--provider`, or `provider` on `conversation/start`.
Nisse refuses a provider it does not know before any conversation starts. A
provider that cannot run, such as one whose sign-in is missing, ends the run
failed with a message saying why, in every client.

## Sub-features

- `provider-choose` starts a conversation with `--provider <name>` from the
  TUI or `exec`, or `provider` on `conversation/start`.
- `provider-default` starts with the home's preferred provider when none is
  named: Claude, or the scripted provider when `NISSE_MODEL_SCRIPT` is set.
- `provider-unknown` refuses an unknown provider by name, exit 1.
- `provider-signed-out` ends a run failed with the provider's sign-in error.
- `provider-claude` and `provider-openai` are the real journeys, in
  [Claude](./claude.md) and [OpenAI](./openai.md).

## How to get to it (user POV)

- Run `nisse --provider <name>` or `nisse exec --provider <name> '<prompt>'`.
- Call `conversation/start` with `"provider": "<name>"`.
- `conversation/list` and each snapshot's `conversation` show the provider.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script. `drive.ts` sets `NISSE_MODEL_SCRIPT`, so the
  home's preferred provider is `script`.
- No `auth/openai.json` in the run's home, which a fresh run never has.

- **Choose over the wire.** Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "provider": "openai"}'`:
  `"provider": "openai"`. `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'`:
  `"provider": "script"`.
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
  `rpc conversation/list` shows the conversation with `"provider": "openai"`.
- **Signed out, TUI.** Run `drive.ts r tui start --provider openai`,
  `drive.ts r tui wait READY`, `drive.ts r tui type hi`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'not signed in to ChatGPT'`,
  `drive.ts r tui screen signed-out`. `ADA` over `hi`, then
  `✗ not signed in to ChatGPT: ...`, and `READY`.

## Gotchas

- The provider runs in the server, with the server's environment and sign-ins.
  A sign-in changed after the server started reaches it only after
  `rpc server/stop`; the next client starts a new server.
- The scripted provider's steps are shared by every conversation of a server
  that uses it, and start over when the server restarts.
- A conversation keeps its provider; reopening it with `--provider` does not
  change it.
- `drive.ts` always sets `NISSE_MODEL_SCRIPT`, so it cannot show Claude as the
  default; name `--provider claude` instead.
