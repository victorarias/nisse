# Tool calls and approvals

Nisse works with tools: `read`, `grep` and `glob` run at once, while `write`,
`edit`, `apply_patch` and `bash` change things and wait for a person to allow
them. The TUI shows each call under `NISSE` as `▸ tool(subject)`, asks `allow this call?`
and takes `^Y` or `^N`; any client can answer over the wire, and the first
answer counts. `nisse exec` cannot ask, so it denies those calls unless the
conversation was started with `--auto`, which runs every call without asking.

## Sub-features

- `tool-grep-lines` `grep` reports only the lines a file has, whatever its line endings.
- `tool-read-only` runs a read-only call without asking and shows its output.
- `approval-ask` shows `allow this call?` and `◆ WAITING` while a call waits.
- `approval-allow-tui` allows with `^Y`: `✓ allowed by ada`, then the call's
  output.
- `approval-deny-tui` denies with `^N`: `✗ denied by ada` and the denial as
  the call's result; the run goes on.
- `approval-wire` answers with `approval/resolve`; a second answer is not
  accepted.
- `approval-exec-deny` makes `exec` deny the call and say how to allow it.
- `approval-auto` runs calls without asking in a conversation started with
  `--auto`, from the TUI or `exec`.
- `approval-interrupt` expires a waiting approval when the run is
  interrupted.
- `approval-restart` keeps a call waiting for approval across a restart, and
  asks again, with the new arguments, when its extensions' hooks change them
  on the rerun: an answer holds only for the arguments it was given.
- `tool-output-live` shows a command's output as it prints, under its call
  while the status reads `WORKING`, then commits it whole with the result.
- `tool-root-env` runs every command with `NISSE_ROOT_CONVERSATION` set to the
  id of the conversation people started, in a subagent too.

## How to get to it

### People

- In the TUI, wait for `allow this call?` and press `^Y` or `^N`.
- Start with `nisse --auto`.

### Agents

- Run `nisse exec '<prompt>'` without `--auto`, or `nisse exec --auto '<prompt>'`.
- Watch for a request in the view's `nisse.approvals` document, then call `approval/resolve` with its id; or `conversation/start` with `"approvals": "auto"`.

## Driving it with drive.ts

Preconditions:

- Every run here is `drive.ts r up --script <file>` and nothing else: Claude
  is the signed-in fake that plays `models`, and the model is the script.
- A run whose script is
  `[{"text": "checking", "tool": {"name": "bash", "input": {"command": "echo approved"}}}, {"text": "all done"}]`;
  for `tool-read-only`, a run whose script is
  `[{"text": "reading", "tool": {"name": "read", "input": {"path": "/etc/hostname"}}}, {"text": "read it"}]`.
  Start a fresh run for each journey: the script's steps are used up in
  order.

- **Ask.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'check it'`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'allow this call?'`, `drive.ts r tui screen asking`.
  Under `NISSE`: `checking`, `▸ bash(echo approved)`,
  `allow this call?  ^Y  allow  ^N  deny`, and the status bar reads
  `◆ WAITING 0s`, and the prompt panel is titled `QUEUE · tab`. `drive.ts r watch <id> --save asking` shows
  the request in `docs.nisse.approvals.requests`, keyed by its approval id,
  with `"tool": "bash"`.
- **Allow.** Run `drive.ts r tui key C-y`, `drive.ts r tui wait 'all done'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen allowed`. The call shows
  `✓ allowed by ada` and `approved`, then `all done`.
- **Deny.** In a fresh run, ask as above, then `drive.ts r tui key C-n`,
  `drive.ts r tui wait 'all done'`, `drive.ts r tui screen denied`. The call
  shows `✗ denied by ada`, then `all done`. `watch <id>` shows a
  `nisse.approval` entry with `"allow": false`, and a `pi.tool-result`
  `denied by ada: the person did not allow this call` with `"isError": true`.
- **Read-only.** In the `read` run, run `drive.ts r nisse exec 'read it'`.
  Exit 0, stdout `reading` and `read it`, stderr `› read(/etc/hostname)` and
  no denial.
- **Exec denies.** Run `drive.ts r nisse exec 'check it'`. Exit 0, stdout
  `checking` and `all done`, stderr `› bash(echo approved)` and
  `denied bash(echo approved): exec cannot ask, pass --auto to allow calls`.
- **Auto.** In a fresh run, run `drive.ts r nisse exec --auto 'check it'`:
  stderr `› bash(echo approved)` with no denial, and `watch <id>` shows a
  `pi.tool-result` with `approved` and no `nisse.approval` entry;
  `rpc conversation/list` shows `"approvals": "auto"`. In another fresh run,
  `drive.ts r tui start --auto`, send `check it`, and
  `drive.ts r tui wait 'all done'`: the call shows `approved` and the screen
  never asks.
- **Root conversation.** In a fresh run whose script is
  `[{"tool": {"name": "bash", "input": {"command": "echo root=$NISSE_ROOT_CONVERSATION"}}}, {"text": "all done"}]`,
  run `drive.ts r nisse exec --auto 'which conversation?'`, take the id from
  `drive.ts r rpc conversation/list`, then `drive.ts r watch <id> --save root-env`:
  the `pi.tool-result` is `root=<id>`. A subagent's commands get the same id, in
  [Subagents](./subagents.md).
- **Output streams live.** In a fresh run whose script is

  ```json
  [
    {
      "text": "counting",
      "tool": { "name": "bash", "input": { "command": "for i in 1 2 3; do echo tick $i; sleep 1; done" } }
    },
    { "text": "counted" }
  ]
  ```

  run `drive.ts r tui start --auto`, `drive.ts r tui wait READY`,
  `drive.ts r tui type count`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'tick 2'`, `drive.ts r tui screen streaming`: under
  `▸ bash(for i in 1 2 3; do echo tick $i; sleep 1; done)` the lines
  `tick 1` and `tick 2` show while the status bar reads `WORKING` and
  `counted` is not there yet. `drive.ts r tui wait READY`,
  `drive.ts r tui screen streamed`: `tick 1`, `tick 2` and `tick 3`, then
  `counted`. Over the wire, in a fresh run,
  `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "approvals": "auto"}'` and
  `drive.ts r watch <id> --submit count --until run_end --save stream`:
  changes about a second apart grow the running call's `output` in
  `docs.pi.live.tools` by `tick 1\n`, `tick 2\n` and `tick 3\n`, before the
  `pi.tool-result` `tick 1\ntick 2\ntick 3\n`.

- **Wire.** In a fresh run, run `drive.ts r serve`, start a conversation with
  `rpc conversation/start '{"cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit 'check it' --until run_end --timeout 30000 --save wire &`.
  Once its output shows a request in `docs.nisse.approvals.requests`, take
  its key, the approval id, and run
  `drive.ts r rpc approval/resolve '{"conversation": "<id>", "approval": "<approval>", "author": "bo", "allow": true}'`:
  `"accepted": true`. The same call again with `"author": "cy"` and
  `"allow": false` answers `"accepted": false`; sent at the same moment, one
  of the two is accepted. The watch shows one `nisse.approval` entry with
  `"allow": true`, a `pi.tool-result` with `approved`, and a `nisse.run_end`
  `answered`.
- **Interrupt while asking.** In a fresh run, ask as above, then
  `drive.ts r tui key Escape`, `drive.ts r tui wait interrupted`.
  `allow this call?` is gone, `◆ interrupted` shows, and the command never
  ran. `approval/resolve` on that approval afterwards answers
  `"accepted": false`.

## Contexts

- **Second client.** Any client can answer, and the first answer counts.
- **Provider.** On Claude, Nisse asks before the calls Claude Code would ask about.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- approval-wire: two clients answer one approval at once and the first answer counts
- approval-wire: a denied call is reported to the model as denied and does not run, and an unknown approval is refused by name
- tool-read-only, approval-auto: reading calls and conversations started with auto approvals run without asking
- child-tools, approval-auto: a subagent of a conversation that runs calls without asking does not ask either
- subagent-root-env, tool-root-env: an extension's tool run by a subagent knows the conversation people started
- approval-restart, status-snapshot: a call waiting for approval across a restart, whose hook computes other arguments on the rerun, asks again with them
- approval-ask: a call that changes things waits for a person, and every client sees what it asks and that the tree waits
- tool-output-live: a running command's output streams live and ends as its result
- tool-output-live: a command's output keeps characters split across reads and between streams whole
- tool-output-live: a verbose command's live output stays a bounded tail
- tool-output-live: output a background process writes after its call ends never reaches the conversation
- tool-grep-lines: grep reports only the lines a file has, whatever its line endings
- approval-interrupt: interrupting while nisse waits for an answer withdraws the question

Screen, `packages/nisse/test/screen.test.ts`:

- approval-ask, approval-allow-tui: nisse asks before a command runs, ctrl+y allows it and its output shows under the call
- approval-ask, codemode-nested-policy: a script's call that waits for a person shows its command under the script before ctrl+y allows it
- approval-deny-tui: ctrl+n denies a call, the denial shows as its result and the run goes on

Stack, `packages/nisse/test/stack.test.ts`:

- approval-exec-deny: nisse exec shows its calls and, without --auto, denies the ones that would change things

## Gotchas

- The TUI's working directory is the checkout, so its calls run there. Script
  only calls that change nothing, such as `echo`, or start the conversation
  over the wire with another `cwd`.
- A script step with a `tool` calls it and the same run goes on to the next
  step; a step without one ends the run.
- `^Y` and `^N` answer this conversation's oldest waiting call, or else the
  oldest in the first subagent that has one.
