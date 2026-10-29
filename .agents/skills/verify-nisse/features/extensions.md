# Extensions

A person drops TypeScript files into `NISSE_HOME/extensions` and the server
loads them when it starts. An extension adds, changes or removes tools, hooks
a call before it runs (to change its input or refuse it) and after it returns
(to change what the model sees), and tells the people in a conversation what
it does: a status line in the TUI's status bar and toasts in the transcript,
both committed so every client sees them. `nisse extensions` lists what loaded
and why anything failed; `nisse extensions reload` loads them again. They work
on OpenAI and scripted conversations; Claude Code's own tools don't reach them
yet.

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
- `hook-failure` turns a hook that fails or takes over 10 seconds into a toast
  `<hook> failed: <why>`; a failed `execute.before` refuses the call with
  `<name> refused this call: it failed: <why>`.
- `status-line` shows `<name>: <text>` in the TUI's status bar, as
  `extensionStatus` in a snapshot and in the commit that changes it.
- `toast` is a `toast` entry `{ extension, text }`, drawn as
  `◆ <name>: <text>` in the TUI and printed to stderr by `nisse exec`.
- `reload` (`nisse extensions reload` or `extensions/reload`) unloads every
  extension, clears every status line, and loads them again from disk. A
  server start clears every status line before loading.

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

## Gotchas

- The TUI asks `extensions/list` once when it opens; a reload while it runs
  does not change the failed-to-load lines it shows.
- A toast is committed when the hook runs, so in the transcript it comes
  before the `tool_result` of the call it is about; the TUI draws it under the
  call.
- On Claude the hooks don't run and added tools are not offered; drive
  extensions with the scripted provider or OpenAI.
