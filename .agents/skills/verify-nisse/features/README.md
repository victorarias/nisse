# Nisse verification map

The maintained source for driving Nisse's user-facing behavior. Read this index
and the [skill](../SKILL.md) first, then follow the feature file as the recipe.
`drive.ts` below is `.agents/skills/verify-nisse/drive.ts`, run from the
repository root.

## Audiences

| Audience | Ways in                                                                                                  | Source                                                           |
| -------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| People   | The TUI, and the `nisse` CLI in their own shell                                                          | `packages/nisse/src/tui/main.tsx`, `packages/nisse/src/main.ts`  |
| Agents   | JSON-RPC over the socket, such as attn; scripts calling `nisse exec`; `AGENTS.md` and skills Nisse reads | `packages/nisse/src/server.ts`, `packages/protocol/src/index.ts` |

## Baseline preconditions

- `bun install` has run in this checkout, and `tmux` and `lsof` are installed.
- A fresh run: `drive.ts <run> up`, with `--script` when the feature says so.
- `drive.ts <run> doctor` ends with `ok`.
- Nothing is driven that this run did not start.

## Driving conventions

- Start each recipe from a fresh run unless it says otherwise; `down` between
  recipes.
- Wait for screen text or a commit's entry tag, never for time. The one
  exception is the idle exit, whose 30 s is the promise itself.
- Prefer the handles the TUI draws (`READY`, `WORKING`, `WAITING`, `PROMPT`,
  `QUEUE · tab`, `STEER · tab`, `ADA`, `NISSE`, `allow this call?`,
  `SIGN IN · <provider>`, `MODEL`) over row and column positions.
- Wait for a run's end over the wire with `watch --until run_end`, and for a
  sign-in's step with `watch-auth --until <phase>`.
- Commands are literal. Keep quoted text and flags as written.

## Proof and skip reporting

- TUI proof is a saved screen before and after the action, with `steps.log`.
- CLI proof is the saved `nisse` output: command, stdout, stderr, exit code.
- Commit proof is a saved `watch`, from a client other than the one that acted.
- Persistence proof is a second, fresh view of the same conversation.
- Name the feature and entry point with each piece of evidence.
- Report an entry point you could not drive with the command you tried and the
  missing precondition. A different entry point is not proof of it.

## Feature entry contract

Each feature file starts with an H1 and one paragraph on what the user sees,
then these H2s in this order: `Sub-features` (short ids, one line each),
`How to get to it` (every entry point, under `### People` and `### Agents`,
each saying `None.` when it has none, and `### Triggers` when something starts
the feature without anyone invoking it), `Driving it with drive.ts`
(`Preconditions:`, then labeled steps pairing an action, its exact command and
the observable result), `Contexts` (only those that apply), `Tests` (pointers
to the committed tests by name, grouped by kind) and `Gotchas`. Keep
implementation out; name user paths, handles, state, commands and proof.

## Contexts

Conditions a feature can behave differently under. Drive the ones its file
lists when a change touches them.

- **Second client.** Another client is subscribed to the same conversation.
- **Server restart.** The server stops or crashes and a client brings it back.
- **Provider.** Claude Code runs its own tools and session; on OpenAI, Nisse
  runs the loop; the scripted provider stands in for both.
- **Subagents.** The conversation has a tree under it.
- **SSH.** `SSH_CONNECTION` or `SSH_TTY` is set.
- **Idle.** No client is connected, or a helper process has been idle.
- **Inside an agent.** `drive.ts` runs inside a Claude Code or attn session and
  inherits its variables.
- **macOS.** `/tmp` is a link to `/private/tmp`, so a process reports its
  working directory under `/private/tmp`. CI runs on Linux only.

## Features

- [Ask and answer](./ask-and-answer.md) (people, agents): a prompt from the TUI, `exec` or the
  wire gets a streamed answer every client sees; `exec` exit codes.
- [Tool calls and approvals](./tool-calls-and-approvals.md) (people, agents): calls that change
  things wait for `^Y`, `^N` or `approval/resolve`; `exec` denies them and
  `--auto` allows them.
- [Interrupt](./interrupt.md) (people, agents): `Esc` or `conversation/interrupt` stops a run
  and keeps what was said.
- [Queue](./queue.md) (people, agents): prompts sent while Nisse works wait in a queue everyone
  sees, then run in order.
- [Steering](./steering.md) (people, agents): `Tab` or `"steer": true` sends a prompt that
  reaches the model at its next step, inside the same run.
- [Providers](./providers.md) (people, agents): `--provider` or `conversation/start` picks one,
  `config.toml` adds more; an unknown one is refused, a signed-out one fails
  the run.
- [Claude](./claude.md) (people, agents): Claude Code's answers, approvals, session resume and
  cut-off calls; needs a signed-in Claude Code.
- [OpenAI](./openai.md) (people, agents): ChatGPT's answers and tools, token refresh and
  sign-in failures; the real journeys need a ChatGPT sign-in.
- [Instructions and skills](./skills.md) (people, agents): `skills/list`, `/name` and `$name`
  carry a skill's `SKILL.md` with a message; OpenAI is told the `AGENTS.md`
  files and skills.
- [Code mode](./code-mode.md) (people, agents): OpenAI's code-mode models run nisse's tools
  from scripts in `codex-code-mode-host`; a missing host fails the run.
- [Subagents](./subagents.md) (people, agents): OpenAI and scripted models start subagents,
  each a conversation under its parent, shown as cards whose calls `^Y` and
  `^N` answer; `Esc` stops them all.
- [Sign-in](./sign-in.md) (people, agents): the splash, `^L`, `nisse login` and `logout`, and
  `auth/*` show, start, answer and cancel a sign-in by browser, device code
  or Claude Code's terminal.
- [Models](./models.md) (people, agents): `--model`, `--effort`, `/model` and
  `conversation/select_model` choose a conversation's model; `config.toml`
  and the model chosen last set the default.
- [Reopen and resume](./reopen.md) (people, agents): quitting prints how to reopen; reopening
  and resubscribing show the same committed transcript.
- [Server lifecycle](./server-lifecycle.md) (people, agents, triggers): one server per home, started on
  demand, refusing a second, exiting when idle, replaced with `--restart`.
- [Wire protocol](./wire-protocol.md) (people, agents): the JSON Schema clients build from,
  `initialize`, and how a subscription that falls behind is ended.
- [Crash recovery](./crash-recovery.md) (triggers): a run cut off by a killed server
  finishes when the server comes back.
- [Quiet when idle](./quiet-when-idle.md) (people): an idle TUI and server use no CPU.
- [Extensions](./extensions.md) (people, agents): extensions in `NISSE_HOME/extensions` add
  and remove tools, hook calls before and after they run, and show a status
  line and toasts; `nisse extensions` lists them and `reload` reloads them.
- [Status and chosen ids](./status.md) (agents): `status/watch` follows every tree's
  status and how its runs end, a conversation says how its last run ended, and
  `conversation/start` takes a chosen `id`.
