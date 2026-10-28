# Nisse

A durable, multiplayer coding agent. One server owns every conversation and
commits each step to SQLite before anyone sees it; thin clients draw what it
commits. The first client is a neon terminal UI.

Nisse is being rebuilt in TypeScript on Bun and Effect. The Rust version lives on
the `rust` branch.

- Plan: [Nisse rebuild: TypeScript, Bun and Effect v4](https://claude.ai/artifact/5Di7zNHvHZnSua5wC2dMVi)
- Design: [Nisse: architecture and design](https://claude.ai/artifact/PNaHXc93MxhqwD6QLhXW6y)

## Status

R2, a real agent. What runs today:

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
- The neon TUI, in OpenTUI with Solid.

## Try it

```sh
bun install
bun packages/nisse/src/main.ts                       # the TUI, in this directory
bun packages/nisse/src/main.ts --auto                # a conversation that runs calls without asking
bun packages/nisse/src/main.ts --provider openai     # a conversation with ChatGPT instead of Claude
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
is asking about and `^N` denies it.

`NISSE_HOME` (default `~/.nisse`) holds `store.sqlite`, `nisse.sock`,
`nisse.lock`, the background server's `nisse.log`, and sign-ins under `auth/`.
Signing in from Nisse comes with R3; until then `auth/openai.json` is the one
the Rust version saved. One server serves a home
at a time. New conversations use Claude unless `--provider` names another. When
`NISSE_MODEL_SCRIPT` is set, a server this starts uses the scripted provider
instead; the variable names a JSON file of scripted steps (or is empty), such as
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
