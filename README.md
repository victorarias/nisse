# Nisse

A durable, multiplayer coding agent. One Rust app server owns every conversation
and commits each step to SQLite before anyone sees it; thin clients draw what it
commits. The first is a neon cyberpunk terminal UI, which is also how
[attn](https://github.com/SolenesInc/attn) hosts Nisse. Luau extensions change
what the agent does and what every client draws.

![The neon TUI](docs/chat.png)

Design: [Nisse: architecture and design](https://claude.ai/artifact/PNaHXc93MxhqwD6QLhXW6y).

## Status

Milestone 0, the scaffold. What runs today:

- The app server over an in-process channel, stdio, and a unix-socket WebSocket.
- A SQLite commit log of conversations, entries and submissions. Inputs are
  idempotent by `request_id`, queue as follow-ups or steers, and a run cut off
  by a crash is answered after reopening.
- An echo model that runs `bash` for input starting with `!`, so the
  tool path and its hooks are real before the providers land.
- Luau extensions with `tool.call` and `prompt.submit` hooks, `nisse.ui.status`
  and `nisse.ui.toast`.
- The neon TUI, which attaches to a running server or embeds one.

Next: real model providers and tool tasks with checkpoints (M1). See the design
doc for the full plan.

## Try it

```sh
cargo build
target/debug/nisse                      # the TUI, with a server in-process
target/debug/nisse exec '!ls'           # one prompt, headless
target/debug/nisse serve --listen 127.0.0.1:7477   # a server for other clients
target/debug/nisse schema               # the protocol's JSON Schema
```

`NISSE_HOME` (default `~/.nisse`) holds `nisse.sqlite`, `nisse.sock` and
`extensions/`. A TUI or `exec` attaches to `NISSE_HOME/nisse.sock` when a server
runs there. `NO_COLOR` or `NISSE_THEME=plain` turns the colours off.
`NISSE_ECHO_THINK_MS` sets how long the echo model pretends to think.

## Extensions

An extension is a folder in `NISSE_HOME/extensions/` or `.nisse/extensions/`
with an `init.luau` that returns `function(on, options)`.

```luau
return function(on)
  on("tool.call", { tool = "bash" }, function(nisse, e, next)
    if e.args.command:match("^rm ") then
      return { deny = "guard: no rm here" }
    end
    local ran = next(e)
    nisse.ui.status(ran.is_error and "last command failed" or "all green")
    return ran
  end)
end
```

Extensions are written in [Luau](https://luau.org). Each one gets its own
sandboxed VM without `io`, `os` or `require`, with read-only globals and a time
budget per hook.

## Layout

| Crate | Owns |
| --- | --- |
| `nisse-protocol` | Wire types, the JSON-RPC envelope, transports, schema export |
| `nisse-core` | The store, conversations, the inbox and runs, the model and tool traits |
| `nisse-lua` | Extension loading and the `nisse` table |
| `nisse-server` | Connections and fan-out |
| `nisse-client` | A typed client |
| `nisse-tui` | The neon terminal UI |
| `nisse` | The binary |
