# Nisse

A durable, multiplayer coding agent. One server owns every conversation and
commits each step to SQLite before anyone sees it; thin clients draw what it
commits. The first client is a neon terminal UI.

Nisse is being rebuilt in TypeScript on Bun and Effect. The Rust version lives on
the `rust` branch.

- Plan: [Nisse rebuild: TypeScript, Bun and Effect v4](https://claude.ai/artifact/5Di7zNHvHZnSua5wC2dMVi)
- Design: [Nisse: architecture and design](https://claude.ai/artifact/PNaHXc93MxhqwD6QLhXW6y)

## Status

R1, the foundations. What runs today:

- One server per home, shared by every client. The TUI or `exec` starts it
  when none runs, and it exits 30 seconds after the last client leaves and the
  last run settles.
- A SQLite commit log of conversations, entries and submissions. Every change
  is one commit with a `seq`, published only after it is stored. Submissions
  are idempotent by request id, queue while a run is working, and show in the
  queue to everyone. A run a crash cut off answers again when the server comes
  back.
- Streaming text, committed at most every 100 ms so every client sees the same
  words. `Esc` interrupts and keeps what was said.
- Clients resume from the last `seq` they saw. A client that falls 4096 commits
  behind is dropped and resubscribes; it never slows the server.
- A scripted model that echoes. Real providers come next: Claude through Claude
  Code, then OpenAI.
- The neon TUI, in OpenTUI with Solid.

## Try it

```sh
bun install
bun packages/nisse/src/main.ts                       # the TUI, in this directory
bun packages/nisse/src/main.ts --conversation <id>   # reopen a conversation
bun packages/nisse/src/main.ts exec 'hello'          # one prompt, headless; exits 1 if the run fails
bun packages/nisse/src/main.ts serve                 # the home's server in the foreground
bun packages/nisse/src/main.ts serve --restart       # replace the running server once its runs settle
bun packages/nisse/src/main.ts schema                # the protocol's JSON Schema
```

In the TUI, `⏎` sends, `⇧⏎` or `^J` adds a line, `Esc` stops the run, and `^C`
quits and prints how to reopen the conversation.

`NISSE_HOME` (default `~/.nisse`) holds `store.sqlite`, `nisse.sock`,
`nisse.lock` and the background server's `nisse.log`. One server serves a home
at a time. `NISSE_MODEL_SCRIPT` names a JSON file of scripted answers, such as
`[{"text": "hello", "delayMs": 50}, {"text": "half", "fail": "provider went away"}]`,
for a server this starts.

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
