# Claude

A conversation started with `--provider claude` is answered by Claude Code
through the Claude Agent SDK, with Claude Code's own tools and session. Nisse
shows Claude's calls under `NISSE`, asks a person before the calls Claude Code
would ask about, resumes Claude Code's session where nisse's transcript ends,
and after a crash tells Claude which calls were cut off. A Claude Code that
cannot sign in ends the run failed with Claude Code's own message.

## Sub-features

- `claude-answer` streams Claude's answer and commits it as a `message`.
- `claude-approval` turns a Claude Code permission prompt into
  `allow this call?`; `^Y` lets the call run, `^N` refuses it.
- `claude-exec-deny` makes `exec` refuse Claude's calls that would ask, unless
  `--auto`.
- `claude-auto` lets every call run in a conversation started with `--auto`.
- `claude-resume` continues Claude Code's session in a reopened conversation,
  after the server restarted.
- `claude-cut-off` records a call the server's crash cut off as interrupted,
  and Claude answers knowing it was.
- `claude-sign-in-error` ends the run failed with Claude Code's message, exit
  1 from `exec`.

## How to get to it (user POV)

- Run `nisse --provider claude`, or `nisse` with no `NISSE_MODEL_SCRIPT`.
- Run `nisse exec --provider claude '<prompt>'`, with `--auto` to allow calls.
- Call `conversation/start` with `"provider": "claude"`.

## Driving it with drive.ts

Preconditions:

- A Claude Code signed in for the user running the server: its login, or
  `ANTHROPIC_API_KEY`, in the environment `drive.ts` runs in. Every journey
  but the sign-in error makes real Claude runs. Without a sign-in, only
  `claude-sign-in-error` can be driven.
- A fresh run with no script; every conversation names `--provider claude`.
- Commands that make Claude change files only touch files under
  `/tmp/nisse-verify/r`.

- **Ask and allow.** Run `drive.ts r tui start --provider claude`,
  `drive.ts r tui wait READY`,
  `drive.ts r tui type 'Use the Bash tool to run exactly: touch /tmp/nisse-verify/r/touched  Then reply with one word: done'`,
  `drive.ts r tui key Enter`,
  `drive.ts r tui wait --timeout 120000 'allow this call?'`,
  `drive.ts r tui screen asking`: `▸ Bash(touch /tmp/nisse-verify/r/touched)`,
  `allow this call?` and `◆ WAITING`. Run `drive.ts r tui key C-y`,
  `drive.ts r tui wait --timeout 120000 READY`,
  `drive.ts r tui screen allowed`: `✓ allowed by ada`, the call's result, and
  Claude's `done`. The file exists.
- **Resume.** Run `drive.ts r tui stop` and take the id from
  `resume with: nisse --conversation <id>`. Run `drive.ts r rpc server/stop`,
  then
  `drive.ts r nisse exec --conversation <id> 'Which path did you touch earlier in this conversation? Reply with the path only.'`.
  Exit 0 and stdout `/tmp/nisse-verify/r/touched`: the new server resumed
  Claude Code's session. `watch <id>` shows `tool_call`, `approval`,
  `approval_answer`, `tool_result`, `message` and `run_end` for the first
  run, then the second run's entries.
- **Exec denies.** Run
  `drive.ts r nisse exec --provider claude 'Use the Bash tool to run exactly: touch /tmp/nisse-verify/r/denied  If it is not allowed, reply with one word: refused'`.
  Exit 0, stderr `› Bash(touch /tmp/nisse-verify/r/denied)` and
  `denied Bash(...): exec cannot ask, pass --auto to allow calls`, Claude's
  answer on stdout, and no file.
- **Auto.** Run the same with `--auto` and `.../auto`: no denial, the file
  exists.
- **Cut off.** Run `drive.ts r tui start --provider claude --auto`, send
  `Use the Bash tool to run exactly: sleep 20; echo slept  Then tell me in one short sentence what happened to that call.`,
  `drive.ts r tui wait --timeout 120000 'Bash(sleep 20; echo slept)'`,
  `drive.ts r kill-server`, `drive.ts r tui wait --timeout 180000 READY`,
  `drive.ts r tui screen cut-off`. The call shows
  `interrupted; it may or may not have taken effect`, and Claude's answer
  says the call was interrupted. The snapshot holds one `tool_call`, its
  interrupted `tool_result`, a `message` and a `run_end` with
  `"outcome": "answered"`.
- **Sign-in error.** In a fresh run, run
  `ANTHROPIC_API_KEY=sk-ant-not-a-key drive.ts r nisse exec --provider claude hi`.
  Exit 1, empty stdout, stderr `Invalid API key · Fix external API key`. A
  signed-out Claude Code fails the same way with its own message.

## Gotchas

- Claude runs take seconds to a minute; give `tui wait` a long `--timeout`.
- The TUI's working directory is the checkout, and Claude Code works there.
  Name exact commands in prompts, and keep them out of the checkout.
- Claude Code runs in the server's environment: start a new server
  (`rpc server/stop`) after changing the sign-in or `ANTHROPIC_API_KEY`.
- Calls Claude Code allows on its own, by its settings or because they only
  read, run without `allow this call?`.
- Inside a Claude Code session, run `drive.ts` without that session's
  `CLAUDE_*`, `ANTHROPIC_*` and `CCR_*` variables and with `CLAUDE_CONFIG_DIR`
  set to a folder in the run, so the nested Claude Code keeps its sessions out
  of yours.
