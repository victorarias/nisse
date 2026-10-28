# OpenAI

A conversation started with `--provider openai` is answered by ChatGPT through
the person's ChatGPT sign-in, at `<home>/auth/openai.json`. Nisse runs the loop
and its own tools, with the same approvals as any conversation. An expired
token is refreshed and saved back once; a sign-in that cannot be used or
refreshed ends the run failed with a message saying to sign in again.

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
  `the ChatGPT sign-in expired; sign in again (refresh: ...)` when the refresh
  is turned down.

## How to get to it (user POV)

- Run `nisse --provider openai` or `nisse exec --provider openai '<prompt>'`.
- Call `conversation/start` with `"provider": "openai"`.

## Driving it with drive.ts

Preconditions:

- For `openai-answer`, `openai-tools` and `openai-refresh`: a ChatGPT sign-in
  the person saved with the Rust version of Nisse, copied to
  `/tmp/nisse-verify/r/home/auth/openai.json` after `up`. It holds
  `access_token`, `refresh_token`, `expires_at_ms` and `account_id`. These
  make real ChatGPT runs.
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
  `the ChatGPT sign-in expired; sign in again (refresh: 401: ...)`. With
  `"expires_at_ms": 99999999999999` ChatGPT turns the token down, Nisse
  refreshes once, and the run fails with the same message.

## Gotchas

- The server reads the sign-in file on every request, so a changed file
  needs no server restart.
- A refresh may rotate the refresh token, leaving the person's original
  sign-in stale. Copy the refreshed file back, or sign in again.
- A usage limit fails the run with `You have hit your ChatGPT usage limit`.
