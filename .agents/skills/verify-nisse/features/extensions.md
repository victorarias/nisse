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

- The extensions below, each written as is to its own file in `/tmp/nisse-ext/`
  (outside the checkout, so no run's `down` removes them). A step copies the
  ones it names into its run's home with
  `mkdir -p /tmp/nisse-verify/r/home/extensions && cp /tmp/nisse-ext/<file> /tmp/nisse-verify/r/home/extensions/`,
  before anything starts the run's server.
- Options go in the run's `config.toml`, appended with
  `printf '<toml>' >> /tmp/nisse-verify/r/home/config.toml`.
- `r` stands for your run id, in commands and paths alike.
- `broken.ts` holds the single line `export default 42`, and `off.ts` the
  single line `throw new Error("a disabled extension never runs")`.

`guard.ts`:

```ts
import { Extension, Tool } from "@nisse/extension"
import { Effect } from "effect"

export default Extension.define((ctx) =>
  Effect.gen(function* () {
    const replace = String(ctx.options.replace ?? "hello")
    const greeting = String(ctx.options.greeting ?? "hello")
    yield* ctx.tool.hook("execute.before", (call) =>
      Effect.gen(function* () {
        if (call.tool !== "Bash") return
        const input = call.input as { command: string }
        if (input.command.includes("rm -rf")) return yield* Tool.refuse("that deletes too much")
        if (input.command.startsWith("touch")) return yield* Tool.refuse("no touching")
        call.input = { ...input, command: input.command.replaceAll(replace, greeting) }
      }),
    )
    yield* ctx.tool.hook("execute.after", (call) =>
      Effect.gen(function* () {
        yield* call.conversation.status(`last ran ${call.tool}`)
        yield* call.conversation.toast(`${call.tool} finished`)
      }),
    )
  }),
)
```

`guard.ts` refuses Bash commands holding `rm -rf` or starting with `touch`,
replaces `[extensions.guard] replace` (default `hello`) in a command with
`greeting`, keeping the input's other fields, and after each call sets the
status `last ran <tool>` and toasts `<tool> finished`.

`clock.ts`:

```ts
import { Extension, Tool } from "@nisse/extension"
import { Effect, Schema } from "effect"

export default Extension.define((ctx) =>
  ctx.tool.transform((tools) => {
    tools.add(
      Tool.make({
        name: "Clock",
        description: "The time in a zone",
        input: Schema.Struct({ zone: Schema.String }),
        readOnly: true,
        run: ({ zone }) => Effect.succeed(Tool.ok(`noon in ${zone}`)),
      }),
    )
    tools.remove("WebFetch")
  }),
)
```

`tidy.ts`:

```ts
import { Extension } from "@nisse/extension"

export default Extension.define((ctx) =>
  ctx.tool.transform((tools) => {
    tools.remove("Glob")
    tools.update("Read", (tool) => {
      tool.readOnly = false
    })
    tools.update("Bash", (tool) => {
      tool.description = "Run one shell command and return what it prints."
    })
  }),
)
```

`shout.ts`:

```ts
import { Extension } from "@nisse/extension"
import { Effect } from "effect"

export default Extension.define((ctx) =>
  ctx.tool.hook("execute.after", (call) =>
    Effect.sync(() => {
      call.outcome.output = call.outcome.output.toUpperCase()
    }),
  ),
)
```

`focus.ts`:

```ts
import { Extension } from "@nisse/extension"
import { Effect } from "effect"

export default Extension.define((ctx) =>
  ctx.request.hook((request) =>
    Effect.sync(() => {
      request.instructions.push(String(ctx.options.instruction ?? "Answer briefly."))
      request.tools = request.tools.filter((name) => name === "Bash")
    }),
  ),
)
```

`brief.ts`:

```ts
import { Extension } from "@nisse/extension"
import { Effect } from "effect"

export default Extension.define((ctx) =>
  ctx.tool.hook("execute.before", (call) =>
    Effect.sync(() => {
      if (call.tool === "Read") call.input = { ...(call.input as object), limit: 1 }
    }),
  ),
)
```

`flaky.ts`:

```ts
import { Extension } from "@nisse/extension"
import { Effect } from "effect"

export default Extension.define((ctx) =>
  Effect.gen(function* () {
    yield* ctx.tool.hook("execute.before", (call) => {
      const command = String((call.input as { command?: string }).command)
      if (command.includes("boom")) return Effect.die(new Error("boom"))
      if (command.includes("slow")) return Effect.sleep("11 seconds")
      return Effect.void
    })
    yield* ctx.tool.hook("execute.after", () => Effect.die(new Error("after broke")))
  }),
)
```

`sleepy.ts`:

```ts
import { Extension } from "@nisse/extension"
import { Effect } from "effect"

export default Extension.define(() => Effect.sleep("11 seconds"))
```

- **List.** In a fresh run with `--script` steps
  `[{"tool": {"name": "Bash", "input": {"command": "rm -rf ~/precious"}}}, {"tool": {"name": "Bash", "input": {"command": "echo hello"}}}, {"text": "all done"}]`,
  copy in `guard.ts` and `broken.ts` and append
  `[extensions.guard]\ngreeting = "hallo"\n` to `config.toml`. Run
  `drive.ts r nisse extensions`. It prints
  `broken  failed  <home>/extensions/broken.ts  it exports no extension; export default Extension.define(...)`,
  then `guard  loaded  <home>/extensions/guard.ts`, and exits 1.
- **Hooks in the TUI.** In the same run, `drive.ts r tui start --auto`, wait
  for `READY`, type `tidy my home` and `Enter`, wait for `all done` and
  `READY`, then `drive.ts r tui screen hooks`. The screen shows
  `▸ Bash(rm -rf ~/precious)` with `guard refused this call: that deletes too much`
  and no toast, then `▸ Bash(echo hallo)` with `hallo` and
  `◆ guard: Bash finished`, the line
  `✗ extension broken failed to load: it exports no extension; export default Extension.define(...)`
  over the prompt, and `READY  guard: last ran Bash` in the status bar.
- **Committed.** Run `drive.ts r rpc conversation/list` for the `<id>`, then
  `drive.ts r watch <id> --save second-client`. The snapshot's
  `extensionStatus` is `{"guard":"last ran Bash"}` and its entries include
  `{"_tag":"toast","extension":"guard","text":"Bash finished"}`.
- **Reload.** Run `rm /tmp/nisse-verify/r/home/extensions/broken.ts` and
  `drive.ts r nisse extensions reload`: it prints only `guard  loaded ...` and
  exits 0. `drive.ts r tui wait 'guard: last ran' --gone` returns, and a new
  `drive.ts r watch <id>` shows `"extensionStatus":{}`.
- **exec.** In a fresh run with the same script, `guard.ts` and
  `config.toml`, `drive.ts r nisse exec --auto "tidy my home"` prints
  `all done` to stdout and, to stderr, `› Bash(rm -rf ~/precious)`,
  `› Bash(echo hallo)` and `◆ guard: Bash finished`, exit 0.
- **Tools, folder form and disabled.** In a fresh run with `--script` steps
  `[{"tool": {"name": "Clock", "input": {"zone": "CET"}}}, {"tool": {"name": "Glob", "input": {"pattern": "*"}}}, {"tool": {"name": "Read", "input": {"file_path": "/etc/hostname"}}}, {"tool": {"name": "Bash", "input": {"command": "echo hi"}}}, {"text": "tools done"}]`,
  copy `clock.ts` to `/tmp/nisse-verify/r/home/extensions/clock/index.ts`
  (`mkdir -p` that folder first), copy in `tidy.ts`, `shout.ts` and
  `off.ts`, and append `[extensions.off]\nenabled = false\n` to
  `config.toml`. `drive.ts r nisse extensions` prints
  `clock  loaded  <home>/extensions/clock/index.ts`, `off  disabled`,
  `shout  loaded` and `tidy  loaded`, exit 0. Run `drive.ts r tui start`
  (no `--auto`), wait for `READY`, type `use your tools` and `Enter`, wait for
  `allow this call?` and `drive.ts r tui screen read-asks`: `▸ Clock` ran
  without asking and shows `NOON IN CET`, `▸ Glob(*)` shows
  `no tool named Glob`, and `▸ Read(/etc/hostname)` asks, since `tidy`
  made it not read-only. Press `C-y`, wait for `Bash(echo hi)` and
  `allow this call?`, press `C-y`, wait for `tools done` and `READY`: the
  Read's result is the host name in capitals and the Bash's `HI`.
  `drive.ts r watch <id> --save tools` holds the `tool_result`s
  `NOON IN CET`, `no tool named Glob` with `"error":true`, the capitalised
  Read and `HI\n`, and an `approval` entry for the Read and the Bash only.
- **What the model sees, on OpenAI.** In a fresh run made with
  `drive.ts r up --fake-openai tool_call`, copy in `tidy.ts` and `shout.ts`.
  Run `drive.ts r nisse exec --provider openai --auto "what does echo say?"`:
  stdout `Let me look.` and `It printed hi.` (the recording's words), stderr
  `› Bash(echo hi)`, exit 0. In `evidence/fake-openai.ndjson` both requests'
  `body.tools` lack `Glob` and describe `Bash` as
  `Run one shell command and return what it prints.`; the first request is
  `as recorded`, and the second `differs` only in its `function_call_output`,
  `HI\n` where the recording sent `hi\n`.
- **Request hook.** In a fresh run made with
  `drive.ts r up --fake-openai tool_call`, copy in `focus.ts`. Run
  `drive.ts r nisse exec --provider openai --auto "what does echo say?"`: it
  prints `Let me look.` and `It printed hi.` to stdout and `› Bash(echo hi)`
  to stderr, exit 0. Both requests in `evidence/fake-openai.ndjson` are
  `as recorded`, their `body.instructions` end with `Answer briefly.`, and
  their `body.tools` hold only `Bash`.
- **Claude, own tool.** In a fresh run made with
  `drive.ts r up --fake-claude own_tool`, copy in `clock.ts`. Run
  `drive.ts r tui start --provider claude`, wait for `READY`, type
  `what time is it` and `Enter`, wait for `It is noon in CET` and `READY`: the
  screen shows `▸ Clock` with `noon in CET`, and no `allow this call?`.
  `drive.ts r watch <id> --save second-client` shows the entries
  `tool_call` with `"tool":"Clock","input":{"zone":"CET"}`, its `tool_result`
  `noon in CET`, the `message` `It is noon in CET.` and `run_end` `answered`.
  In `evidence/fake-claude/log.ndjson`, the spawn's `argv` holds
  `--disallowedTools=WebFetch,Clock` and its `initialize` has
  `"sdkMcpServers":["nisse"]`.
- **Claude, hook.** In a fresh run made with
  `drive.ts r up --fake-claude bash_hook_rewritten`, copy in `guard.ts` and
  append `[extensions.guard]\nreplace = "original"\ngreeting = "rewritten"\n`
  to `config.toml`. Run
  `drive.ts r tui start --provider claude --model claude-haiku-5-5 --auto`,
  wait for `READY`, type
  ``Run the bash command `echo original` with the Bash tool, then reply with its output only.``
  and `Enter`, then wait for `The command was` and `READY`. The screen shows
  `▸ Bash(echo rewritten)` with `rewritten` and `◆ guard: Bash finished`,
  and `guard: last ran Bash` in the status bar. The log's hook answer is
  `"hookEventName":"PreToolUse"` with
  `"updatedInput":{"command":"echo rewritten","description":"Print the word original"}`.
- **Claude, refusal.** In a fresh run made with
  `drive.ts r up --fake-claude bash_hook_denied`, copy in `guard.ts`. Run
  `drive.ts r tui start --provider claude --model claude-haiku-5-5`, wait for
  `READY`, type
  ``Run the bash command `touch guarded.txt` with the Bash tool. If it is blocked, reply with only the reason it gave, word for word.``
  and `Enter`, wait for `no touching`, then for `READY`. The screen shows
  `▸ Bash(touch guarded.txt)` with `guard refused this call: no touching`,
  then the answer `no touching`, and no `allow this call?`.
  `drive.ts r watch <id> --save second-client` shows that
  `tool_result` with `"error":true`, the `message` `no touching` and
  `run_end` `answered`. The log's hook answer is
  `"permissionDecision":"deny"` with
  `"permissionDecisionReason":"guard refused this call: no touching"`; the
  recording answered `guard: no touching`, so only that reason differs from
  it.
- **Claude, subagent's call.** In a fresh run made with
  `drive.ts r up --fake-claude subagent_hooked`, copy in `brief.ts`. Run
  `drive.ts r tui start --provider claude`, wait for `READY`, type
  `what time is it` and `Enter`, and wait for `Under the floor` and `READY`.
  The screen shows `▸ Agent` and the card
  `⧉ Find the gnome (general-purpose)` with `Read(<cwd>/notes.txt)`.
  `drive.ts r rpc conversation/list` shows a conversation whose
  `lineage.parent` is this one; `drive.ts r watch <subagent> --save subagent`
  shows its `tool_call` `Read` with
  `"input":{"file_path":"<cwd>/notes.txt","limit":1}`. The log holds one hook
  answer, `"updatedInput":{"file_path":"<cwd>/notes.txt","limit":1}`, for the
  subagent's call; the `Agent` call's hook is answered `{}`.
- **Claude, a result it can't change.** In a fresh run made with
  `drive.ts r up --fake-claude parallel_reads_hooked`, copy in `shout.ts`.
  Run `drive.ts r tui start --provider claude --model claude-haiku-5-5`,
  wait for `READY`, type
  `In a single message, call the Read tool twice in parallel: once on a.txt and once on b.txt. Then reply with both contents, separated by a comma.`
  and `Enter`, and wait for `banana` and `READY`. The screen shows
  `▸ Read(<cwd>/a.txt)` with `apple`, `▸ Read(<cwd>/b.txt)` with `banana`,
  two toasts
  `◆ shout: execute.after changed Read's result, but Claude Code keeps its own tools' results`,
  and the answer `apple`, `,`, `banana`. `drive.ts r watch <id> --save second-client`
  has both `toast` entries and the `tool_result`s `1\tapple\n2\t` and
  `1\tbanana\n2\t`, as Claude Code returned them, not in capitals.
- **Hook failure.** In a fresh run with `--script` steps
  `[{"tool": {"name": "Bash", "input": {"command": "echo boom"}}}, {"tool": {"name": "Bash", "input": {"command": "echo slow"}}}, {"tool": {"name": "Bash", "input": {"command": "echo fine"}}}, {"text": "all done"}]`,
  copy in `flaky.ts`. Run `drive.ts r nisse exec --auto "try the hooks"`:
  after about 11 s, stdout `all done`, exit 0, and stderr, in order,
  `◆ flaky: execute.before failed: boom`, `› Bash(echo boom)`,
  `◆ flaky: execute.before failed: Operation timed out after '10s'`,
  `› Bash(echo slow)`, `› Bash(echo fine)` and
  `◆ flaky: execute.after failed: after broke`.
  `drive.ts r watch <id> --save hook-failure` shows the first two calls'
  `tool_result`s `flaky refused this call: it failed: boom` and
  `flaky refused this call: it failed: Operation timed out after '10s'`,
  both `"error":true`, and the third `fine`.
- **Load limit.** In a fresh run made with `drive.ts r up`, copy in
  `guard.ts` and `sleepy.ts`. Run `drive.ts r nisse extensions`: after about
  10 s it prints `guard  loaded ...` and
  `sleepy  failed  <home>/extensions/sleepy.ts  Operation timed out after '10s'`,
  and exits 1. This fails today: this first client gives up before the server
  has loaded, printing `nisse's server did not start; see <home>/nisse.log`
  with exit 1. The server does start: a second `drive.ts r nisse extensions`
  prints the expected list at once. In a fresh run, `drive.ts r serve` before
  the first `nisse extensions` returns after about 10 s, and the list then
  comes at once.

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
- `execute.after` runs only for a call that ran: a refused call, or a call to
  a removed tool, gets no `execute.after`, so no status or toast from it.
- `nisse extensions` starts the home's server when none runs, so copy the
  extensions in before it; a server started before them needs
  `drive.ts r nisse extensions reload`.

## With a real account

Proves Claude Code and a real model act on what an extension did. Follow the
skill's [Real accounts](../SKILL.md#real-accounts). No step needs a person.
Give every `tui wait` `--timeout 120000` and keep `evidence/`.

- **Claude, rewrite and refusal.** In a run made with
  `drive.ts r up --real-claude`, copy in the preconditions' `guard.ts` and
  append `[extensions.guard]\ngreeting = "hallo"\n` to `config.toml`. Run `drive.ts r serve` and
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
  `drive.ts r rpc server/stop`, copy in `clock.ts`. Run
  `drive.ts r tui start --provider claude`, send
  `Use the Clock tool for the zone CET, then reply with its answer only.`,
  and wait for `READY`: `▸ Clock` with `noon in CET`, no `allow this call?`,
  and the answer `noon in CET`. This proves the tool reached Claude Code
  through nisse's MCP server, which the recording only replays.
- **OpenAI, request hook.** In a run made with
  `drive.ts r2 up --openai-auth <your sign-in>`, run the first check for
  `openai`. Copy in `focus.ts`, append
  `[extensions.focus]\ninstruction = "Whatever you are asked, reply with exactly: focused"\n`
  to `config.toml`, and run `drive.ts r2 nisse extensions reload`, since the
  first check started the server. Run
  `drive.ts r2 nisse exec --provider openai 'Say hello.'`: stdout `focused`.
  `drive.ts r2 down` writes the sign-in back if a refresh rotated it.
