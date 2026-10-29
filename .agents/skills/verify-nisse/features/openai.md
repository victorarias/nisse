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
- `openai-failed` fails the run with ChatGPT's reason: a usage limit, a
  failed response, or a stream cut off.
- `openai-models` lists ChatGPT's models from ChatGPT once signed in, saved
  to `<home>/cache/openai-models.json`, else the saved list, else the one
  nisse ships.
- `openai-model` sends the conversation's model and effort, and a switched
  one from the next run.
- `openai-sign-in` signs in through a browser or a device code, in
  [Sign-in](./sign-in.md).
- `openai-instructions` tells ChatGPT the `AGENTS.md` files and skills, and
  sends the skills a message names, in
  [Instructions and skills](./skills.md).
- `openai-code-mode` runs code-mode models' scripts, in
  [Code mode](./code-mode.md).

## How to get to it (user POV)

- Run `nisse --provider openai` or `nisse exec --provider openai '<prompt>'`,
  with `--model` and `--effort`.
- Call `conversation/start` with `"provider": "openai"`.
- Run `nisse login openai`, or press `^L` in the TUI.

## Driving it with drive.ts

Preconditions:

- Each step starts from a fresh run and ends with `drive.ts r down`. Claude
  is the recorded fake `models` unless a step says otherwise, so the splash
  and `providers/list` show `claude` ready as `person@example.com · Claude Max`.
- `--fake-openai` signs the run in to a fake ChatGPT. Each fixture holds one
  conversation from its first prompt: start a new conversation for each, or
  the requests come out `differs`.
- The failure steps need no sign-in; **Expired, live** also needs network
  access to `auth.openai.com` and `chatgpt.com`.

- **Answer.** `drive.ts r up --fake-openai text_answer`,
  `drive.ts r tui start --provider openai`, `drive.ts r tui wait READY`: the
  splash lists `● openai ada@example.com · ChatGPT Plus`.
  `drive.ts r tui type hello`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'Hello there'`, `drive.ts r tui screen answered`:
  `ADA` over `hello`, `NISSE` over `Hello there`, `openai` at the right of
  the status bar. Take the id from the header's `conversation <id>`;
  `drive.ts r watch <id> --save answer` shows the `user`, the `message`
  `Hello there` and a `run_end` with `"outcome": "answered"`.
  `evidence/fake-openai.ndjson` holds one request, `as recorded`, with
  `"model": "gpt-5.5"`.
- **Tools.** `drive.ts r up --fake-openai tool_call,tool_denied`,
  `drive.ts r tui start --provider openai`, `drive.ts r tui wait READY`, take
  the id from the header, then in the background
  `drive.ts r watch <id> --until run_end --timeout 60000 --save tools`. Type
  `what does echo say?`, press `Enter`,
  `drive.ts r tui wait 'allow this call?'`: `Let me look.` over
  `▸ Bash(echo hi)` asking, status `WAITING`. `drive.ts r tui key C-y`,
  `drive.ts r tui wait 'It printed hi.'`: `✓ allowed by ada`, `hi`, then the
  answer. `tools.ndjson` shows commits carrying `live` text, then the
  `tool_call`, `approval`, `approval_answer`, `tool_result` `hi\n`, the
  `message` and `run_end`. For the denial, `drive.ts r tui stop`, start a new
  TUI the same way, send the same and press `C-n`: `✗ denied by ada`,
  `denied: the person did not allow this call`, `I was not allowed to run it.`
  All four requests are `as recorded`.
- **Exec.** `drive.ts r up --fake-openai tool_denied,tool_call`,
  `drive.ts r nisse exec --provider openai 'what does echo say?'`: exit 0,
  stdout `Let me look.` and `I was not allowed to run it.`, stderr
  `denied Bash(echo hi): exec cannot ask, pass --auto to allow calls`. Then
  `drive.ts r nisse exec --provider openai --auto 'what does echo say?'`:
  exit 0, stdout ends `It printed hi.`. All four requests are `as recorded`.
- **Model.** `drive.ts r up --fake-openai text_answer,text_answer`,
  `drive.ts r nisse exec --provider openai --model gpt-5.5 --effort low hello`:
  exit 0, `Hello there`. Take the id from `drive.ts r rpc conversation/list`,
  run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": "bo", "selection": {"provider": "openai", "model": "gpt-5.5", "effort": "high"}}'`,
  then `drive.ts r nisse exec --conversation <id> hello`: exit 0.
  `fake-openai.ndjson` shows request 1 with `"reasoning": {"effort": "low"}`
  and request 2 with `"effort": "high"` and the first exchange in its
  `input`. Both are `differs`: the recording sent no effort, and the second
  recording held one prompt with no history. `watch <id>` shows the `model`
  entry between the two runs.
- **Models, signed in.** In a fake-signed-in run, `drive.ts r serve` and
  `drive.ts r rpc models/list '{}'`: `openai` has `"defaultModel": "gpt-5.5"`
  and the list nisse ships, `gpt-6.1-sol` first and `gpt-5.5` last, each
  with `efforts` and a `defaultEffort`. The fake ChatGPT has no model list,
  so `home/cache/openai-models.json` is not written.
- **Failures.** `drive.ts r up --fake-openai usage_limit,response_failed,stream_cut`,
  then `drive.ts r nisse exec --provider openai hello` three times: each
  exits 1, with stderr
  `You have hit your ChatGPT usage limit (plus plan).`, then
  `the response failed (server_error): The model crashed.`, then stdout
  `Hel` and stderr `the response stream ended before the response finished`.
- **Refresh, faked.** `drive.ts r up --fake-openai refresh --openai-refreshes 1`,
  then `cat /tmp/nisse-verify/r/home/auth/openai.json`: `"refresh_token": "first-refresh"`.
  `drive.ts r nisse exec --provider openai hello`: the fake turns the token
  down with a 401, nisse refreshes once and asks again, and the run exits 0
  with `Hello there`. The file now holds `"refresh_token": "refresh-1-refresh"`,
  a new `access_token` and a later `expires_at_ms`. Take the id from
  `drive.ts r rpc conversation/list` and run
  `drive.ts r nisse exec --conversation <id> again`: exit 0, `Hello again`,
  with no second refresh, so the file is unchanged. `fake-openai.ndjson`
  holds three requests, all `as recorded`, the third with the first exchange
  before `again`. `drive.ts r rpc providers/list '{}'` lists `openai` as
  `"status": "ready"`, `ada@example.com · ChatGPT Plus`.
- **Expired, faked.** `drive.ts r up --fake-openai refresh`, with no
  refreshes granted, then `drive.ts r nisse exec --provider openai hello`:
  the fake turns the token down with a 401, nisse refreshes once, the fake
  refuses the refresh, and the run exits 1 with
  `the ChatGPT sign-in expired; sign in again (token refresh failed (400: invalid_grant))`.
  `fake-openai.ndjson` holds only request 1, `as recorded`: the recording's
  retry and its second prompt are never asked. `drive.ts r rpc providers/list '{}'`
  lists `openai` as `"status": "signed_out"` with that message.
- **Signed out.** `drive.ts r up`, then
  `drive.ts r nisse exec --provider openai hi`. Exit 1, stderr
  `not signed in to ChatGPT: could not read /tmp/nisse-verify/r/home/auth/openai.json: ...`.
  The TUI journey is in [Providers](./providers.md).
- **Invalid.** In the same run, `mkdir -p /tmp/nisse-verify/r/home/auth`,
  write `{"nope": 1}` to `/tmp/nisse-verify/r/home/auth/openai.json` and run
  the same: exit 1, stderr
  `/tmp/nisse-verify/r/home/auth/openai.json is not valid`.
- **Expired, live.** Write
  `{"access_token": "x.e30.y", "refresh_token": "stale", "expires_at_ms": 0, "account_id": "acct"}`
  to that file and run the same: exit 1, stderr
  `the ChatGPT sign-in expired; sign in again (token refresh failed (401: Could not validate your token. Please try signing in again.))`.
  `drive.ts r rpc providers/list '{}'` then shows `openai` as
  `"status": "signed_out"` with that message. Run
  `drive.ts r rpc server/stop`, set `"expires_at_ms": 99999999999999`, and
  run the same: ChatGPT turns the token down, Nisse refreshes once, and the
  run fails with the same message.

## Gotchas

- The server reads the sign-in file on every request, so a changed file
  needs no server restart.
- A refresh may rotate the refresh token, leaving the copy the sign-in came
  from stale. `down` writes a refreshed `--openai-auth` sign-in back to its
  file; a sign-in copied in by hand must be copied back by hand.
- A refresh turned down keeps the provider listed signed out until the next
  sign-in or a new server, even after the file changes.
- `fake-openai.ndjson` logs requests for answers, not token refreshes: a
  refresh shows as the changed `auth/openai.json`.
- The fake ChatGPT proves what nisse does with a 401 and a refresh answer,
  not that ChatGPT's token service accepts nisse's refresh, nor ChatGPT's
  own model list; those are in the next section.

## With a real account

Needs a ChatGPT sign-in kept for verification, made once as SKILL.md's
[Real accounts](../SKILL.md#real-accounts) says (making it needs a person at
a browser). Run every step in one run started with
`drive.ts r up --openai-auth <that file>`, and run **Refresh** last, since it
rotates the sign-in; `down` writes the rotated one back. First check:
`drive.ts r serve` and `drive.ts r rpc providers/list '{}'` list `openai`
as `"status": "ready"` with your account. Otherwise stop and report what it
shows. Save `evidence/` and the steps' screens.

- **Answer and tools.** `drive.ts r tui start --provider openai`,
  `drive.ts r tui wait READY`, and take `<id>` from the header's
  `conversation <id>`. Send `Say hello in five words.`,
  `drive.ts r tui wait --timeout 120000 READY`,
  `drive.ts r tui screen answered`: `NISSE` over ChatGPT's answer. Then send
  `Use the Bash tool to run exactly: echo approved  Then reply with its output.`,
  `drive.ts r tui wait --timeout 120000 'allow this call?'`,
  `drive.ts r tui key C-y`, `drive.ts r tui wait --timeout 120000 READY`,
  `drive.ts r tui screen tools`: `✓ allowed by ada` and `approved`.
  `drive.ts r watch <id> --save real` keeps the commits. `drive.ts r tui stop`.
- **Exec.** `drive.ts r nisse exec --provider openai 'Use the Bash tool to run exactly: echo approved  Then reply with its output.'`:
  exit 0, stderr `› Bash(echo approved)` and
  `denied Bash(echo approved): exec cannot ask, pass --auto to allow calls`,
  and the answer says the call was not allowed. The same with `--auto`
  after `exec`: exit 0, no denial, and the answer holds `approved`.
- **Models.** `drive.ts r rpc models/list '{}'`: `openai`'s models as
  ChatGPT lists them today, and
  `/tmp/nisse-verify/r/home/cache/openai-models.json` holds the same
  slugs. Copy that file into `evidence/`.
- **Model.** Pick an `openai` model other than `gpt-5.5` from that list,
  and one of its `efforts`. If `cache/openai-models.json` gives it
  `"tool_mode": "code_mode_only"`, install the host first with
  `NISSE_HOME=/tmp/nisse-verify/r/home scripts/code-mode-host.sh`. Run
  `drive.ts r nisse exec --provider openai --model <model> --effort <effort> 'Say hello in five words.'`:
  exit 0 and an answer. `drive.ts r rpc conversation/list` holds a
  conversation whose `model` is `openai`, that model and that effort;
  `drive.ts r watch <its id> --save model` keeps its commits.
- **Refresh.** Set `expires_at_ms` in
  `/tmp/nisse-verify/r/home/auth/openai.json` to `0`, then
  `drive.ts r nisse exec --provider openai hi`: exit 0, and the file holds a
  new `access_token` and an `expires_at_ms` in the future.
  `drive.ts r down` writes it back to your file.
