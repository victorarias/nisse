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
- `extensions-failed` lists an extension that fails to load as `failed` with
  why; the others load. The TUI shows
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

## How to get to it

### People

- Write `NISSE_HOME/extensions/<name>.ts` (or `<name>/index.ts`), importing `@nisse/extension` and `effect`; the server serves both.
- Set options in `NISSE_HOME/config.toml` under `[extensions.<name>]`.
- Run `nisse extensions` and `nisse extensions reload`.
- Watch the TUI's status bar and transcript.

### Agents

- Call `extensions/list` and `extensions/reload`.
- Read `nisse exec`'s stderr, or a subscription's `extensionStatus` and `toast` entries.

## Driving it with drive.ts

Preconditions:

- A fresh run with `--script` steps
  `[{"tool": {"name": "Bash", "input": {"command": "rm -rf ~/precious"}}}, {"tool": {"name": "Bash", "input": {"command": "echo hello"}}}, {"text": "all done"}]`.
- In `/tmp/nisse-verify/<run>/home/extensions/`, a `guard.ts` whose
  `execute.before` refuses commands with `rm -rf` and replaces `hello` with
  `ctx.options.greeting`, and whose `execute.after` sets the status
  `last ran <tool>` and toasts `<tool> finished`; and a `broken.ts` holding
  `export default 42`. In the home's `config.toml`,
  `[extensions.guard]` with `greeting = "hallo"`.

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

- **Request hook.** drive.ts can't fake ChatGPT, so use a short Bun script:
  start `FakeOpenAi` from `packages/nisse/test/support/openai.ts`, play
  `tool_call`, save a sign-in with its `signIn`, and put a `focus.ts` in the
  home's `extensions/` whose `ctx.request.hook` pushes `Answer briefly.` and
  keeps only `Bash`. Run `nisse exec --provider openai --auto "what does echo say?"`
  with `NISSE_HOME` and `NISSE_OPENAI_URL=<fake.base>`. It prints
  `It printed hi.`, and both requests in `fake.responses()` end their
  `instructions` with `Answer briefly.` and offer only `Bash`.

## Contexts

- **Provider.** On Claude the request hook does not run, and `execute.after` cannot change the results of Claude Code's own tools.
- **Server restart.** Status lines clear, so none outlives the code that set it.
- **Second client.** Status lines and toasts are committed, so every client sees them, then and later.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- an extension's tool answers the model's calls, and a tool it removes is gone
- an extension can refuse a call, change what runs and what the model sees, and tell people
- an extension that fails to load is listed with why, while the others load and run
- reloading runs the extensions as they are now, and no status outlives the code that set it
- while extensions reload, the loaded ones keep guarding calls until their replacements are ready
- a hook still running when its extension is unloaded can't bring back a status line

Screen, `packages/nisse/test/screen.test.ts`:

- a person sees what extensions say in the footer and the transcript, and which failed to load

Provider, `packages/nisse/test/openai.test.ts`:

- an extension's request hook adds instructions and narrows the tools of each request to the model
- a request hook that fails is skipped with a toast, and the model gets the request as it was

Provider, `packages/nisse/test/claude.test.ts`:

- an extension's tool reaches Claude through nisse's own MCP server, and a tool it removes is withheld
- an extension refuses a call Claude wants, in nisse's words, and Claude Code hears why
- an extension's rewrite of a call is what Claude Code runs and what the transcript shows
- an extension's hooks reach the calls of Claude's subagents, in the subagent's conversation
- execute.after sees what Claude Code's tools return, and says so when it can't change it

## Gotchas

- The TUI asks `extensions/list` once when it opens; a reload while it runs
  does not change the failed-to-load lines it shows.
- A toast is committed when the hook runs, so in the transcript it comes
  before the `tool_result` of the call it is about; the TUI draws it under the
  call.
- On Claude, drive the same `guard.ts` in a run whose home is signed in to
  Claude, with `tui start --provider claude --auto` and a prompt that makes
  Claude run `echo hello`: the screen shows `▸ Bash(echo hallo)`. Without a
  signed-in Claude, say that the Claude path is not verified.
