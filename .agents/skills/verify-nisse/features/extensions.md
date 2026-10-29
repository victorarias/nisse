# Extensions

A person drops TypeScript files into `NISSE_HOME/extensions` and the server
loads them when it starts. An extension adds, changes or removes tools, hooks
a call before it runs (to change its input or refuse it) and after it returns
(to change what the model sees), and tells the people in a conversation what
it does: a status line in the TUI's status bar and toasts in the transcript,
both committed so every client sees them. `nisse extensions` lists what loaded
and why anything failed; `nisse extensions reload` loads them again. They work
on every provider; on Claude they reach Claude Code through the Agent SDK.

## Sub-features

- `extensions-load` loads `extensions/<name>.ts` and `extensions/<name>/index.ts`
  in name order, with `[extensions.<name>]` from `config.toml` as
  `ctx.options`; `enabled = false` there lists it as `disabled`.
- `extensions-failed` lists an extension that fails to load, or takes over
  10 seconds to, as `failed` with why; the others load. The TUI shows
  `✗ extension <name> failed to load: <why>` when it opens, and
  `nisse extensions` exits 1.
- `tools-transform` adds a tool the model can call, replaces one of the same
  name, changes a tool's description or `readOnly`, or removes one, from each
  turn's start; a removed tool answers `no tool named <name>`.
- `execute-before` changes a call's input before approval, the run and the
  transcript, or refuses it: its result is
  `<name> refused this call: <reason>`, and nobody is asked.
- `execute-after` changes the output or error the model and the transcript
  get.
- `request-hook` (OpenAI only) adds the text an extension pushes to
  `instructions` to the model's instructions for each request, and offers the
  model only the tools left in `tools`.
- `hook-failure` turns a hook that fails or takes over 10 seconds into a toast
  `<hook> failed: <why>`; a failed `execute.before` refuses the call with
  `<name> refused this call: it failed: <why>`.
- `status-line` shows `<name>: <text>` in the TUI's status bar, as
  `extensionStatus` in a snapshot and in the commit that changes it.
- `toast` is a `toast` entry `{ extension, text }`, drawn as
  `◆ <name>: <text>` in the TUI and printed to stderr by `nisse exec`.
- `claude-extensions`: on Claude, an added tool is served from nisse's MCP
  server `nisse` (Claude calls `mcp__nisse__<name>`, the transcript says
  `<name>`), a removed tool is passed to Claude Code as `--disallowedTools`,
  `execute.before` runs as Claude Code's `PreToolUse` hook (subagents' calls
  too), and `execute.after` sees Claude Code's results but can't change them:
  a change becomes the toast
  `execute.after changed <tool>'s result, but Claude Code keeps its own tools' results`.
- `reload` (`nisse extensions reload` or `extensions/reload`) loads every
  extension again from disk while the loaded ones keep guarding calls, then
  swaps them in, clears every status line and unloads the old ones. A server
  start clears every status line before loading.

## How to get to it (user POV)

- Write `NISSE_HOME/extensions/<name>.ts` (or `<name>/index.ts`), importing
  `@nisse/extension` and `effect`; the server serves both.
- Set options in `NISSE_HOME/config.toml` under `[extensions.<name>]`.
- Run `nisse extensions` and `nisse extensions reload`, or call
  `extensions/list` and `extensions/reload`.
- Watch the TUI's status bar and transcript, `nisse exec`'s stderr, or a
  subscription's `extensionStatus` and `toast` entries.

## Driving it with drive.ts

Preconditions:

- A fresh run with `--script` steps
  `[{"tool": {"name": "Bash", "input": {"command": "rm -rf ~/precious"}}}, {"tool": {"name": "Bash", "input": {"command": "echo hello"}}}, {"text": "all done"}]`.
- In `/tmp/nisse-verify/<run>/home/extensions/`, a `guard.ts` whose
  `execute.before` refuses Bash commands with `rm -rf` and replaces `hello` in
  the `command` with `ctx.options.greeting`, keeping the input's other
  fields, and whose `execute.after` sets the status `last ran <tool>` and
  toasts `<tool> finished`; and a `broken.ts` holding `export default 42`. In
  the home's `config.toml`, `[extensions.guard]` with `greeting = "hallo"`.

- **List.** Run `drive.ts r nisse extensions`. It prints `broken  failed`
  with `it exports no extension; export default Extension.define(...)`, then
  `guard  loaded`, and exits 1.
- **Hooks in the TUI.** `drive.ts r tui start --auto`, wait for `READY`, type
  `tidy my home` and `Enter`, wait for `all done`. The screen shows
  `▸ Bash(rm -rf ~/precious)` with `guard refused this call: that deletes too much`,
  then `▸ Bash(echo hallo)` with `hallo` and `◆ guard: Bash finished`, the
  line `✗ extension broken failed to load: ...` over the prompt, and
  `guard: last ran Bash` in the status bar.
- **Committed.** Run `drive.ts r watch <conversation> --save second-client`.
  The snapshot's `extensionStatus` is `{"guard": "last ran Bash"}` and its
  entries include the `toast`.
- **Reload.** Edit `guard.ts`, delete `broken.ts`, run
  `drive.ts r nisse extensions reload`: it prints only `guard  loaded` and
  exits 0. The TUI's status bar loses `guard: last ran Bash`, and a new
  `watch` shows `"extensionStatus": {}`.
- **exec.** In a fresh run with the same script and `guard.ts`,
  `drive.ts r nisse exec --auto "tidy my home"` prints
  `◆ guard: Bash finished` to stderr and `all done` to stdout.
- **Request hook.** In a fresh run made with
  `drive.ts r up --fake-openai tool_call`, put a `focus.ts` in the home's
  `extensions/` whose `ctx.request.hook` pushes `Answer briefly.` to
  `request.instructions` and keeps only `Bash` in `request.tools`. Run
  `drive.ts r nisse exec --provider openai --auto "what does echo say?"`: it
  prints `Let me look.` and `It printed hi.` to stdout and `› Bash(echo hi)`
  to stderr, exit 0. Both requests in `evidence/fake-openai.ndjson` are
  `as recorded`, their `body.instructions` end with `Answer briefly.`, and
  their `body.tools` hold only `Bash`.
- **Claude, own tool.** In a fresh run made with
  `drive.ts r up --fake-claude own_tool`, put a `clock.ts` in the home's
  `extensions/` whose `ctx.tool.transform` adds a read-only `Clock` tool
  (input `{ zone: string }`, output `noon in <zone>`, description
  `The time in a zone`) and removes `WebFetch`. Run
  `drive.ts r tui start --provider claude`, wait for `READY`, type
  `what time is it` and `Enter`, wait for `It is noon in CET`: the screen
  shows `▸ Clock` with `noon in CET`, and no `allow this call?`.
  `drive.ts r watch <conversation> --save second-client` shows the entries
  `tool_call` with `"tool":"Clock","input":{"zone":"CET"}`, its `tool_result`
  `noon in CET`, the `message` and `run_end` `answered`. In
  `evidence/fake-claude/log.ndjson`, the spawn's `argv` holds
  `--disallowedTools=WebFetch,Clock` and its `initialize` has
  `"sdkMcpServers":["nisse"]`.
- **Claude, hook.** In a fresh run made with
  `drive.ts r up --fake-claude bash_hook_rewritten`, put the `guard.ts` from
  the preconditions in `extensions/` with its `execute.before` replacing
  `original` instead of `hello`, and `greeting = "rewritten"` under
  `[extensions.guard]`. Run
  `drive.ts r tui start --provider claude --model claude-haiku-5-5 --auto`,
  wait for `READY`, type
  ``Run the bash command `echo original` with the Bash tool, then reply with its output only.``
  and `Enter`, then wait for `The command was`. The screen shows
  `▸ Bash(echo rewritten)` with `rewritten` and `◆ guard: Bash finished`,
  and `guard: last ran Bash` in the status bar. The log's hook answer is
  `"hookEventName":"PreToolUse"` with
  `"updatedInput":{"command":"echo rewritten","description":"Print the word original"}`.
- **Claude, refusal.** In a fresh run made with
  `drive.ts r up --fake-claude bash_hook_denied`, put a `guard.ts` in
  `extensions/` whose `execute.before` refuses Bash commands that start with
  `touch` with `no touching`. Run
  `drive.ts r tui start --provider claude --model claude-haiku-5-5`, wait for
  `READY`, type
  ``Run the bash command `touch guarded.txt` with the Bash tool. If it is blocked, reply with only the reason it gave, word for word.``
  and `Enter`, wait for `no touching`, then for `READY`. The screen shows
  `▸ Bash(touch guarded.txt)` with `guard refused this call: no touching`,
  then the answer `no touching`, and no `allow this call?`.
  `drive.ts r watch <conversation> --save second-client` shows that
  `tool_result` with `"error":true`, the `message` `no touching` and
  `run_end` `answered`. The log's hook answer is
  `"permissionDecision":"deny"` with
  `"permissionDecisionReason":"guard refused this call: no touching"`; the
  recording answered `guard: no touching`, so only that reason differs from
  it.
- **Claude, subagent's call.** In a fresh run made with
  `drive.ts r up --fake-claude subagent_hooked`, put a `brief.ts` in
  `extensions/` whose `execute.before` adds `limit: 1` to every `Read`
  call's input. Run `drive.ts r tui start --provider claude`, wait for
  `READY`, type `what time is it` and `Enter`, and wait for
  `Under the floor`. The screen shows `▸ Agent` and the card
  `⧉ Find the gnome (general-purpose)` with `Read(<cwd>/notes.txt)`.
  `rpc conversation/list` shows a conversation whose `lineage.parent` is
  this one; `watch <subagent> --save subagent` shows its `tool_call`
  `Read` with `"input":{"file_path":"<cwd>/notes.txt","limit":1}`. The log
  holds one hook answer,
  `"updatedInput":{"file_path":"<cwd>/notes.txt","limit":1}`, for the
  subagent's call; the `Agent` call's hook is answered `{}`.
- **Hook failure.** In a fresh run with `--script` steps
  `[{"tool": {"name": "Bash", "input": {"command": "echo boom"}}}, {"tool": {"name": "Bash", "input": {"command": "echo slow"}}}, {"tool": {"name": "Bash", "input": {"command": "echo fine"}}}, {"text": "all done"}]`,
  put a `flaky.ts` in `extensions/` whose `execute.before` dies with
  `new Error("boom")` when the command holds `boom` and sleeps 11 seconds
  when it holds `slow`, and whose `execute.after` dies with
  `new Error("after broke")`. Run
  `drive.ts r nisse exec --auto "try the hooks"`: after about 11 s, stdout
  `all done`, exit 0, and stderr, in order,
  `◆ flaky: execute.before failed: boom`, `› Bash(echo boom)`,
  `◆ flaky: execute.before failed: Operation timed out after '10s'`,
  `› Bash(echo slow)`, `› Bash(echo fine)` and
  `◆ flaky: execute.after failed: after broke`.
  `watch <conversation> --save hook-failure` shows the first two calls'
  `tool_result`s `flaky refused this call: it failed: boom` and
  `flaky refused this call: it failed: Operation timed out after '10s'`,
  both `"error":true`, and the third `fine`.
- **Load limit.** In a fresh run, put the preconditions' `guard.ts` and a
  `sleepy.ts` holding
  `export default Extension.define(() => Effect.sleep("11 seconds"))` in
  `extensions/`. Run `drive.ts r nisse extensions`: after about 10 s it
  prints `guard  loaded` and `sleepy  failed` with
  `Operation timed out after '10s'`, and exits 1. This fails today: the
  first client gives up first, printing
  `nisse's server did not start; see <home>/nisse.log` with exit 1, and
  `drive.ts r serve` gives up the same way. The server does start; a second
  `drive.ts r nisse extensions` prints the expected list at once.

## Gotchas

- The TUI asks `extensions/list` once when it opens; a reload while it runs
  does not change the failed-to-load lines it shows.
- A toast is committed when the hook runs, so in the transcript it comes
  before the `tool_result` of the call it is about; the TUI draws it under the
  call.
- A Claude recording plays its answers whatever nisse sends it, so judge a
  Claude hook by the log's hook answer, not by the screen alone.
- The server loads extensions before it serves, so every client waits for the
  slowest one, up to the 10 s limit.
- In `subagent_hooked`, Claude Code's turn ends before its subagent reports,
  so the subagent's card and conversation end `interrupted`.

## With a real account

Proves Claude Code and a real model act on what an extension did. Follow the
skill's [Real accounts](../SKILL.md#real-accounts). No step needs a person.
Give every `tui wait` `--timeout 120000` and keep `evidence/`.

- **Claude, rewrite and refusal.** In a run made with
  `drive.ts r up --real-claude`, put the preconditions' `guard.ts` and
  `config.toml` in the home. Run `drive.ts r serve` and
  `drive.ts r rpc providers/list '{}'`: `claude` is `ready` with your
  account; otherwise stop and report what it shows. Run
  `drive.ts r tui start --provider claude --auto`, send
  `Use the Bash tool to run exactly: echo hello  Then reply with its output only.`,
  wait for `guard: Bash finished` and `READY`, then
  `drive.ts r tui screen claude-guard`: `▸ Bash(echo hallo)` with `hallo`,
  `◆ guard: Bash finished`, and `guard: last ran Bash` in the status bar.
  Then send
  `Use the Bash tool to run exactly: rm -rf /tmp/nisse-verify/r/precious  If it is refused, reply with only the reason it gave.`
  and wait for `READY`: the call's result is
  `guard refused this call: that deletes too much`, and the answer quotes
  that reason.
- **Claude, own tool.** In the same run, after `drive.ts r tui stop` and
  `drive.ts r rpc server/stop`, add the **Claude, own tool** `clock.ts`. Run
  `drive.ts r tui start --provider claude`, send
  `Use the Clock tool for the zone CET, then reply with its answer only.`,
  and wait for `READY`: `▸ Clock` with `noon in CET`, no `allow this call?`,
  and the answer `noon in CET`. This proves the tool reached Claude Code
  through nisse's MCP server, which the recording only replays.
- **OpenAI, request hook.** In a run made with
  `drive.ts r2 up --openai-auth <your sign-in>`, run the first check for
  `openai`, then put a `focus.ts` in `extensions/` whose request hook pushes
  `Whatever you are asked, reply with exactly: focused` to
  `request.instructions`. Run
  `drive.ts r2 nisse exec --provider openai 'Say hello.'`: stdout `focused`.
  `drive.ts r2 down` writes the sign-in back if a refresh rotated it.
