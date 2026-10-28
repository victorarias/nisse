# Nisse

Read the README, then the plan and design docs it links. Nisse's vocabulary: a
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
bun run check   # tsc, prettier and bun test
```

Before reporting a change done, drive it with the `verify-nisse` skill
(`.agents/skills/verify-nisse`) and show its evidence. A change to a
user-facing behavior updates that skill's feature map in the same PR.

## Testing

Every test defends one promise that a person, a client, an extension or a later
version relies on, and its name says what they would see if it broke. Tests
enter where those consumers enter:

| Kind   | Enters through                                                                          | Lives in                             |
| ------ | --------------------------------------------------------------------------------------- | ------------------------------------ |
| Wire   | a real server in process, driven as a raw JSON-RPC client over its socket               | `packages/nisse/test/wire.test.ts`   |
| Screen | the real TUI in a PTY on an `@xterm/headless` screen, typed into, against a real server | `packages/nisse/test/screen.test.ts` |
| Stack  | the `nisse` binary over its socket: kill, restart, reconnect                            | `packages/nisse/test/stack.test.ts`  |

Recorded provider exchanges from the Rust version wait in `fixtures/` for the
provider tests.

- The model is the seam. Tests script it (`scriptedModel`, `NISSE_MODEL_SCRIPT`)
  or replay a provider's recorded exchange; nothing else is faked.
- Judge the TUI by its screen.
- The committed `schema/nisse.schema.json` is what clients build from. After a
  protocol change run `bun run schema`.
- Wait on events with a deadline, never sleep. A flaky test is a bug: fix it,
  never retry it.
- Each test gets its own `NISSE_HOME` under `/tmp` (a socket path must stay
  under 108 bytes) and stops any server it started.
- Don't test what the compiler guarantees, don't assert on your own fakes, and
  don't read source files in tests.
