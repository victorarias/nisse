# Nisse

A durable, multiplayer coding agent. One server owns every conversation and
commits each step to SQLite before anyone sees it; thin clients draw what it
commits. The first client is a neon terminal UI.

Nisse is being rebuilt in TypeScript on Bun and Effect. The Rust version lives on
the `rust` branch.

- Plan: [Nisse rebuild: TypeScript, Bun and Effect v4](https://claude.ai/artifact/5Di7zNHvHZnSua5wC2dMVi)
- Design: [Nisse: architecture and design](https://claude.ai/artifact/PNaHXc93MxhqwD6QLhXW6y)

## Status

R4, skills and code mode. What runs today:

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
  A command's output streams live while it runs.
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
- Providers. Claude through the Claude Agent SDK, which runs Claude Code with
  its own tools, permissions and session: nisse asks a person before the calls
  Claude Code would ask about, resumes Claude Code's session where nisse's
  transcript ends, and tells Claude which calls a crash cut off. OpenAI through
  a ChatGPT sign-in (the Codex Responses endpoint), where nisse runs the loop
  and its own tools and refreshes an expired token once. A scripted provider
  for tests.
- Providers and sign-in. `claude` and `openai` always exist, and
  `config.toml` adds more. Every client sees how each one is signed in, and
  any of them can start, follow, answer or cancel a sign-in.
- Models. A conversation's model is a provider, a model and a reasoning
  effort. Switching it is an entry everyone sees, and it takes effect from the
  next run. Switching providers keeps the conversation: OpenAI is sent the
  whole transcript, and a new Claude Code session is told the first prompt and
  as much of the newest history as fits in about 64,000 characters.
- Instructions and skills. Claude Code reads its own `CLAUDE.md` files and
  skills. OpenAI is told `NISSE_HOME/AGENTS.md`, then the `AGENTS.md` (or
  `AGENTS.override.md`) of each folder from the repository's root down to the
  conversation's directory, up to 32 KiB, and the skills it can use: each
  folder with a `SKILL.md` under `.agents/skills` or `.claude/skills` from the
  conversation's directory up to the repository's root, then under
  `NISSE_HOME/skills`; the nearest skill of a name wins. A message that starts
  with `/name` or holds `$name` carries that skill's `SKILL.md` with it, and
  every client sees which skills it carried.
- The neon TUI, in OpenTUI with Solid.

## Try it

```sh
bun install
bun packages/nisse/src/main.ts                       # the TUI, in this directory
bun packages/nisse/src/main.ts --auto                # a conversation that runs calls without asking
bun packages/nisse/src/main.ts --provider openai     # a conversation with ChatGPT instead of Claude
bun packages/nisse/src/main.ts --model opus --effort high
bun packages/nisse/src/main.ts login openai          # sign in; --device-code to enter a code on any device
bun packages/nisse/src/main.ts logout openai
bun packages/nisse/src/main.ts --conversation <id>   # reopen a conversation
bun packages/nisse/src/main.ts exec 'hello'          # one prompt, headless; exits 1 if the run fails
bun packages/nisse/src/main.ts exec --auto 'fix it'  # exec denies calls that change things unless --auto
bun packages/nisse/src/main.ts serve                 # the home's server in the foreground
bun packages/nisse/src/main.ts serve --restart       # replace the running server once its runs settle
bun packages/nisse/src/main.ts schema                # the protocol's JSON Schema
```

In the TUI, `⏎` sends, `⇧⏎` or `^J` adds a line, `Esc` stops the run, and `^C`
quits and prints how to reopen the conversation. While a run works, `Tab`
switches the prompt between queueing and steering. `^Y` allows the call nisse
is asking about and `^N` denies it. The splash lists every provider and how it
is signed in; `^L` signs in to one that is signed out. `/model` lists every
provider's models: `↑↓` picks one, `←→` its effort, and `⏎` switches.

`NISSE_HOME` (default `~/.nisse`) holds `config.toml`, `store.sqlite`,
`nisse.sock`, `nisse.lock`, the background server's `nisse.log`, ChatGPT
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

A new conversation takes `--provider`, `--model` and `--effort`. Otherwise it
takes `default_model` from the nearest `.nisse/config.toml` above its
directory, then from `NISSE_HOME/config.toml`, then the model chosen last, then
Claude. Claude's models are the ones Claude Code offers; OpenAI's come from
ChatGPT, then the list nisse saved last, then the list nisse ships with.
`NISSE_CLAUDE` names the `claude` binary a server this starts drives instead of
the one the Claude Agent SDK bundles.

When `NISSE_MODEL_SCRIPT` is set, a server this starts adds the scripted
provider and uses it by default; the variable names a JSON file of scripted
steps (or is empty), such as
`[{"tool": {"name": "Bash", "input": {"command": "ls"}}}, {"text": "hello", "delayMs": 50}, {"text": "half", "fail": "provider went away"}]`.
A step with a tool calls it and moves on to the next step; a step without one
ends the run.

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
