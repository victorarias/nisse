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

Tests drive a real server as a protocol client (`crates/nisse-server/tests`).
Test promises clients rely on, not internals.
