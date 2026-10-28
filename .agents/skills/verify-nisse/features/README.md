# Nisse verification map

The maintained source for driving Nisse's user-facing behavior. Read this index
and the [skill](../SKILL.md) first, then follow the feature file as the recipe.
`drive.ts` below is `.agents/skills/verify-nisse/drive.ts`, run from the
repository root.

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
  `QUEUE · tab`, `STEER · tab`, `ADA`, `NISSE`, `allow this call?`) over row
  and column positions.
- Wait for a run's end over the wire with `watch --until run_end`.
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
the observable result), and `Gotchas`. Keep implementation out; name user
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
  sees, then run in order.
- [Steering](./steering.md): `Tab` or `"steer": true` sends a prompt that
  reaches the model at its next step, inside the same run.
- [Providers](./providers.md): `--provider` or `conversation/start` picks one;
  an unknown one is refused, a signed-out one fails the run.
- [Claude](./claude.md): Claude Code's answers, approvals, session resume and
  cut-off calls; needs a signed-in Claude Code.
- [OpenAI](./openai.md): ChatGPT's answers and tools, token refresh and
  sign-in failures; the real journeys need a ChatGPT sign-in.
- [Reopen and resume](./reopen.md): quitting prints how to reopen; reopening
  and resubscribing show the same committed transcript.
- [Server lifecycle](./server-lifecycle.md): one server per home, started on
  demand, refusing a second, exiting when idle.
- [Crash recovery](./crash-recovery.md): a run cut off by a killed server
  finishes when the server comes back.
- [Quiet when idle](./quiet-when-idle.md): an idle TUI and server use no CPU.
