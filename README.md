# Nisse

A durable, multiplayer coding agent. One Rust app server owns every conversation
and commits each step to SQLite before anyone sees it; thin clients draw what it
commits. The first is a neon cyberpunk terminal UI, which is also how
[attn](https://github.com/SolenesInc/attn) hosts Nisse. Luau extensions change
what the agent does and what every client draws.

![The neon TUI](docs/chat.png)

Design: [Nisse: architecture and design](https://claude.ai/artifact/PNaHXc93MxhqwD6QLhXW6y).

## Status

Milestone 1, a real agent. What runs today:

- Two providers. **Claude** runs through the Claude Code CLI and keeps Claude
  Code's own tools; Nisse speaks its stream-json control protocol, commits every
  message and tool call, runs the Luau hooks on each call, and turns Claude
  Code's permission asks into Nisse approvals. **OpenAI** runs through a ChatGPT
  sign-in, as the Codex CLI does, with Nisse running the agent loop and its own
  `Read`, `Write`, `Edit`, `Bash` and `Grep` tools, named and shaped like Claude
  Code's so one Luau hook works for both providers.
- Streaming text, committed at most every 100 ms, so a crash loses at most that.
- Approvals as entries: anyone in the conversation answers, once, from any
  client.
- A SQLite commit log of conversations, entries and submissions. Inputs are
  idempotent by `request_id`, queue as follow-ups or steers, and a run cut off
  by a crash is picked up after reopening; Claude resumes its own session at
  the last message Nisse committed.
- Luau extensions with `tool.call` and `prompt.submit` hooks, `nisse.ui.status`
  and `nisse.ui.toast`.
- The neon TUI, which attaches to a running server or embeds one.

Next: many clients on one conversation (M2). See the design doc for the plan.

## Try it

```sh
cargo build
target/debug/nisse                         # the TUI, with Claude, in this directory
target/debug/nisse login openai            # sign in with ChatGPT (--device on a headless box)
target/debug/nisse --provider openai       # the TUI, with OpenAI
target/debug/nisse exec 'what is in here?' # one prompt, headless; asks on stdin to approve
target/debug/nisse serve                   # a server on NISSE_HOME/nisse.sock for other clients
target/debug/nisse schema                  # the protocol's JSON Schema
```

`NISSE_HOME` (default `~/.nisse`) holds `nisse.sqlite`, `nisse.sock`,
`auth/` and `extensions/`. A TUI or `exec` attaches to `NISSE_HOME/nisse.sock`
when a server runs there; otherwise it runs one in-process.

| Setting | What it does |
| --- | --- |
| `--provider` / `NISSE_PROVIDER` | `claude` (default), `openai`, or `echo`, which echoes and runs `!command` without a model |
| `--model` / `NISSE_MODEL` | The provider's model; Claude Code's default, or `gpt-6.1-sol` |
| `--claude` / `NISSE_CLAUDE` | The `claude` binary to drive |
| `--record` / `NISSE_RECORD` | Save every provider exchange in this folder as a replayable test fixture |
| `NO_COLOR`, `NISSE_THEME=plain` | Turn the colours off |

### Recording fixtures

Provider tests replay real exchanges. To record OpenAI ones with your sign-in:

```sh
NISSE_RECORD=/tmp/rec target/debug/nisse --provider openai exec 'what does `echo hi` print?'
```

Each turn writes `/tmp/rec/openai-<id>.ndjson` with tokens, ids and paths
replaced by placeholders. Read it for personal text before committing it under
`crates/nisse-openai/tests/fixtures/`. Claude's fixtures re-record with
`NISSE_CLAUDE_LIVE=$(which claude) cargo test -p nisse-claude`.

## Extensions

An extension is a folder in `NISSE_HOME/extensions/` or `.nisse/extensions/`
with an `init.luau` that returns `function(on, options)`.

```luau
return function(on)
  on("tool.call", { tool = "Bash" }, function(nisse, e, next)
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
| `nisse-core` | The store, conversations, the inbox and runs, turns, approvals, built-in tools |
| `nisse-lua` | Extension loading and the `nisse` table |
| `nisse-claude` | Claude through Claude Code's stream-json control protocol, and its replay |
| `nisse-openai` | OpenAI's Responses API through a ChatGPT sign-in |
| `nisse-server` | Connections and fan-out |
| `nisse-client` | A typed client |
| `nisse-tui` | The neon terminal UI |
| `nisse` | The binary |
