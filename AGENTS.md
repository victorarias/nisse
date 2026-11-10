# Nisse

Nisse is a coding agent designed to be durable, to integrate with agent SDKs,
and to be multiplayer at its core. One server owns every conversation and
commits each step to SQLite before anyone sees it. Clients draw what it
commits; the first is a terminal UI. Models run through the Claude Agent SDK,
which drives Claude Code, or through a ChatGPT sign-in, where nisse runs the
loop and the tools itself.

## Where we are

Nisse is still being built and nobody depends on it yet. Choose the right
design over compatibility with what exists.

The kernel is being rebuilt on Effect, following pi-durable's model. The new
packages are built beside the code the binary runs and replace it in one
change. Until then `packages/nisse` and `packages/protocol` are what runs, and
their tests guard it.

## Domain language

These terms are nisse's domain model. Use them with these meanings in code,
tests, docs and conversation.

```text
home                    one directory of state, NISSE_HOME; like a tenant
├─ server (at most 1)   the process that owns the home's state and runs its work
├─ conversation (0..n)
├─ provider (1..n)      a way to reach models: Claude Code or a ChatGPT sign-in
└─ extension (0..n)     TypeScript the server loads to add tools and hooks
```

```text
conversation            one transcript and the work done in it; like one chat
├─ entry (0..n)         one immutable record in the transcript: a message, a
│                       tool call, a result, an approval, a run_end
├─ submission (0..n)    input handed to the conversation; it starts a run, or
│                       waits in the queue while a run works
├─ run (0..n)           the work from one input to its run_end; 1 at a time
│  ├─ turn (1..n)       one model response and its tool calls
│  └─ run_end (1)       the entry that says how the run ended
├─ model (1)            a provider, a model and a reasoning effort
└─ subagent (0..n)      a conversation started by this one, under it in a tree
```

```text
commit                  one atomic write to the store; the only way state
                        changes, and what clients are shown
client                  a program connected to the server's socket that draws
                        committed state and sends input; the TUI is one
approval                a tool call waiting for a person to allow or deny it;
                        the first answer counts
```

## Rules that keep it what it is

- Only committed state is observable. Every change goes through one store
  commit, published after it is stored. Never show a client anything else.
- The server owns state and execution; clients only render.
- A connection never slows the server: each has a bounded queue and is dropped
  when it falls behind.
- Draw only on change. No CPU while idle.
- Before adding a layer, option, cache or guard, name the requirement it serves
  today.

## Where to look

| To learn                                                     | Read                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| What nisse does, feature by feature, and how to drive each   | `.agents/skills/verify-nisse/features/README.md`          |
| The commands and flags                                       | `bun packages/nisse/src/main.ts --help`                   |
| What clients can call                                        | `schema/nisse.schema.json`, made from `packages/protocol` |
| What a package owns                                          | its `README.md`, or the exports in its `package.json`     |
| Which package may import which                               | `scripts/boundaries.ts`                                   |
| How the kernel is measured against pi-durable's suite        | `packages/conformance/README.md`                          |
| Which use cases have tests, and which wait on a rebuild step | `bun run coverage`                                        |

## Checks

```sh
bun run check   # what CI runs
```

- A change that adds, changes or deletes tests goes through the `verify-tests`
  skill.
- A change to a kernel package or `packages/conformance` goes through
  `verify-conformance`.
- Before reporting a change done, drive it with the `verify-nisse` skill and
  show its evidence. A change to a user-facing behavior updates that skill's
  feature map in the same PR.
- After a protocol change run `bun run schema` and commit the result.

The skills are in `.agents/skills`.

## Testing

Every test defends one promise that a person, a client, an extension or a later
version relies on, and its name says what they would see if it broke. Tests
enter where those consumers enter:

| Kind     | Enters through                                                                                                                          | Lives in                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Wire     | a real server in process, driven as a raw JSON-RPC client over its socket                                                               | `packages/nisse/test/wire.test.ts`                     |
| Screen   | the real TUI in a PTY on an `@xterm/headless` screen, typed into, against a real server                                                 | `packages/nisse/test/screen.test.ts`                   |
| Stack    | the `nisse` binary over its socket: kill, restart, reconnect                                                                            | `packages/nisse/test/stack.test.ts`                    |
| Provider | a wire test whose provider is a fake server replaying a recorded exchange from `fixtures/`                                              | `packages/nisse/test/openai.test.ts`, `claude.test.ts` |
| Package  | a package's public API, only for specified logic with a large input space (as tables or properties) or a promise no wire test can reach | `packages/<name>/test`                                 |

- The model is the seam. Tests script it (the `script` provider,
  `NISSE_MODEL_SCRIPT`) or replay a provider's recorded exchange; nothing else
  is faked.
- Judge the TUI by its screen.
- A test's title starts with the feature-map use case it covers:
  `test("queue-show: ...")`. `bun run coverage` fails on a test that names no
  use case or an unknown one. A new feature adds its id and its test in the
  same change; see the feature map's README.
- Wait on events with a deadline, never sleep. A flaky test is a bug: fix it,
  never retry it.
- Each test gets its own `NISSE_HOME` under `/tmp` (a socket path must stay
  under 108 bytes) and stops any server it started.
- Don't test what the compiler guarantees, don't assert on your own fakes, and
  don't read source files in tests.

Provider tests replay recorded exchanges from `fixtures/`:

- The fake OpenAI server serves each `emit_inbound` frame, and the test checks
  every request against its `expect_outbound` frame, where `"<any>"` matches
  anything. A `hold_open` line leaves that reply's stream open until the test
  ends.
- The fake `claude` executable (`packages/nisse/test/support/fake-claude`)
  plays one recorded Claude Code process per spawn, and one recorded probe per
  probe (a spawn with `--no-session-persistence`). It logs what nisse sent it,
  and tests judge Claude by that log.
- Screen and stack tests point `NISSE_CLAUDE` at the fake `claude`, so no test
  reaches a real Claude. A stack test that needs ChatGPT points
  `NISSE_OPENAI_URL` at the fake OpenAI server.
