# Tool calls and approvals

Nisse works with tools: `Read`, `Grep` and `Glob` run at once, while `Write`,
`Edit` and `Bash` change things and wait for a person to allow them. The TUI
shows each call under `NISSE` as `▸ Tool(subject)`, asks `allow this call?`
and takes `^Y` or `^N`; any client can answer over the wire, and the first
answer counts. `nisse exec` cannot ask, so it denies those calls unless the
conversation was started with `--auto`, which runs every call without asking.

## Sub-features

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
- `tool-output-live` shows a command's output as it prints, under its call
  while the status reads `WORKING`, then commits it whole with the result.
- `tool-root-env` runs every command with `NISSE_ROOT_CONVERSATION` set to the
  id of the conversation people started, in a subagent too.

## How to get to it (user POV)

- In the TUI, wait for `allow this call?` and press `^Y` or `^N`.
- Start with `nisse --auto` or `nisse exec --auto '<prompt>'`.
- Run `nisse exec '<prompt>'` without `--auto`.
- Watch for an `approval` entry, then call `approval/resolve` with its
  `approval` id; or `conversation/start` with `"approvals": "auto"`.

## Driving it with drive.ts

Preconditions:

- Every run here is `drive.ts r up --script <file>` and nothing else: Claude
  is the signed-in fake that plays `models`, and the model is the script.
- A run whose script is
  `[{"text": "checking", "tool": {"name": "Bash", "input": {"command": "echo approved"}}}, {"text": "all done"}]`;
  for `tool-read-only`, a run whose script is
  `[{"text": "reading", "tool": {"name": "Read", "input": {"file_path": "/etc/hostname"}}}, {"text": "read it"}]`.
  Start a fresh run for each journey: the script's steps are used up in
  order.

- **Ask.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'check it'`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'allow this call?'`, `drive.ts r tui screen asking`.
  Under `NISSE`: `checking`, `▸ Bash(echo approved)`,
  `allow this call?  ^Y  allow  ^N  deny`, and the status bar reads
  `◆ WAITING 0s`, and the prompt panel is titled `QUEUE · tab`. `drive.ts r watch <id> --save asking` shows
  `"status": "waiting"` and an `approval` entry.
- **Allow.** Run `drive.ts r tui key C-y`, `drive.ts r tui wait 'all done'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen allowed`. The call shows
  `✓ allowed by ada` and `approved`, then `all done`.
- **Deny.** In a fresh run, ask as above, then `drive.ts r tui key C-n`,
  `drive.ts r tui wait 'all done'`, `drive.ts r tui screen denied`. The call
  shows `✗ denied by ada` and `denied: the person did not allow this call`,
  then `all done`. `watch <id>` shows `approval`, `approval_answer` with
  `"allow": false`, and a `tool_result` with `"error": true`.
- **Read-only.** In the `Read` run, run `drive.ts r nisse exec 'read it'`.
  Exit 0, stdout `reading` and `read it`, stderr `› Read(/etc/hostname)` and
  no denial.
- **Exec denies.** Run `drive.ts r nisse exec 'check it'`. Exit 0, stdout
  `checking` and `all done`, stderr `› Bash(echo approved)` and
  `denied Bash(echo approved): exec cannot ask, pass --auto to allow calls`.
- **Auto.** In a fresh run, run `drive.ts r nisse exec --auto 'check it'`:
  stderr `› Bash(echo approved)` with no denial, and `watch <id>` shows a
  `tool_result` with `approved` and no `approval` entry;
  `rpc conversation/list` shows `"approvals": "auto"`. In another fresh run,
  `drive.ts r tui start --auto`, send `check it`, and
  `drive.ts r tui wait 'all done'`: the call shows `approved` and the screen
  never asks.
- **Root conversation.** In a fresh run whose script is
  `[{"tool": {"name": "Bash", "input": {"command": "echo root=$NISSE_ROOT_CONVERSATION"}}}, {"text": "all done"}]`,
  run `drive.ts r nisse exec --auto 'which conversation?'`, take the id from
  `drive.ts r rpc conversation/list`, then `drive.ts r watch <id> --save root-env`:
  the `tool_result` is `root=<id>`. A subagent's commands get the same id, in
  [Subagents](./subagents.md).
- **Output streams live.** In a fresh run whose script is

  ```json
  [
    {
      "text": "counting",
      "tool": { "name": "Bash", "input": { "command": "for i in 1 2 3; do echo tick $i; sleep 1; done" } }
    },
    { "text": "counted" }
  ]
  ```

  run `drive.ts r tui start --auto`, `drive.ts r tui wait READY`,
  `drive.ts r tui type count`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'tick 2'`, `drive.ts r tui screen streaming`: under
  `▸ Bash(for i in 1 2 3; do echo tick $i; sleep 1; done)` the lines
  `tick 1` and `tick 2` show while the status bar reads `WORKING` and
  `counted` is not there yet. `drive.ts r tui wait READY`,
  `drive.ts r tui screen streamed`: `tick 1`, `tick 2` and `tick 3`, then
  `counted`. Over the wire, in a fresh run,
  `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "approvals": "auto"}'` and
  `drive.ts r watch <id> --submit count --until run_end --save stream`: three
  commits about a second apart, each with a `live` `output` that appends
  `tick 1\n`, `tick 2\n` and `tick 3\n` to the call, before the
  `tool_result` whose `output` is `tick 1\ntick 2\ntick 3\n`.

- **Wire.** In a fresh run, run `drive.ts r serve`, start a conversation with
  `rpc conversation/start '{"cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit 'check it' --until run_end --timeout 30000 --save wire &`.
  Once its output shows an `approval` entry, take its `approval` id and run
  `drive.ts r rpc approval/resolve '{"conversation": "<id>", "approval": "<approval>", "author": "bo", "allow": true}'`:
  `"accepted": true`. The same call again with `"author": "cy"` and
  `"allow": false` answers `"accepted": false`. The watch shows statuses
  `idle` (the snapshot), `working`, `waiting`, `working`, `idle`, one `approval_answer` with
  `"allow": true`, and a `tool_result` with `approved`.
- **Interrupt while asking.** In a fresh run, ask as above, then
  `drive.ts r tui key Escape`, `drive.ts r tui wait interrupted`. The call
  shows `✗ denied by nisse` and
  `interrupted; it may or may not have taken effect`, then `◆ interrupted`.

## Gotchas

- The TUI's working directory is the checkout, so its calls run there. Script
  only calls that change nothing, such as `echo`, or start the conversation
  over the wire with another `cwd`.
- A script step with a `tool` calls it and the same run goes on to the next
  step; a step without one ends the run.
- `^Y` and `^N` answer the oldest call waiting.
