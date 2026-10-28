# OpenAI

A conversation started with `--provider openai` is answered by ChatGPT through
the person's ChatGPT sign-in, at `<home>/auth/openai.json`, with the
conversation's model and effort. Nisse runs the loop and its own tools, with
the same approvals as any conversation. An expired token is refreshed and
saved back once; a sign-in that cannot be used or refreshed ends the run
failed with a message saying to sign in again, and `providers/list` shows the
provider signed out with that message. A provider `config.toml` names with
`driver = "openai"` is a second ChatGPT account, at `<home>/auth/<id>.json`.

## Sub-features

- `openai-answer` streams ChatGPT's answer and commits it as a `message`.
- `openai-tools` runs nisse's tools for ChatGPT, asking before calls that
  change things.
- `openai-refresh` refreshes an expired or turned-down token once and saves
  it to `auth/openai.json`.
- `openai-signed-out` fails the run with
  `not signed in to ChatGPT: could not read <path>`.
- `openai-invalid` fails the run with `<path> is not valid` for a file that
  is not a sign-in.
- `openai-expired` fails the run with
  `the ChatGPT sign-in expired; sign in again (token refresh failed (...))`
  when the refresh is turned down, and lists the provider `signed_out` with
  that message.
- `openai-models` lists ChatGPT's models from ChatGPT once signed in, saved
  to `<home>/cache/openai-models.json`, else the saved list, else the one
  nisse ships.
- `openai-model` sends the conversation's model and effort, and a switched
  one from the next run.
- `openai-sign-in` signs in through a browser or a device code, in
  [Sign-in](./sign-in.md).

## How to get to it (user POV)

- Run `nisse --provider openai` or `nisse exec --provider openai '<prompt>'`,
  with `--model` and `--effort`.
- Call `conversation/start` with `"provider": "openai"`.
- Run `nisse login openai`, or press `^L` in the TUI.

## Driving it with drive.ts

Preconditions:

- For `openai-answer`, `openai-tools`, `openai-refresh`, `openai-models` and
  `openai-model`: a ChatGPT sign-in, made by the person with
  `drive.ts r tui start login openai` (see [Sign-in](./sign-in.md)), or saved
  by them earlier and copied to `/tmp/nisse-verify/r/home/auth/openai.json`
  after `up`. It holds `access_token`, `refresh_token`, `expires_at_ms` and
  `account_id`. These make real ChatGPT runs.
- For the failures: a fresh run with no sign-in, and network access to
  `auth.openai.com` and `chatgpt.com` for `openai-expired`.

- **Answer.** Run `drive.ts r tui start --provider openai`,
  `drive.ts r tui wait READY`, `drive.ts r tui type 'Say hello in five words.'`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait --timeout 120000 READY`,
  `drive.ts r tui screen answered`: `NISSE` over ChatGPT's answer. `watch <id>`
  shows `live` text commits, then the `message` and a `run_end` with
  `"outcome": "answered"`.
- **Tools.** Send
  `Use the Bash tool to run exactly: echo approved  Then reply with its output.`,
  then `drive.ts r tui wait --timeout 120000 'allow this call?'`,
  `drive.ts r tui key C-y`, `drive.ts r tui wait --timeout 120000 READY`. The
  call shows `✓ allowed by ada` and `approved`. Denying, `exec` and `--auto`
  behave as in [Tool calls and approvals](./tool-calls-and-approvals.md).
- **Models.** Run `drive.ts r serve` and `drive.ts r rpc models/list '{}'`:
  `openai`'s models as ChatGPT lists them, and
  `/tmp/nisse-verify/r/home/cache/openai-models.json` holds them. Signed out,
  the list is the one nisse ships, with `"defaultModel": "gpt-5.5"`.
- **Model.** Run
  `drive.ts r nisse exec --provider openai --model <a listed model> --effort low 'Say hello in five words.'`:
  exit 0. Switch the conversation with `/model` to another listed model and
  send again: both answer, and `watch <id>` shows the `model` entry between
  the runs.
- **Refresh.** Set `expires_at_ms` in the copied file to `0`, then run
  `drive.ts r nisse exec --provider openai hi`.
  Exit 0, and the file holds a new `access_token` and an `expires_at_ms` in the
  future.
- **Signed out.** In a fresh run, run
  `drive.ts r nisse exec --provider openai hi`. Exit 1, stderr
  `not signed in to ChatGPT: could not read /tmp/nisse-verify/r/home/auth/openai.json: ...`.
  The TUI journey is in [Providers](./providers.md).
- **Invalid.** Write `{"nope": 1}` to
  `/tmp/nisse-verify/r/home/auth/openai.json` and run the same: exit 1, stderr
  `/tmp/nisse-verify/r/home/auth/openai.json is not valid`.
- **Expired.** Write
  `{"access_token": "x.e30.y", "refresh_token": "stale", "expires_at_ms": 0, "account_id": "acct"}`
  to that file and run the same: exit 1, stderr
  `the ChatGPT sign-in expired; sign in again (token refresh failed (401: ...))`.
  `drive.ts r rpc providers/list '{}'` then shows `openai` as
  `"status": "signed_out"` with that message. With
  `"expires_at_ms": 99999999999999` ChatGPT turns the token down, Nisse
  refreshes once, and the run fails with the same message.

## Gotchas

- The server reads the sign-in file on every request, so a changed file
  needs no server restart.
- A refresh may rotate the refresh token, leaving the person's original
  sign-in stale. Copy the refreshed file back, or sign in again.
- A usage limit fails the run with `You have hit your ChatGPT usage limit`.
- A refresh turned down keeps the provider listed signed out until the next
  sign-in or a new server, even after the file changes.
