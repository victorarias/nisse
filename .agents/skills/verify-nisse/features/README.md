# Nisse verification map

The maintained source for driving Nisse's user-facing behavior. Read this index
and the [skill](../SKILL.md) first, then follow the feature file as the recipe.
`drive.ts` below is `.agents/skills/verify-nisse/drive.ts`, run from the
repository root.

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
  `QUEUE · tab`, `STEER · tab`, `ADA`, `NISSE`, `allow this call?`,
  `SIGN IN · <provider>`, `MODEL`) over row and column positions.
- Wait for a run's end over the wire with `watch --until run_end`, and for a
  sign-in's step with `watch-auth --until <phase>`.
- `rpc` and `watch` need a running server, and an idle one exits after 30 s:
  when `doctor` shows `none running`, `drive.ts <run> serve` again.
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
then four H2s in this order: `Sub-features` (short ids, one line each),
`How to get to it (user POV)` (every entry point), `Driving it with drive.ts`
(`Preconditions:`, then labeled steps pairing an action, its exact command and
the observable result), and `Gotchas`. A feature that needs ChatGPT or Claude
drives them with `--fake-openai` or `--fake-claude` there, and adds a fifth H2,
`With a real account`, with the steps that only a real signed-in account can
prove, written so an agent that has one can run them cold. Keep implementation out; name user
paths, handles, state, commands and proof.

## Features

- [Ask and answer](./ask-and-answer.md): a prompt from the TUI, `exec` or the
  wire gets a streamed answer every client sees; `exec` exit codes.
- [Tool calls and approvals](./tool-calls-and-approvals.md): calls that change
  things wait for `^Y`, `^N` or `approval/resolve`; `exec` denies them and
  `--auto` allows them.
- [Interrupt](./interrupt.md): `Esc` or `conversation/interrupt` stops a run
  and keeps what was said.
- [Queue](./queue.md): prompts sent while Nisse works wait in a queue everyone
  sees, then run in order; a resent `requestId` queues once.
- [Steering](./steering.md): `Tab` or `"steer": true` sends a prompt that
  reaches the model at its next step, inside the same run; replayed for Claude
  (one and two steers, between parallel calls) and ChatGPT.
- [Providers](./providers.md): `--provider` or `conversation/start` picks one,
  `config.toml` adds more with their own `binary`, `env` and `args`, and
  `NISSE_CLAUDE` names Claude Code; an unknown one is refused, a signed-out one
  fails the run.
- [Claude](./claude.md): Claude Code's answers, approvals, reads that don't
  ask, session resume and lost sessions, cut-off calls, health, model and model
  switches, instructions, and the retelling when a conversation switches to
  Claude.
- [OpenAI](./openai.md): ChatGPT's answers and tools, a token refresh granted
  or refused, and sign-in failures.
- [Instructions and skills](./skills.md): `skills/list`, `/name` and `$name`
  carry a skill's `SKILL.md` with a message; OpenAI is told the `AGENTS.md`
  files and skills; Claude Code runs its own skills.
- [Code mode](./code-mode.md): OpenAI's code-mode models run nisse's tools
  from scripts in `codex-code-mode-host`; a missing host fails the run, and a
  script stopped by `Esc`, `wait`, a dead host or a server stop tells the model
  what its calls finished.
- [Subagents](./subagents.md): OpenAI and scripted models start subagents,
  each a conversation under its parent, shown as cards whose calls `^Y` and
  `^N` answer; follow-ups, history forks, model overrides, `[agents]` limits
  and `exec` denials; agent types from `.claude/agents`; Claude Code's own
  subagents; `Esc` stops them all, or one from its own pane.
- [Sign-in](./sign-in.md): the splash, `^L`, `nisse login` and `logout`, and
  `auth/*` show, start, answer and cancel a sign-in by browser, device code or
  Claude Code's terminal.
- [Models](./models.md): `--model`, `--effort`, `/model` and
  `conversation/select_model` choose a conversation's model; `config.toml`
  and the model chosen last set the default.
- [Reopen and resume](./reopen.md): quitting prints how to reopen; reopening
  and resubscribing with `sinceSeq` show the same committed transcript.
- [Server lifecycle](./server-lifecycle.md): one server per home, started on
  demand, refusing a second, exiting 30 s after its last client leaves;
  `serve --restart` replaces it once runs settle; `nisse schema` prints the
  protocol schema.
- [Crash recovery](./crash-recovery.md): a run cut off by a killed server
  finishes when the server comes back, scripted or with a Claude Code subagent
  mid-run; the third crash in a row ends it.
- [Quiet when idle](./quiet-when-idle.md): an idle TUI and server use no CPU.
- [Extensions](./extensions.md): extensions in `NISSE_HOME/extensions` add
  and remove tools, hook calls before and after they run, shape each request
  to an OpenAI model, and show a status line and toasts, on every provider and
  on Claude through Claude Code; failing or slow hooks and loads become toasts
  and `failed`; `nisse extensions` lists them and `reload` reloads them.
- [Status and chosen ids](./status.md): `status/watch` follows every tree's
  status and how its runs end, a conversation says how its last run ended, and
  `conversation/start` takes a chosen `id`.
