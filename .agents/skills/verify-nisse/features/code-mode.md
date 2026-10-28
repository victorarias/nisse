# Code mode

Most of OpenAI's models work in code mode: instead of nisse's tools they get
`exec`, which runs a JavaScript script, and `wait`. Each call a script makes
(`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob` or `apply_patch`) is an
ordinary nisse call under the script's own: committed with the script's call
as its `parent`, shown as its own `▸ Tool(subject)`, and asked about when it
changes things. The model sees only the script and what it printed. Scripts
run in Codex's `codex-code-mode-host`, which `scripts/code-mode-host.sh`
installs; without it a code-mode run fails saying how to install it.
`gpt-5.5` keeps direct tools and needs no host.

## Sub-features

- `code-mode-models` puts the models ChatGPT marks code-mode-only in code
  mode: in the list nisse ships, every listed model but `gpt-5.5`, such as
  `gpt-5.6-terra` and `gpt-6-sol`.
- `code-mode-install` installs the pinned host with
  `scripts/code-mode-host.sh` into `NISSE_HOME/bin`, or the folder it is
  given, and prints its path; a second run finds it and prints the same path.
- `code-mode-find` uses `NISSE_CODE_MODE_HOST` when the server's environment
  sets it, else `NISSE_HOME/bin/codex-code-mode-host`, else
  `codex-code-mode-host` on `PATH`.
- `code-mode-missing` fails the run with
  `this model works in code mode, which needs Codex's codex-code-mode-host; install it with scripts/code-mode-host.sh, or point NISSE_CODE_MODE_HOST at it`,
  before it asks ChatGPT anything.
- `code-mode-calls` commits `exec` as a `tool_call` whose `input` is the
  script, then each call the script makes as a `tool_call` with
  `"parent": "<exec call>"` and its `tool_result`, then the script's result.
  The TUI shows `▸ exec`, then `▸ Bash(<command>)` and the rest.
- `code-mode-approvals` asks before a nested call that changes things, with
  `allow this call?`, `^Y`, `^N` or `approval/resolve`; `exec` denies them and
  `--auto` allows them, as for any call.
- `code-mode-host-life` starts the host on a conversation's first script,
  keeps one session per conversation so a later script can `load` what an
  earlier one `store`d, and stops it after five idle minutes.

## How to get to it (user POV)

- Run `scripts/code-mode-host.sh` once, then
  `nisse --provider openai --model <a code-mode model>` or
  `nisse exec --provider openai --model <model> '<prompt>'`.
- Switch a conversation to a code-mode model with `/model` or
  `conversation/select_model`.
- Set `NISSE_CODE_MODE_HOST` in the environment of the command that starts the
  server.

## Driving it with drive.ts

Preconditions:

- A fresh run. The missing host and the host lookup need no sign-in: a run
  that finds the host goes on to fail `not signed in to ChatGPT`.
- `code-mode-install` downloads from `github.com`.
- `code-mode-calls`, `code-mode-approvals` and `code-mode-host-life` make real
  ChatGPT runs and need a ChatGPT sign-in, as [OpenAI](./openai.md) says.
  Without one they are not verified.

- **Missing host.** Run
  `drive.ts r nisse exec --provider openai --model gpt-5.6-terra hi`: exit 1,
  empty stdout, stderr the `code-mode-missing` message. Run
  `drive.ts r tui start --provider openai --model gpt-5.6-terra`,
  `drive.ts r tui wait READY`, `drive.ts r tui type hi`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'code mode'`,
  `drive.ts r tui screen no-host`: `ADA` over `hi`, `✗ this model works in code mode, ...`,
  and `openai · gpt-5.6-terra` in the status bar.
- **Direct tools.** `drive.ts r nisse exec --provider openai --model gpt-5.5 hi`:
  exit 1 with `not signed in to ChatGPT`, not the host message.
- **Install.** Run `NISSE_HOME=/tmp/nisse-verify/r/home scripts/code-mode-host.sh`:
  it prints `/tmp/nisse-verify/r/home/bin/codex-code-mode-host`, and the
  folder holds `codex-code-mode-host.release`. The same `exec` now fails with
  `not signed in to ChatGPT`.
- **Variable.** `drive.ts r rpc server/stop`, move `home/bin` to
  `/tmp/nisse-verify/r/hostbin`, then
  `NISSE_CODE_MODE_HOST=/tmp/nisse-verify/r/hostbin/codex-code-mode-host drive.ts r nisse exec --provider openai --model gpt-5.6-terra hi`:
  `not signed in to ChatGPT`. Stop the server again and run it with
  `NISSE_CODE_MODE_HOST=/tmp/nisse-verify/r/nowhere`: the host message.
- **Calls, signed in.** With the host installed, run
  `drive.ts r tui start --provider openai --model gpt-5.6-terra`,
  `drive.ts r tui wait READY`, and send
  `Use exec to run a script that calls tools.Bash with the command 'echo approved', then reply with its output.`
  `drive.ts r tui wait --timeout 120000 'allow this call?'`: `▸ exec` and,
  under it, `▸ Bash(echo approved)` asking. `drive.ts r tui key C-y` and
  `drive.ts r tui wait --timeout 120000 READY`: `✓ allowed by ada`,
  `approved`, and the answer. `drive.ts r watch <id> --save code-mode` shows
  the `exec` `tool_call` with the script as `input`, the `Bash` `tool_call`
  with `"parent"` the `exec` call's id, its `approval`, `approval_answer` and
  `tool_result`, then the `exec` `tool_result` starting `Script completed`.
- **Denied and exec, signed in.** Send the same and press `C-n`: the `Bash`
  call shows `✗ denied by ada` and the script goes on. Run it through
  `drive.ts r nisse exec --provider openai --model gpt-5.6-terra '<same>'`:
  the nested call is denied without asking; with `--auto` it runs.
- **Patch, signed in.** Make `/tmp/nisse-verify/r/project`, run
  `drive.ts r rpc conversation/start '{"cwd": "/tmp/nisse-verify/r/project", "provider": "openai", "model": "gpt-5.6-terra", "approvals": "auto"}'`,
  then
  `drive.ts r watch <id> --submit 'Use exec and tools.apply_patch to create hello.txt containing hi.' --until run_end --timeout 120000 --save patch`:
  a nested `apply_patch` `tool_call` with a `parent`, and
  `/tmp/nisse-verify/r/project/hello.txt` holds `hi`.
- **Reopen, signed in.** `drive.ts r tui stop`, then
  `drive.ts r tui start --conversation <id>`: the same `▸ exec` and nested
  calls. Send `What did the last script print?`: ChatGPT answers from the
  script's output.

## Gotchas

- Code mode depends on the model's catalog entry, not on anything a person
  sets: ChatGPT's list once signed in, else the saved list, else the shipped
  one. `models/list` does not say which models use it.
- The host is looked for at each run's start, so installing it needs no
  server restart; `NISSE_CODE_MODE_HOST` is read when the server starts.
- A set `NISSE_CODE_MODE_HOST` that names no file is not passed over: the run
  fails with the host message even when `NISSE_HOME/bin` holds the host.
- With a code-mode model and no host, the host message comes before the
  sign-in check, so a signed-out person sees it first.
- The host is a 75 MB download; `scripts/code-mode-host.sh` checks its
  SHA-256 and replaces it only when the pinned release changes.
