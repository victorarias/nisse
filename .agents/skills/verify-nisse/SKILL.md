---
name: verify-nisse
description: Drive the real Nisse (its TUI in tmux, the nisse CLI, and the server's JSON-RPC socket) in a throwaway home and capture proof that a change works. Use before reporting any change to Nisse done, and to reproduce a bug a person reports.
---

# Verify Nisse

Prove a change by using Nisse the way its users do: a person at the TUI, a
script calling `nisse exec`, and a client speaking JSON-RPC over the home's
socket. Tests guard promises; this skill shows the change working once, on the
real surfaces, with evidence a reviewer can read. A green `bun run check` is not
that evidence.

Everything goes through one helper, run from the repository root:

```sh
.agents/skills/verify-nisse/drive.ts <run> <command> [args]
```

`<run>` is a short id you choose, such as `queue-1`. Each run gets its own
`NISSE_HOME` at `/tmp/nisse-verify/<run>/home`, its own tmux server
(`tmux -L nisse-verify-<run>`), and an evidence folder at
`/tmp/nisse-verify/<run>/evidence`. Runs never touch `~/.nisse` and never share
a server, so several can go at once. Run the helper with no arguments for its
usage.

## Launch

```sh
bun install                                                  # once per checkout
.agents/skills/verify-nisse/drive.ts r1 up                   # nisse echoes: "You said: <prompt>"
.agents/skills/verify-nisse/drive.ts r1 up --script s.json   # or scripted steps
```

The model is the only thing a run fakes. A script is a JSON array of steps,
the same format `NISSE_MODEL_SCRIPT` takes (see the README). The server takes
the steps in order across all its runs: a step says its `text`, then fails the
run with `fail`, or calls its `tool` and goes on to the next step in the same
run, or ends the run. Once the steps run out Nisse echoes, and a restarted
server starts them over. `--script` copies the file into the run, so later
edits to it do nothing. `up` with or without a script makes the scripted
provider the one a conversation falls back to; real providers and models are
chosen with `--provider` and `--model`, see [Providers](features/providers.md)
and [Models](features/models.md). A run's tmux server keeps the environment of
the `drive.ts` command that first opened a window in it, `serve` or
`tui start`: set variables such as `SSH_CONNECTION` on that command.

To drive ChatGPT or Claude without an account, a run can replay a recorded
exchange instead of a model:

```sh
drive.ts r1 up --fake-openai tool_call                 # fixtures/openai/tool_call.ndjson
drive.ts r1 up --fake-openai text_answer,text_answer   # one after the other
drive.ts r1 up --fake-claude bash_allowed              # fixtures/claude/bash_allowed.ndjson
```

`--fake-openai` signs the run's home in to a fake ChatGPT that answers each
request with the next recorded reply, and writes every request nisse sent it to
`evidence/fake-openai.ndjson`, marked `as recorded`, `differs` (with what the
recording expected) or `unscripted` once the replies run out.
`--openai-signed-out` leaves the home signed out, for sign-in journeys, and
`--openai-refreshes N` lets the fake grant N token refreshes; without it every
refresh is refused.

Claude is always a fake unless the run says otherwise: a fake `claude` plays
the recording's Claude Code processes, one per spawn, and logs what nisse sent
each to `evidence/fake-claude/log.ndjson`. Without `--fake-claude` it plays
`models`, a signed-in Claude Code that answers the probe and nothing else, so
a scripted run never starts the `claude` on your PATH. The spawns count across
the whole run, so a recording covers one journey: drive another in a new run.

Type what the recording's user typed, in the same conversation: the fakes play
their recordings whatever they are sent, and `differs` or a stalled run means
nisse sent something the recording did not expect. A step that knowingly
departs from its recording says which requests will differ. The fixtures'
`scenario` line says what each one holds. Both fakes reach every window the run
opens, and a run can use both, alongside a `--script`.

Nisse has no long-lived dev server to keep up. The first `nisse exec` or TUI
start launches the home's server in the background, and it exits 30 s after its
last client leaves. Start it yourself with `drive.ts r1 serve` when a journey
needs it running first: before any `rpc` or `watch`, and to kill it on purpose.
`serve` returns once the server holds the home's lock, and prints its pid.

The TUI is ready when its status bar shows `READY`:

```sh
drive.ts r1 tui start            # extra args go to nisse, e.g. tui start --conversation <id>
drive.ts r1 tui wait READY
```

## Doctor

Run `drive.ts r1 doctor` before the first drive, and again after anything
surprising. It prints the checkout and commit, the home, the script, the
server's pid and command line, the protocol it answers `initialize` with, and
the TUI's state, and ends with `ok` or what is wrong:

- the home is the production `~/.nisse`
- the server holding the lock is not this checkout's `main.ts`
- the server does not answer `initialize`
- `tmux` or `lsof` is missing

A server keeps running the code it started with. After you change server code,
the running server is stale: `drive.ts r1 rpc server/stop` waits for its runs
to settle and stops it, and the next client starts one on the new code.

## Drive

- **TUI.** `tui type <text>` types literally; `tui key <keys>` presses tmux
  keys: `Enter` sends, `C-j` adds a line, `Escape` stops the run, `Tab`
  switches between queueing and steering while Nisse works, `C-y` allows the
  call Nisse asks about and `C-n` denies it, `C-l` signs in to a signed-out
  provider and `Escape` cancels it, `C-c` quits. Typing `/model` and `Enter`
  opens the model list: `Up` and `Down` pick a model, `Left` and `Right` its
  effort, `Enter` switches and `Escape` closes it. `tui wait <text>`
  waits until the screen shows the text, or stops showing it with `--gone`; on
  a timeout it prints the screen and exits 1. Wait on text, never sleep. The
  pane is 100x30. Stable handles are the status words `READY`, `WORKING` and
  `WAITING`, the prompt panel's titles `PROMPT`, `QUEUE · tab` and
  `STEER · tab`, the speaker bars `ADA` and `NISSE`, `queued · <text>` and
  `steering · <text>`, a call's `▸ Tool(subject)`, `allow this call?`,
  `✓ allowed by <name>` and `✗ denied by <name>`, `with <skill>, <skill>`
  under a message that named skills, a run's end `◆ interrupted` or
  `✗ <message>`, and the exit line `resume with: nisse --conversation <id>`.
  The splash lists each provider as `● <id> <account>` or `○ <id> signed out`
  over `^L  sign in`; a sign-in shows in the `SIGN IN · <provider>` panel over
  `esc  cancel`; the model list is the `MODEL` panel, whose chosen row ends in
  `‹ <effort> ›`; a switch shows as `◆ <name> switched to <provider> · <model> · <effort>`,
  and the status bar ends with the conversation's model. An extension's
  status line shows as `<name>: <text>` after the status word, its toast as
  `◆ <name>: <text>` in the transcript, and one that failed to load as
  `✗ extension <name> failed to load: <why>` over the prompt.
- **CLI.** `drive.ts r1 nisse <args>` runs `nisse` against the run's home and
  records the command, stdout, stderr and exit code.
  It gives `nisse` no terminal; a command that reads one, such as
  `nisse login`, runs in the TUI's pane with `tui start login <provider>`.
- **Wire.** `drive.ts r1 rpc <method> '<params json>'` makes one call, for
  `initialize`, `conversation/start`, `conversation/list`,
  `conversation/submit`, `conversation/interrupt`, `approval/resolve`,
  `conversation/select_model`, `skills/list`, `providers/list`,
  `models/list`, `auth/start`, `auth/respond`, `auth/cancel`, `auth/logout`,
  `extensions/list`, `extensions/reload` and `server/stop`.
  `conversation/list` and `server/stop` take no params. `providers/list`,
  `models/list` and `skills/list` take an object, at least `'{}'`.
  `conversation/start` needs a `cwd`, and `conversation/submit` a
  `requestId`; the schema in `schema/nisse.schema.json` has the rest.
  `drive.ts r1 watch <conversation>` subscribes as a second client and prints
  each delivery as one JSON line: the snapshot first, then each commit.
  `--submit <text>` submits as `ada` once the snapshot is in, so nothing races;
  `--until <tag>` returns once a commit carries an entry with that body tag,
  such as `run_end` or `approval`, and without it `watch` returns after a
  second with no delivery; `--since <seq>` resumes after a commit; `--save <name>`
  keeps the lines as evidence. `--until` gives up after `--timeout <ms>`,
  10 s by default, here and on `watch-auth`, `watch-status` and `tui wait`.
  `drive.ts r1 watch-auth` follows every sign-in over `auth/watch` and prints
  each state as one JSON line, the running ones first; `--until <phase>`, such
  as `waiting` or `failed`, returns once a state reaches it, and `--save` and
  `--timeout` work as for `watch`.
- **Crash.** `drive.ts r1 kill-server` sends SIGKILL to the pid holding this
  run's home lock, after checking it runs this checkout's Nisse.

The journeys for each feature are in [features/](features/README.md). A proof
covers every entry point the feature's file lists, not the most convenient one.

## Evidence

Every helper command appends what it did to `evidence/steps.log`, with a
timestamp. `nisse` saves each command's output; `tui screen <name>` saves the
screen as `<name>.screen.txt`; `tui stop` saves what the TUI left in the
terminal as `tui-exit.screen.txt`; `watch --save <name>` and
`watch-auth --save <name>` save `<name>.ndjson`.

Proof standards:

- Drive the user's path: keys in the TUI, `nisse` commands, protocol calls.
  Never write to `store.sqlite` or call into server code to set up state.
- Capture the action and the state it led to: the screen before and after,
  and what a second client saw over the wire. A screen alone does not show
  what was committed; `watch` shows the commits.
- Prove what survives. Nisse's promise is that only committed state is
  observable and nothing committed is lost, so a proof that something happened
  includes seeing it again from a fresh view: `tui start --conversation <id>`,
  or `watch` from a new connection.
- Show live text and the committed transcript as two separate things: the
  words streaming while `WORKING`, then the `message` entry and the same
  screen after a reopen. A fix to one does not fix the other.
- A recording proves nisse's side of the wire: what it sends ChatGPT or Claude
  Code, and what it does with their answers. It doesn't prove what a real
  model or a real Claude Code does today. When the provider itself is the
  subject (a new model, a real sign-in, a change in what the service sends),
  the proof needs a real signed-in account; drive the feature's
  `With a real account` steps where you have one, and otherwise say they
  were not verified, rather than calling a recording proof of them.
- When a journey cannot be driven, report it as not verified, with the command
  you tried and what was missing. Never report a different path as proof.

## Real accounts

The fakes prove nisse's side of the wire. A feature's `With a real account`
section holds what only the real ChatGPT or Claude Code can show; an agent
holding the account drives it cold, like this.

- **ChatGPT.** Use a sign-in kept for verification, never the production
  `~/.nisse`'s: a refresh in a run rotates the token, and the copy it came
  from would stop working. Make one once: `drive.ts keep up`,
  `drive.ts keep tui start login openai`, finish the browser or device-code
  sign-in (that takes a person), copy `/tmp/nisse-verify/keep/home/auth/openai.json`
  to a file of your own with mode 0600, then `drive.ts keep down`. Start each
  run with `drive.ts r up --openai-auth <that file>`; `down` writes the
  sign-in back when a refresh changed it. Don't drive two runs on one sign-in
  at once.
- **Claude.** `drive.ts r up --real-claude` runs the `claude` on your PATH
  with your own login, as a person's nisse does, and its sessions land in your
  Claude Code configuration.
- **First check.** Before any step, `drive.ts r serve` and
  `drive.ts r rpc providers/list '{}'`: the provider is `ready` and names your
  account. Otherwise stop and report what it shows.
- **Report** each step with its evidence, and the steps you could not drive as
  not verified, with why. A model may word its answers differently from a
  recipe; judge what the step says to check, not the wording.

## Cleanup

```sh
drive.ts r1 down
```

`down` quits the run's TUI with `^C`, killing its pid if it does not exit,
closes the run's tmux server, asks the run's Nisse server to stop, then kills
it if it still holds the lock, and removes the home and script. The
evidence folder stays. After a failed attempt, run `down` before you retry so
nothing strands a server or a pane. Never kill Nisse or tmux by name or
pattern: `down` only reaches what this run's home and tmux socket own.

## When Nisse changes

The map in [features/](features/README.md) is the maintained source for what
to drive. A change that adds or changes a user-facing behavior updates its
feature file, or adds one, in the same PR. The helper is type-checked with the
rest of the repository. `/maintain-verification-skill` audits the map against
the source and drives every feature; `/create-verification-skill` wrote this
skill.
