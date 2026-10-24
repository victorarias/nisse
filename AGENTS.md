# Nisse

Read the README, then the design doc it links. Nisse's vocabulary: a
**conversation** is a transcript; an **entry** is one immutable record in it; a
**commit** is one atomic write with a `seq`; a **submission** is input handed to
a conversation; a **run** goes from an input to its answer.

Rules that keep it what it is:

- Only committed state is observable. Every change goes through one store
  commit, published after it is stored. Never show a client anything else.
- The server owns state and execution; clients only render.
- A connection never slows the server: each has a bounded queue and is dropped
  when it falls behind.
- Draw only on change. No CPU while idle.
- Before adding a layer, option, cache or guard, name the requirement it serves
  today.

Checks before a PR:

```sh
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --all
```

## Testing

Every test defends one promise that a person, a client, an extension or a later
version relies on, and its name says what they would see if it broke. Tests
enter where those consumers enter:

| Kind | Enters through | Lives in |
| --- | --- | --- |
| Wire | a real server driven as a protocol client, in process | `crates/nisse-server/tests` |
| Screen | the real TUI on a vt100 screen, typed into, against a real server | `crates/nisse-tui/tests` |
| Stack | the `nisse` binary over its socket: kill, restart, reconnect | `crates/nisse/tests` |
| Provider | a real provider against recorded exchanges: a local HTTP server for OpenAI, `nisse-claude-replay` for Claude | `crates/nisse-openai/tests`, `crates/nisse-claude/tests` |

Provider fixtures are real recordings wherever we can make them (`NISSE_RECORD`),
normalized so they hold no tokens, account ids or home paths. Hand-built ones
cover failures nobody can record on demand, like a stream cut mid-response.

- The model is the seam. Tests script it, or replay a provider's recorded
  exchange; nothing else is faked.
- Judge the TUI by its screen. Screen snapshots use `insta`; review changes with
  `cargo insta review` and commit the `.snap` files.
- The committed `schema/nisse.schema.json` is what clients build from. After a
  protocol change run `cargo run -q -p nisse -- schema > schema/nisse.schema.json`.
- Wait on events with a deadline, never sleep. A flaky test is a bug: fix it,
  never retry it.
- Don't test what the compiler guarantees, don't assert on your own fakes, and
  don't read source files in tests.
