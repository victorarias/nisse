# Nisse

A durable, multiplayer coding agent. One server owns every conversation and
commits each step to SQLite before anyone sees it; thin clients draw what it
commits. The first client is a neon terminal UI.

Nisse is being rebuilt in TypeScript on Bun and Effect. The Rust version lives on
the `rust` branch.

- Plan: [Nisse rebuild: TypeScript, Bun and Effect v4](https://claude.ai/artifact/5Di7zNHvHZnSua5wC2dMVi)
- Design: [Nisse: architecture and design](https://claude.ai/artifact/PNaHXc93MxhqwD6QLhXW6y)

## Status

R7b, extensions on Claude. What runs today:

- One server per home, shared by every client. The TUI or `exec` starts it
  when none runs, and it exits 30 seconds after the last client leaves and the
  last run settles.
- A SQLite commit log of conversations, entries and submissions. Every change
  is one commit with a `seq`, published only after it is stored. Submissions
  are idempotent by request id, queue while a run is working, and show in the
  queue to everyone.
- A run is a sequence of entries: messages, tool calls, their results,
  approvals and their answers, and a `run_end` that says how it ended
  (`answered`, `interrupted`, `failed` or `restart_limit`).
- Built-in tools: `Read`, `Write`, `Edit`, `Bash`, `Grep` and `Glob`. Calls
  that change things wait for a person to allow them, unless the conversation
  was started with `--auto`. Any client can answer; the first answer counts.
  A command's output streams live while it runs, with
  `NISSE_ROOT_CONVERSATION` set to the id of the conversation people started,
  in a subagent too.
- Steering: a prompt sent mid-run with `steer` reaches the model at its next
  step instead of waiting for the run to end.
- Crash recovery. A run the server's crash cut off resumes when the server
  comes back: calls that were running are recorded as interrupted and the
  model carries on. A run that crashes the server three times in a row ends
  with `restart_limit` instead of looping.
- Streaming text, committed at most every 100 ms so every client sees the same
  words. `Esc` interrupts and keeps what was said.
- Clients resume from the last `seq` they saw. A client that falls 4096 commits
  behind is dropped and resubscribes; it never slows the server.
- Clients can follow every conversation people started without reading its
  transcript: `status/watch` reports each tree's status (`working`, `waiting`
  on a person anywhere in it, or `idle`) and how its runs end. A client can
  choose a new conversation's id; starting with an id that exists answers with
  that conversation.
- Providers. Claude through the Claude Agent SDK, which runs Claude Code with
  its own tools, permissions and session: nisse asks a person before the calls
  Claude Code would ask about, resumes Claude Code's session where nisse's
  transcript ends, and tells Claude which calls a crash cut off. OpenAI through
  a ChatGPT sign-in (the Codex Responses endpoint), where nisse runs the loop
  and its own tools and refreshes an expired token once. OpenAI's code-mode
  models run nisse's tools from JavaScript (see below). A scripted provider
  for tests.
- Providers and sign-in. `claude` and `openai` always exist, and
  `config.toml` adds more. Every client sees how each one is signed in, and
  any of them can start, follow, answer or cancel a sign-in.
- Models. A conversation's model is a provider, a model and a reasoning
  effort. Switching it is an entry everyone sees, and it takes effect from the
  next run. Switching providers keeps the conversation: OpenAI is sent the
  whole transcript, and a new Claude Code session is told the first prompt and
  as much of the newest history as fits in about 64,000 characters.
- Instructions and skills. A conversation can start with instructions of its
  own (`--instructions`), which its subagents don't get: Claude Code appends
  them to its own system prompt, and OpenAI is told them after the
  `AGENTS.md` files. Claude Code reads its own `CLAUDE.md` files and
  skills. OpenAI is told `NISSE_HOME/AGENTS.md`, then the `AGENTS.md` (or
  `AGENTS.override.md`) of each folder from the repository's root down to the
  conversation's directory, up to 32 KiB, and the skills it can use: each
  folder with a `SKILL.md` under `.agents/skills` or `.claude/skills` from the
  conversation's directory up to the repository's root, then under
  `NISSE_HOME/skills`; the nearest skill of a name wins. A message that starts
  with `/name` or holds `$name` carries that skill's `SKILL.md` with it, and
  every client sees which skills it carried.
- Subagents, each a conversation of its own under the one that started it:
  Codex's agent tools on OpenAI, and Claude Code's own subagents on Claude.
- Extensions: TypeScript files in `NISSE_HOME/extensions` that add, change
  or remove tools, hook a call before it runs and after it returns, and tell
  the people in a conversation what they do through a status line and toasts
  that every client sees. They work on every provider; on Claude through the
  Agent SDK (see below).
- The neon TUI, in OpenTUI with Solid.

## Try it

```sh
bun install
bun packages/nisse/src/main.ts                       # the TUI, in this directory
bun packages/nisse/src/main.ts --auto                # a conversation that runs calls without asking
bun packages/nisse/src/main.ts --provider openai     # a conversation with ChatGPT instead of Claude
bun packages/nisse/src/main.ts --model opus --effort high
bun packages/nisse/src/main.ts --instructions 'Answer in Swedish.'
bun packages/nisse/src/main.ts login openai          # sign in; --device-code to enter a code on any device
bun packages/nisse/src/main.ts logout openai
bun packages/nisse/src/main.ts --conversation <id>   # reopen a conversation, or start one with that id
bun packages/nisse/src/main.ts 'fix the build'       # open the TUI and send a first prompt
bun packages/nisse/src/main.ts exec 'hello'          # one prompt, headless; exits 1 if the run fails
bun packages/nisse/src/main.ts exec --auto 'fix it'  # exec denies calls that change things unless --auto
bun packages/nisse/src/main.ts serve                 # the home's server in the foreground
bun packages/nisse/src/main.ts serve --restart       # replace the running server once its runs settle
bun packages/nisse/src/main.ts extensions            # the home's extensions, and why any failed to load
bun packages/nisse/src/main.ts extensions reload     # load them again from disk
bun packages/nisse/src/main.ts schema                # the protocol's JSON Schema
```

In the TUI, `⏎` sends, `⇧⏎` or `^J` adds a line, `Esc` stops the run, and `^C`
quits and prints how to reopen the conversation. While a run works, `Tab`
switches the prompt between queueing and steering. `^Y` allows the call nisse
is asking about and `^N` denies it. The splash lists every provider and how it
is signed in; `^L` signs in to one that is signed out. `/model` lists every
provider's models: `↑↓` picks one, `←→` its effort, and `⏎` switches.

`NISSE_HOME` (default `~/.nisse`) holds `config.toml`, `store.sqlite`,
`nisse.sock`, `nisse.lock`, the background server's `nisse.log`, the
code-mode host under `bin/`, extensions under `extensions/`, ChatGPT
sign-ins under `auth/` (readable only by you), and the model lists ChatGPT
last sent under `cache/`. One server serves a home at a time.

### Providers and models

```toml
default_model = { provider = "openai", model = "gpt-5.5", effort = "high" }

[providers.claude-personal]
driver = "claude"
config_dir = "~/.claude-personal"   # Claude Code's CLAUDE_CONFIG_DIR: its own account
binary = "/opt/claude/bin/claude"   # optional, like env = { ... } and args = [ ... ]

[providers.openai-work]
driver = "openai"                   # a second ChatGPT account, in auth/openai-work.json
```

Claude Code keeps Claude's credentials: nisse asks it how it is signed in, and
signing in runs `claude auth login` in a terminal. ChatGPT signs in through a
browser, which calls back to port 1455; a browser on another machine can't, so
paste the address it ends on into the prompt, or sign in with a device code.
Over SSH, the TUI and `login` use a device code.

A new conversation takes `--provider`, `--model`, `--effort` and
`--instructions`. Otherwise it
takes `default_model` from the nearest `.nisse/config.toml` above its
directory, then from `NISSE_HOME/config.toml`, then the model chosen last, then
Claude. Claude's models are the ones Claude Code offers; OpenAI's come from
ChatGPT, then the list nisse saved last, then the list nisse ships with.
`NISSE_CLAUDE` names the `claude` binary a server this starts drives instead of
the one the Claude Agent SDK bundles.

### Code mode

Most of OpenAI's models work in code mode: they get two tools, `exec` and
`wait`, and write JavaScript that calls nisse's tools (`Read`, `Write`, `Edit`,
`Bash`, `Grep`, `Glob`, the agent tools, and Codex's `apply_patch`). Each call a script makes is
an ordinary nisse tool call under the script's own, committed and asked about
like any other; the model sees only the script and what it printed. Scripts run
in Codex's `codex-code-mode-host`, which nisse starts on the first script and
stops after five idle minutes. Install the pinned release with:

```sh
scripts/code-mode-host.sh   # into NISSE_HOME/bin
```

nisse looks for the host at `NISSE_CODE_MODE_HOST`, then in `NISSE_HOME/bin`,
then on `PATH`. `gpt-5.5` keeps direct tools and needs no host.

### Subagents

Claude keeps Claude Code's own subagents. Nisse commits what each one does into
a conversation of its own under its parent's, and a call it wants to make waits
for a person there. Such a subagent takes input only through its parent, and
ends when its parent's run does; `Esc` in its own conversation stops just it.

On OpenAI, nisse runs Codex's agent tools: `spawn_agent`, `send_message`,
`followup_task`, `wait_agent`, `list_agents` and `interrupt_agent`. A spawned
agent works in a conversation of its own, on its parent's provider and in its
directory, and is addressed by a task name such as `/root/explore`. It starts
from its parent's history unless told `fork_turns: "none"`, may name another
model of the same provider, and hands its last message of each run to its
parent. A new task starts a run; other messages join the recipient's run at its
next step, or its transcript when it has none.

The parent's transcript shows a card for each subagent: what it last did, and
whether it works, waits on a person or ended. A call a subagent asks about shows
on its card, and `^Y` or `^N` answers it from the parent. `Esc` stops the run
and every subagent's under it.

Agent types come from `.claude/agents/*.md`, from the directory up to the
repository root, then from Claude Code's config directory's `agents/`; a type's
`model` applies when it names an OpenAI model. How deep subagents nest and how
many run at once in one tree are set in `NISSE_HOME/config.toml`, with Codex's
defaults:

```toml
[agents]
max_depth = 1
max_threads = 6
```

When `NISSE_MODEL_SCRIPT` is set, a server this starts adds the scripted
provider and uses it by default; the variable names a JSON file of scripted
steps (or is empty), such as
`[{"tool": {"name": "Bash", "input": {"command": "ls"}}}, {"text": "hello", "delayMs": 50}, {"text": "half", "fail": "provider went away"}]`.
A step with a tool calls it and moves on to the next step; a step without one
ends the run. A step with `"agent": "/root/explore"` is played only by that
subagent; the others are the root's.

### Extensions

An extension is `NISSE_HOME/extensions/<name>.ts`, or a folder
`extensions/<name>/` with an `index.ts`. The server loads them in name order
when it starts, in its own process and with its full authority, and serves
them `effect` and `@nisse/extension` from its own copy, so an extension needs
no `package.json`. This one refuses forced pushes, adds a tool, and says what
it saw:

```ts
import { Extension, Tool } from "@nisse/extension"
import { Effect, Schema } from "effect"

export default Extension.define((ctx) =>
  Effect.gen(function* () {
    yield* ctx.tool.transform((tools) => {
      tools.add(
        Tool.make({
          name: "Clock",
          description: "The date and time on the server.",
          input: Schema.Struct({}),
          readOnly: true,
          run: () => Effect.succeed(Tool.ok(new Date().toISOString())),
        }),
      )
      tools.remove("Glob")
    })
    yield* ctx.tool.hook("execute.before", (call) =>
      call.tool === "Bash" && JSON.stringify(call.input).includes("push --force")
        ? Tool.refuse("force pushes need a person")
        : Effect.void,
    )
    yield* ctx.tool.hook("execute.after", (call) =>
      Effect.andThen(
        call.conversation.status(`last ran ${call.tool}`),
        call.outcome.error ? call.conversation.toast(`${call.tool} failed`) : Effect.void,
      ),
    )
  }),
)
```

- `ctx.tool.transform` edits the tools of each turn as it starts: `list`,
  `get`, `add` (replacing a tool of the same name), `update` (a tool's
  `description` or `readOnly`) and `remove`. `Tool.make` is how nisse's own
  tools are made; a tool that is not read-only asks before it runs.
- `execute.before` sees `{ conversation, call, tool, input }` and may change
  `input`, which is what a person is asked about, what runs and what the
  transcript shows. `Tool.refuse(reason)` ends the call with that reason
  instead. `execute.after` sees the call's `outcome` and may change what the
  model and the transcript get. Hooks run in load order, for every
  conversation and subagent, and each call of one has 10 seconds.
- `conversation.status(text)` sets the extension's line in that conversation's
  status bar, and `status()` clears it. `conversation.toast(text)` adds a line
  to its transcript. Both are committed, so every client sees them, then and
  later; providers never show them to the model.
- A hook that fails or times out tells the conversation in a toast. A failed
  `execute.before` refuses the call, and a failed `execute.after` leaves the
  outcome as it was.
- `[extensions.<name>]` in `config.toml` is the extension's `ctx.options`, and
  `enabled = false` there skips it. An extension has 10 seconds to load; one
  that fails is listed with why, and the TUI shows it when it opens.
- `nisse extensions reload` loads every extension again from disk. The ones
  loaded keep running until their replacements are ready; then they are
  unloaded and their status lines cleared. Restarting the server clears them
  too, so a line never outlives the code that set it.

On Claude, Claude Code runs its own tools, and extensions reach them through
the Agent SDK:

- A tool an extension adds is served from nisse's own in-process MCP server,
  `nisse`. Claude calls it as `mcp__nisse__<name>`; the transcript names it
  `<name>`.
- A tool an extension removes is withheld from Claude Code, including Claude
  Code tools nisse doesn't have, such as `WebFetch`. `update` doesn't reach
  Claude Code's own tools, which keep their own descriptions.
- `execute.before` runs for every call, a subagent's too, as Claude Code's
  `PreToolUse` hook: a refusal stops the call and a changed `input` is what
  Claude Code runs.
- `execute.after` sees what Claude Code's own tools return, as the model sees
  it, but can't change it: Claude Code keeps its own tools' results, and a
  change is reported in a toast. It can change the results of an extension's
  tools.

## Protocol

Clients speak newline-delimited JSON-RPC 2.0 over `NISSE_HOME/nisse.sock`.
[`schema/nisse.schema.json`](schema/nisse.schema.json) describes every method.
`conversation/subscribe` streams a snapshot, then each commit; each chunk is a
`{"id", "chunk": true, "result": [...]}` message, and the client acknowledges
it with `{"method": "@effect/rpc/Ack", "params": {"requestId": <id>}}` before
the next one comes.

## Layout

| Package             | Owns                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| `packages/protocol` | Wire types and the RPC group                                                      |
| `packages/nisse`    | The store, conversations and runs, the server, the client, the TUI and the binary |
