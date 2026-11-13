# Sigma verification map

The maintained source for driving Sigma's user-facing behavior. Read this index
and the [skill](../SKILL.md) first, then follow the feature file as the recipe.
`drive.ts` below is `.agents/skills/verify-sigma/drive.ts`, run from the
repository root.

## Audiences

| Audience | Ways in                                                                                                  | Source                                                           |
| -------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| People   | The TUI, and the `sigma` CLI in their own shell                                                          | `packages/sigma/src/tui/main.tsx`, `packages/sigma/src/main.ts`  |
| Agents   | JSON-RPC over the socket, such as attn; scripts calling `sigma exec`; `AGENTS.md` and skills Sigma reads | `packages/sigma/src/server.ts`, `packages/protocol/src/index.ts` |

## Baseline preconditions

- `bun install` has run in this checkout, and `tmux` and `lsof` are installed.
- A fresh run: `drive.ts <run> up`, with `--script`, `--fake-openai` or
  `--fake-claude` when the feature says so. Claude is then a signed-in fake
  that answers only the probe. Real accounts follow SKILL.md's Real accounts.
- `drive.ts <run> doctor` ends with `ok`.
- Nothing is driven that this run did not start.

## Driving conventions

- Start each recipe from a fresh run unless it says otherwise; `down` between
  recipes.
- Wait for screen text or a commit's entry tag, never for time. The one
  exception is the idle exit, whose 30 s is the promise itself.
- Prefer the handles the TUI draws (`READY`, `WORKING`, `WAITING`, `PROMPT`,
  `QUEUE · tab`, `STEER · tab`, `ADA`, `SIGMA`, `allow this call?`,
  `SIGN IN · <provider>`, `MODEL`) over row and column positions.
- Wait for a run's end over the wire with `watch --until run_end`, and for a
  sign-in's step with `watch-auth --until <phase>`.
- `rpc` and `watch` need a running server, and an idle one exits after 30 s:
  when `doctor` shows `none running`, `drive.ts <run> serve` again.
- Commands are literal. Keep quoted text and flags as written.

## Proof and skip reporting

- TUI proof is a saved screen before and after the action, with `steps.log`.
- CLI proof is the saved `sigma` output: command, stdout, stderr, exit code.
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
to the committed tests by name, grouped by kind) and `Gotchas`. A feature that
needs ChatGPT or Claude drives them with `--fake-openai` or `--fake-claude` in
`Driving it with drive.ts`, and ends with a further H2, `With a real account`,
with the steps that only a real signed-in account can prove, written so an
agent that has one can run them cold. Keep implementation out; name user
paths, handles, state, commands and proof.

## Use cases and coverage

Each sub-feature id is one use case, and the map is what `bun run coverage`
(part of `bun run check`) measures. A sub-feature line is:

```text
- `fork-at-entry` [kernel] one line on what it does
- `queue-show` shows a waiting prompt ...
```

The bracket is optional. No bracket means a `client` use case. `[kernel]`
marks one with no client path. Every use case is covered; the check fails on
one that is not, so a new feature adds its id and its test in the same change.

- A test covers a use case by starting its title with the id:
  `test("fork-at-entry: a fork sees only entries up to its fork point", ...)`.
  One test can name several: `test("queue-run, queue-shared: ...")`. Every
  test must name at least one known id. Skipped tests do not count.
- A `client` use case needs a test in `packages/sigma/test` that names it.
- A `kernel` use case needs a test that names it, or a mapped upstream row
  that is `pass`.
- `use-cases.json` maps each `packages/conformance/expected.json` row to the
  use cases it proves, because upstream titles cannot change. Every row that
  is not excluded must be mapped.
- `ledger.json` holds the feature ledger: each row lists its use cases or the
  decision that excludes it.

A new feature adds its id and its test in the same change.

### Kernel use cases

A feature file made of kernel use cases, or whose client path is not built yet,
keeps the entry contract's order but has no `drive.ts` steps: `How to get to it`
says `None.` or names the step that adds the path, `Sources` names the ledger
area in `ledger.json` and where the use cases come from in pi-durable (its
spec sections, its README's headings and its numbered examples), and `Tests` points at `bun run
coverage`. When the owning step adds a client path, it adds the entry points and
a `Driving it with drive.ts` recipe in the same change.

## Contexts

Conditions a feature can behave differently under. Drive the ones its file
lists when a change touches them.

- **Second client.** Another client watches the same conversation.
- **Server restart.** The server stops or crashes and a client brings it back.
- **Provider.** Claude Code runs its own tools and session; on OpenAI, Sigma
  runs the loop; the scripted provider and the recordings stand in for them.
- **Subagents.** The conversation has a tree under it.
- **SSH.** `SSH_CONNECTION` or `SSH_TTY` is set.
- **Idle.** No client is connected, or a helper process has been idle.
- **Inside an agent.** `drive.ts` runs inside a Claude Code or attn session and
  inherits its variables.
- **macOS.** `/tmp` is a link to `/private/tmp`, so a process reports its
  working directory under `/private/tmp`. CI runs `bun run check` on Linux
  and macOS.

## Features

- [Ask and answer](./ask-and-answer.md) (people, agents): a prompt from the TUI, `exec` or the
  wire gets a streamed answer every client sees; `exec` exit codes.
- [Tool calls and approvals](./tool-calls-and-approvals.md) (people, agents): calls that change
  things wait for `^Y`, `^N` or `approval/resolve`; `exec` denies them and
  `--auto` allows them.
- [Interrupt](./interrupt.md) (people, agents): `Esc` or `conversation/interrupt` stops a run
  and keeps what was said.
- [Queue](./queue.md) (people, agents): prompts sent while Sigma works wait in a queue everyone
  sees, then run in order; a resent `requestId` queues once.
- [Steering](./steering.md) (people, agents): `Tab` or `"steer": true` sends a prompt that
  reaches the model at its next step, inside the same run; replayed for Claude
  (one and two steers, between parallel calls) and ChatGPT.
- [Providers](./providers.md) (people, agents): `--provider` or `conversation/start` picks one,
  `config.toml` adds more, Claude ones with their own `binary`, `env` and `args`, and
  `SIGMA_CLAUDE` names Claude Code; an unknown one is refused, a signed-out one
  fails the run.
- [Claude](./claude.md) (people, agents): Claude Code's answers, approvals, reads that don't
  ask, session resume and lost sessions, cut-off calls, health, model and model
  switches, instructions, and the retelling when a conversation switches to
  Claude.
- [OpenAI](./openai.md) (people, agents): ChatGPT's answers and tools, a token refresh granted
  or refused, and sign-in failures.
- [Instructions and skills](./skills.md) (people, agents): `skills/list`, `/name` and `$name`
  carry a skill's `SKILL.md` with a message; OpenAI is told the `AGENTS.md`
  files and skills; Claude Code runs its own skills.
- [Code mode](./code-mode.md) (people, agents): ChatGPT's code-mode-only models get one
  `codemode` tool whose scripts call sigma's tools in a sandbox, asking like
  direct calls, and survive a server restart.
- [Subagents](./subagents.md) (people, agents): OpenAI and scripted models start subagents,
  each a conversation under its parent, shown as cards whose calls `^Y` and
  `^N` answer; follow-ups, history forks, model overrides, `[agents]` limits
  and `exec` denials; agent types from `.claude/agents`; Claude Code's own
  subagents; `Esc` stops them all, or one from its own pane.
- [Sign-in](./sign-in.md) (people, agents): the splash, `^L`, `sigma login` and `logout`, and
  `auth/*` show, start, answer and cancel a sign-in by browser, device code or
  Claude Code's terminal.
- [Models](./models.md) (people, agents): `--model`, `--effort`, `/model` and
  `conversation/select_model` choose a conversation's model; `config.toml`
  and the model chosen last set the default.
- [Reopen and resume](./reopen.md) (people, agents): quitting prints how to reopen; reopening
  and watching again show the same committed transcript.
- [Server lifecycle](./server-lifecycle.md) (people, agents, triggers): one server per home, started on
  demand, refusing a second, exiting 30 s after its last client leaves;
  `serve --restart` replaces it once runs settle.
- [Wire protocol](./wire-protocol.md) (people, agents): the JSON Schema clients build from,
  `initialize`, how a watch that falls behind is ended, and errors whose
  message says what went wrong.
- [Crash recovery](./crash-recovery.md) (triggers): a run cut off by a killed server
  finishes when the server comes back, scripted or with a Claude Code subagent
  mid-run; the third crash in a row ends it.
- [Quiet when idle](./quiet-when-idle.md) (people): an idle TUI and server use no CPU.
- [Extensions](./extensions.md) (people, agents): extensions in `SIGMA_HOME/extensions` add
  and remove tools, hook calls before and after they run, shape each request
  to an OpenAI model, and show a status line and toasts, on every provider and
  on Claude through Claude Code; failing or slow hooks and loads become toasts
  and `failed`; `sigma extensions` lists them and `reload` reloads them.
- [Slash commands](./commands.md) (people): `/help` lists the TUI's commands in
  a panel; a line naming no command goes to the model.
- [Status and chosen ids](./status.md) (agents): `status/watch` follows every tree's
  status and how its runs end, a conversation says how its last run ended, and
  `conversation/start` takes a chosen `id`.

## Kernel rebuild use cases

The use cases of the kernel rebuild, one file per feature-ledger area.

- [Commit line and session](./commit-line.md) (kernel): Every change to a conversation goes through one ordered, atomic store commit, and a session that cannot store fails once and loudly.
- [Context the model sees](./context.md) (kernel): What the model sees is derived from the recorded entries by written rules, so it can be worked out exactly and edited without touching history.
- [Conversations and forks](./conversations.md) (kernel): A conversation is created with its settings, listed, reopened, owned by a task or another conversation, and forked at any entry.
- [Reset and handoff](./reset.md) (kernel): A reset starts over with an empty context in the same conversation, history kept, optionally carrying a brief.
- [Compaction](./compaction.md) (kernel): Long conversations keep working: older context becomes a summary, automatically or on demand, and the raw history stays.
- [Submissions](./submissions.md) (kernel): Every input handed to a conversation is admitted by written rules, deduplicated, placed at a defined boundary, and ends with a recorded fate.
- [Run limits and resilience](./run-resilience.md) (kernel): A run stops at its limits with a named reason, survives provider hiccups and crashes, and keeps what was said.
- [Per-conversation agent and settings](./agent-settings.md) (kernel): A conversation's configuration is durable, forkable and watchable, and harness settings change without a restart.
- [System prompt and sections](./system-prompt.md) (kernel): Extensions contribute named prompt sections, and what the model was told is recorded in place so later changes keep the provider's cache.
- [Extensions and registry](./registry.md) (kernel): Extensions package tools, hooks, sections, tasks, entries and documents, install and reload at runtime, and are selected per conversation.
- [Hooks](./hooks.md) (kernel): Hooks let an extension shape requests, react to responses and tools, keep a run going, and start work at the end of a run, safely across restarts.
- [Tools](./tools.md) (kernel): Tools return separate channels for the model, programs and clients, are bounded and replay-safe, and can call each other under the same hooks.
- [Execution environments](./environments.md) (kernel): Tools work through an execution environment, per conversation, for commands, files and watches.
- [Images](./images.md) (kernel): People and tools attach images; large ones are prepared off the server's line, and a model without image input still works.
- [Watches and views](./views.md) (kernel): Clients and extensions follow conversations and documents through windowed views and in-process observers.
- [Child conversations](./child-conversations.md) (kernel): Delegated work runs in a child conversation owned by the task or conversation that started it, foreground or background.
- [Task kernel](./tasks.md) (kernel): Durable work is a task with phases and checkpoints, scheduled across restarts, waiting on other tasks, sleeping, and ending with a stored outcome.
- [Inbox](./inbox.md) (kernel): The queue of inputs is durable state any client can read.
- [Documents](./documents.md) (kernel): Typed JSON documents are committed with entries, scoped, forked, migrated and watched as small changes.
- [Usage and cost](./usage.md) (kernel): Tokens and cost are counted per conversation, model and tool, and totalled for the home.
- [Telemetry and reports](./telemetry-reports.md) (kernel): Runs, requests and tools emit spans and metrics, and problems nobody asked about reach someone as reports.
- [Storage](./storage.md) (kernel): Durable state lives behind a storage contract with a SQLite backend, bounded reads and ids that always increase.
- [Modes and patterns](./modes.md) (kernel): Whole-app patterns: print, JSON, plan mode, a reviewer and per-conversation sandboxes.
