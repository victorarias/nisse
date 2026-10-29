# Code mode

Most of OpenAI's models work in code mode: instead of nisse's tools they get
`exec`, which runs a JavaScript script, and `wait`. Each call a script makes
(`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `apply_patch` or an agent
tool such as `spawn_agent`) is an
ordinary nisse call under the script's own: committed with the script's call
as its `parent`, shown as its own `▸ Tool(subject)`, and asked about when it
changes things. The model sees only the script and what it printed. Scripts
run in Codex's `codex-code-mode-host`, which `scripts/code-mode-host.sh`
installs; without it a code-mode run fails saying how to install it.
`gpt-5.5` keeps direct tools and needs no host.

## Sub-features

- `code-mode-models` puts the models ChatGPT marks code-mode-only in code
  mode: in the list nisse ships, every listed model but `gpt-5.5`, such as
  `gpt-5.6-terra` and `gpt-6-sol`.
- `code-mode-install` installs the pinned host with
  `scripts/code-mode-host.sh` into `NISSE_HOME/bin`, or the folder it is
  given, and prints its path; a second run finds it and prints the same path.
- `code-mode-find` uses `NISSE_CODE_MODE_HOST` when the server's environment
  sets it, else `NISSE_HOME/bin/codex-code-mode-host`, else
  `codex-code-mode-host` on `PATH`.
- `code-mode-missing` fails the run with
  `this model works in code mode, which needs Codex's codex-code-mode-host; install it with scripts/code-mode-host.sh, or point NISSE_CODE_MODE_HOST at it`,
  before it asks ChatGPT anything.
- `code-mode-calls` commits `exec` as a `tool_call` whose `input` is the
  script, then each call the script makes as a `tool_call` with
  `"parent": "<exec call>"` and its `tool_result`, then the script's result.
  The TUI shows `▸ exec`, then `▸ Bash(<command>)` and the rest.
- `code-mode-cells` gives a script that yields (`Script running with cell ID
<exec call>`) a `cell` call under its `exec`, shown as `▸ cell(<exec call>)`,
  that ends when the script does: with `Script completed`, `Script failed` or
  `Script terminated` from `wait`, or `interrupted` when the host stops, the
  run ends or the server stops first. A script that stops before finishing,
  as its `exec` or as its `cell`, tells the model what its calls finished.
- `code-mode-tools` gives a script, as `tools` and `ALL_TOOLS`, exactly the
  tools its request offered: nisse's tools and the agent tools, less any an
  extension's request hook withheld. Codex's own nested tools, such as
  `exec_command`, are not among them: a script that calls one fails with
  `TypeError: tools.<name> is not a function`.
- `code-mode-approvals` asks before a nested call that changes things, with
  `allow this call?`, `^Y`, `^N` or `approval/resolve`; `exec` denies them and
  `--auto` allows them, as for any call.
- `code-mode-host-life` starts the host on a conversation's first script,
  keeps one session per conversation so a later script can `load` what an
  earlier one `store`d, and stops it after five idle minutes; the next
  script starts a new one. A `wait` on a script whose host stopped answers
  `no running cell <id>; it already finished, or the code-mode host running it stopped`,
  even after a new host started other scripts.

## How to get to it (user POV)

- Run `scripts/code-mode-host.sh` once, then
  `nisse --provider openai --model <a code-mode model>` or
  `nisse exec --provider openai --model <model> '<prompt>'`.
- Switch a conversation to a code-mode model with `/model` or
  `conversation/select_model`.
- Set `NISSE_CODE_MODE_HOST` in the environment of the command that starts the
  server.

## Driving it with drive.ts

Preconditions:

- A fresh run for each group of steps, and `drive.ts r down` after. The
  missing host and the host lookup need no sign-in: a run that finds the
  host goes on to fail `not signed in to ChatGPT`.
- `code-mode-install` downloads from `github.com`; a second install finds
  the host and downloads nothing.
- The scripted steps use `--fake-openai` with the `code_mode_*` fixtures,
  whose model is `gpt-6.1-sol`, and install the host first with
  `NISSE_HOME=/tmp/nisse-verify/r/home scripts/code-mode-host.sh`. Each
  fixture is one conversation from its first prompt; type its prompt as
  written.

- **Missing host.** `drive.ts r up`, then
  `drive.ts r nisse exec --provider openai --model gpt-5.6-terra hi`: exit 1,
  empty stdout, stderr the `code-mode-missing` message. Run
  `drive.ts r tui start --provider openai --model gpt-5.6-terra`,
  `drive.ts r tui wait READY`, `drive.ts r tui type hi`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'code mode'`,
  `drive.ts r tui screen no-host`: `ADA` over `hi`,
  `✗ this model works in code mode, ...`, and `openai · gpt-5.6-terra` in
  the status bar.
- **Direct tools.** `drive.ts r nisse exec --provider openai --model gpt-5.5 hi`:
  exit 1 with `not signed in to ChatGPT`, not the host message.
- **Install.** Run `NISSE_HOME=/tmp/nisse-verify/r/home scripts/code-mode-host.sh`:
  it prints `/tmp/nisse-verify/r/home/bin/codex-code-mode-host`, and the
  folder holds `codex-code-mode-host.release`. Run it again: the same path,
  at once. The `gpt-5.6-terra` `exec` now fails with `not signed in to ChatGPT`.
- **Variable.** `drive.ts r tui stop`, `drive.ts r rpc server/stop`, move
  `home/bin` to `/tmp/nisse-verify/r/hostbin`, then
  `NISSE_CODE_MODE_HOST=/tmp/nisse-verify/r/hostbin/codex-code-mode-host drive.ts r nisse exec --provider openai --model gpt-5.6-terra hi`:
  `not signed in to ChatGPT`. Stop the server again and run it with
  `NISSE_CODE_MODE_HOST=/tmp/nisse-verify/r/nowhere`: the host message. Move
  `hostbin` back to `home/bin`, stop the server and run it with `nowhere`
  again: still the host message.
- **Calls.** `drive.ts r up --fake-openai code_mode_script`, install the
  host, `drive.ts r tui start --provider openai --model gpt-6.1-sol`,
  `drive.ts r tui wait READY`, type `what does echo say?` and press `Enter`.
  `drive.ts r tui wait 'allow this call?'`, `drive.ts r tui screen asking`:
  `▸ exec`, then `▸ Bash(echo hi)` asking, status `WAITING`.
  `drive.ts r tui key C-y`, `drive.ts r tui wait 'It says hi.'`,
  `drive.ts r tui screen allowed`: under `▸ exec`, `Script completed` and
  `hi`; under `▸ Bash(echo hi)`, `✓ allowed by ada` and `hi`; then
  `It says hi.`. Take the id from the header and run
  `drive.ts r watch <id> --save code-mode`: the `exec` `tool_call` with the
  script as `input`, the `Bash` `tool_call` `call_1/tool-1` with
  `"parent": "call_1"`, its `approval`, `approval_answer` and `tool_result`,
  then the `exec` `tool_result` starting `Script completed`. Both requests in
  `fake-openai.ndjson` are `as recorded`.
- **Reopen.** In the same run, `drive.ts r tui stop`, then
  `drive.ts r tui start --conversation <id>` and
  `drive.ts r tui wait 'It says hi.'`: the same `▸ exec`, nested call and
  answer.
- **Denied.** In a new run set up as for **Calls**, press `C-n` instead: the
  `Bash` call shows `✗ denied by ada` and
  `denied: the person did not allow this call`, the script goes on to
  `Script completed` with that denial as its output, and the answer is
  `It says hi.`. Both requests stay `as recorded`: the recording accepts any
  script output.
- **Exec.** `drive.ts r up --fake-openai code_mode_script,code_mode_script`,
  install the host, then
  `drive.ts r nisse exec --provider openai --model gpt-6.1-sol 'what does echo say?'`:
  exit 0, stderr `› exec`, `› Bash(echo hi)` and
  `denied Bash(echo hi): exec cannot ask, pass --auto to allow calls`. The
  same with `--auto`: exit 0 and no denial. All four requests are
  `as recorded`.
- **Cells.** `drive.ts r up --fake-openai code_mode_wait`, install the host,
  open the TUI on `gpt-6.1-sol` as for **Calls**, send `count slowly` and
  `drive.ts r tui wait 'Done counting.'`: `▸ exec` with
  `Script running with cell ID call_1` and `started`, `▸ cell(call_1)` with
  `Script completed`, `▸ wait(call_1)` with `finished`, then
  `Done counting.`.
- **Patch.** `drive.ts r up --fake-openai code_mode_patch_same_path`,
  install the host, `drive.ts r serve`, make `/tmp/nisse-verify/r/project`
  holding `notes.txt` with the line `draft`, run
  `drive.ts r rpc conversation/start '{"cwd": "/tmp/nisse-verify/r/project", "provider": "openai", "model": "gpt-6.1-sol", "approvals": "auto"}'`,
  then
  `drive.ts r watch <id> --submit 'finalize the notes' --until run_end --timeout 60000 --save patch`:
  a nested `apply_patch` `tool_call` with `"parent": "call_1"`, its result
  `Success. Updated the following files:` and `M ./notes.txt`, and
  `notes.txt` now holds `final`.
- **Tools offered.** `drive.ts r up --fake-openai code_mode_all_tools`,
  install the host, and before the server starts write
  `/tmp/nisse-verify/r/home/extensions/focus.ts`, whose request hook offers
  only `Read` and `Bash`:

  ```ts
  import { Extension } from "@nisse/extension"
  import { Effect } from "effect"

  export default Extension.define((ctx) =>
    ctx.request.hook((request) =>
      Effect.sync(() => {
        request.tools = ["Read", "Bash"]
      }),
    ),
  )
  ```

  Open the TUI on `gpt-6.1-sol` as for **Calls**, send
  `which tools can you call?` and `drive.ts r tui wait 'Just those.'`,
  `drive.ts r tui screen all-tools`: `▸ exec` with `Script completed` and
  the output `Read Bash`, then `Just those.`. Both requests are
  `as recorded`, and request 1's `exec` description lists only `Read` and
  `Bash`. In a new run without `focus.ts`,
  `drive.ts r nisse exec --provider openai --model gpt-6.1-sol 'which tools can you call?'`
  exits 0 with `Just those.`, and request 2's `custom_tool_call_output` ends
  `Read Write Edit Bash Grep Glob apply_patch spawn_agent send_message followup_task wait_agent list_agents interrupt_agent`.

- **Codex's tools.** `drive.ts r up --fake-openai code_mode_codex_tools`,
  install the host, open the TUI on `gpt-6.1-sol` as for **Calls**, send
  `what does echo say?` and `drive.ts r tui wait 'It says hi.'`,
  `drive.ts r tui screen codex-tools`: `▸ exec` with `Script failed` and
  `TypeError: tools.exec_command is not a function`, no nested call, then
  the recording's `It says hi.`. `watch <id>` commits one `tool_call` and
  one `tool_result`, and both requests are `as recorded`.

The script stops below share one setup, called **Stop setup** with a
fixture: `drive.ts r up --fake-openai <fixture>`, install the host, make
`/tmp/nisse-verify/r/project` holding `Cargo.toml` with the two lines
`[package]` and `name = "manifest"`, `drive.ts r serve` (note the pid it
prints), and take `<id>` from
`drive.ts r rpc conversation/start '{"cwd": "/tmp/nisse-verify/r/project", "provider": "openai", "model": "gpt-6.1-sol"}'`.
Steps that watch in the TUI then run `drive.ts r tui start --conversation <id>`
and `drive.ts r tui wait READY`. Each step's requests are all `as recorded`.

- **Interrupted.** Stop setup with `code_mode_interrupted`, the TUI open.
  Type `read the manifest slowly`, press `Enter`,
  `drive.ts r tui wait 'name = "manifest"'`, `drive.ts r tui screen running`:
  `▸ exec`, then `▸ Read(Cargo.toml)` with the manifest, status `WORKING`.
  `drive.ts r tui key Escape`, `drive.ts r tui wait '◆ interrupted'`: under
  `▸ exec`, `interrupted; it may or may not have taken effect`. Type
  `what did it read?`, press `Enter`,
  `drive.ts r tui wait 'It read the manifest.'`. `watch <id>` shows the
  `exec` `tool_result` committed as only that `interrupted` line, with
  `"error": true`, while request 2 in `fake-openai.ndjson` tells the model
  more: its `custom_tool_call_output` adds `The calls it made that finished:`
  and `- Read (done):` with the manifest.
- **Terminated.** Stop setup with `code_mode_terminate`, the TUI open. Type
  `run it, then stop it`, press `Enter`,
  `drive.ts r tui wait --timeout 20000 'Stopped it.'`,
  `drive.ts r tui screen terminated`: `▸ exec` with
  `Script running with cell ID call_1`; `▸ Bash(echo late > late.txt)` with
  `✗ denied by nisse` and `interrupted; it may or may not have taken effect`;
  `▸ cell(call_1)` and `▸ wait(call_1)` with `Script terminated`; then
  `Stopped it.`. `drive.ts r watch <id> --save terminate` shows the `Bash`
  call's `tool_result` before the `wait` call's (`call_2`). Take the
  `approval` id from it and run
  `drive.ts r rpc approval/resolve '{"conversation": "<id>", "approval": "<approval>", "author": "ada", "allow": true}'`:
  `{"accepted": false}`, and the project holds no `late.txt`.
- **Yielded, run stopped.** Stop setup with `code_mode_yielded_run_stopped`,
  the TUI open. Type `read the manifest in the background`, press `Enter`,
  `drive.ts r tui wait 'name = "manifest"'`: `▸ exec` with
  `Script running with cell ID call_1`, an open `▸ cell(call_1)`, the
  `Read` with the manifest, and `WORKING` while the model's reply stays
  open. `drive.ts r tui key Escape`, `drive.ts r tui wait '◆ interrupted'`:
  `▸ cell(call_1)` ends `interrupted; it may or may not have taken effect`.
  Send `what did it read?` and `drive.ts r tui wait 'It read the manifest.'`.
  Request 3 in `fake-openai.ndjson` carries a `developer` message starting
  `Cell call_1 stopped before its script finished.`, then
  `The calls it made that finished:` and `- Read (done):` with the manifest.
- **Yielded, server stopped.** Stop setup with
  `code_mode_yielded_server_stopped`, no TUI. Run
  `drive.ts r watch <id> --submit 'read the manifest in the background' --save before`:
  it returns once the `Read` has its `tool_result` and the model's reply
  stays open. Stop the server with `kill -TERM <the pid serve printed>`:
  `rpc server/stop` would wait for the open run and get no reply. Then
  `drive.ts r serve` and
  `drive.ts r watch <id> --since 1 --until run_end --timeout 30000 --save resumed`:
  the resumed server ends `call_1/cell` with
  `interrupted; it may or may not have taken effect`, asks the model again,
  and commits `It read the manifest.` and `"outcome": "answered"`. Request 3
  carries the same `Cell call_1 stopped before its script finished.` note.
- **Server crash.** Stop setup with `code_mode_server_crash`, with
  `"approvals": "auto"` added to the `conversation/start` params, no TUI.
  `drive.ts r watch <id> --submit 'read the manifest, then wait in the shell' --save before`
  returns with the `Read` done and a `Bash` call `sleep 60` running.
  `drive.ts r kill-server`, `drive.ts r serve`, then
  `drive.ts r watch <id> --since 1 --until run_end --timeout 30000 --save after`:
  the `Bash` call and `call_1/cell` end with
  `interrupted; it may or may not have taken effect`, then
  `The shell call was cut off.` and `"outcome": "answered"`. Request 3's
  `developer` note lists `- Read (done):` with the manifest and
  `- Bash (failed): interrupted; it may or may not have taken effect`.
- **Two scripts, interrupted.** Stop setup with
  `code_mode_two_scripts_interrupted`, the TUI open. Type
  `read slowly while doing something else`, press `Enter`,
  `drive.ts r tui wait 'wait(call_1)'`, `drive.ts r tui screen waiting`:
  `▸ exec` with `Script running with cell ID call_1`, an open
  `▸ cell(call_1)`, `▸ Read(Cargo.toml)` with the manifest, a second
  `▸ exec` with `Script completed` and `b`, and an open `▸ wait(call_1)`,
  status `WORKING`. `drive.ts r tui key Escape`,
  `drive.ts r tui wait '◆ interrupted'`, `drive.ts r tui screen interrupted`:
  `▸ cell(call_1)` and `▸ wait(call_1)` end
  `interrupted; it may or may not have taken effect`. Send
  `what did the first script read?` and
  `drive.ts r tui wait 'It read the manifest.'`. Request 4 in
  `fake-openai.ndjson` answers `call_3` with that `interrupted` line and
  carries a `developer` note starting
  `Cell call_1 stopped before its script finished.`, then
  `The calls it made that finished:` and `- Read (done):` with the manifest.

The host stops need the host's pid. Do the Stop setup with the step's
fixture, but before `serve` write `/tmp/nisse-verify/r/launcher/host`, mode
755, which records the pid and runs the installed host:

```sh
#!/bin/sh
echo $$ > /tmp/nisse-verify/r/launcher/host.pid
exec /tmp/nisse-verify/r/home/bin/codex-code-mode-host "$@"
```

and start the server with it:
`NISSE_CODE_MODE_HOST=/tmp/nisse-verify/r/launcher/host drive.ts r serve`.
Finish the Stop setup with the TUI open, and stop the host with
`kill -KILL "$(cat /tmp/nisse-verify/r/launcher/host.pid)"` at the moment
each step names.

- **Host dies.** `code_mode_host_dies`: send `read the manifest, then wait`,
  `drive.ts r tui wait 'name = "manifest"'`, stop the host,
  `drive.ts r tui wait 'The script was cut off'`: `▸ exec` ends
  `interrupted: the code-mode host stopped; the script may or may not have taken effect`.
  Request 2's `custom_tool_call_output` adds
  `The calls it made that finished:` and `- Read (done):` with the manifest.
- **Host dies, asking.** `code_mode_host_dies_asking`: send `write it late`,
  `drive.ts r tui wait 'allow this call?'`, stop the host,
  `drive.ts r tui wait 'The host stopped.'`: `▸ Bash(echo late > late.txt)`
  shows `✗ denied by nisse` and
  `interrupted; it may or may not have taken effect`, and `▸ exec` the host
  message. `approval/resolve` with `"allow": true`, as in **Terminated**,
  answers `{"accepted": false}`, and the project holds no `late.txt`.
- **Host dies in wait.** `code_mode_host_dies_in_wait`: send
  `read the manifest in the background`, `drive.ts r tui wait 'wait(call_1)'`,
  stop the host, `drive.ts r tui wait 'The host stopped.'`:
  `▸ cell(call_1)` ends `interrupted; it may or may not have taken effect`
  and `▸ wait(call_1)` the host message. Request 3's `developer` note starts
  `Cell call_1 stopped before its script finished.` and lists
  `- Read (done):` with the manifest.
- **Host dies, two scripts.** `code_mode_host_dies_two_scripts`: send
  `start two scripts`, `drive.ts r tui wait 'wait(call_1)'` with the second
  script's `Bash` asking, stop the host,
  `drive.ts r tui wait 'The host stopped.'`: the `Bash` call shows
  `✗ denied by nisse` and `interrupted; ...`, both cells end
  `interrupted; ...`, and `▸ wait(call_1)` shows the host message. Request 4
  carries two notes, `Cell call_1 stopped before its script finished.` and
  `Cell call_2 ...` listing
  `- Bash (failed): interrupted; it may or may not have taken effect`.
- **Wait after host restart.** `code_mode_wait_after_host_restart`: send
  `start a slow script, then another once its host stops`,
  `drive.ts r tui wait 'wait(call_1)'`, stop the host,
  `drive.ts r tui wait checked`, `drive.ts r tui screen host-restart`:
  `▸ wait(call_1)` shows the host message, a second `▸ exec` shows
  `Script running with cell ID call_3`, and a later `▸ wait(call_1)` shows
  `no running cell call_1; it already finished, or the code-mode host running it stopped`
  rather than anything from `call_3`; then `checked`. `host.pid` now holds
  the new host's pid. All five requests are `as recorded`.
- **Idle stop.** This one takes five minutes. Make the run with
  `--fake-openai code_mode_script,code_mode_script`, install the host,
  write the launcher and start the server with it as above, then keep the
  server up with `drive.ts r tui start` and `drive.ts r tui wait READY`.
  Run
  `drive.ts r nisse exec --auto --provider openai --model gpt-6.1-sol 'what does echo say?'`:
  `It says hi.`, and the pid in `host.pid` is running. Wait for it to exit
  with
  `timeout 420 sh -c 'while kill -0 "$(cat /tmp/nisse-verify/r/launcher/host.pid)" 2>/dev/null; do sleep 5; done'`:
  it exits 0 about five minutes after the script ended. The same `exec`
  again answers `It says hi.`, and `host.pid` holds a new pid.

## Gotchas

- Code mode depends on the model's catalog entry, not on anything a person
  sets: ChatGPT's list once signed in, else the saved list, else the shipped
  one. `models/list` does not say which models use it;
  `cache/openai-models.json` does, as `"tool_mode": "code_mode_only"`.
- The host is looked for at each run's start, so installing it needs no
  server restart; `NISSE_CODE_MODE_HOST` is read when the server starts.
- An open TUI starts a stopped server again with the TUI's own environment,
  so stop the TUI before starting the server with `NISSE_CODE_MODE_HOST`.
- A set `NISSE_CODE_MODE_HOST` that names no file is not passed over: the run
  fails with the host message even when `NISSE_HOME/bin` holds the host.
- With a code-mode model and no host, the host message comes before the
  sign-in check, so a signed-out person sees it first.
- The host is a 75 MB download; `scripts/code-mode-host.sh` checks its
  SHA-256 and replaces it only when the pinned release changes.
- A call cut off while it asked shows `✗ denied by nisse`: nisse answered
  the approval when the script stopped.
- `NISSE_CODE_MODE_HOST` reaches the server only from the command that
  starts it: put it on `serve`, `tui start` or `nisse`, never on `up`.
- No recording holds a script that `store`s and a later one that `load`s;
  only the real account's **Memory across scripts** shows it.
- What the model is told about a stopped script is in `fake-openai.ndjson`,
  not in the transcript: the committed result is the `interrupted` line
  alone.
- The `cwd` of a TUI started with `tui start` is the checkout, which has no
  `Cargo.toml`; the stop steps start their conversation in the project over
  the wire.
- Once in five tries of **Yielded, server stopped**, the run ended at the
  `kill -TERM` with `"outcome": "failed"` and
  `the response stream broke: TypeError: ECONNRESET: ...` instead of being
  resumed. Report it with the run's `evidence/` if you see it.

## With a real account

Needs a ChatGPT sign-in kept for verification, as SKILL.md's
[Real accounts](../SKILL.md#real-accounts) says. Start with
`drive.ts r up --openai-auth <that file>` and install the host. First check:
`drive.ts r serve` and `drive.ts r rpc providers/list '{}'` list `openai`
as `"status": "ready"` with your account; otherwise stop and report what it
shows. Before a later `rpc` or `watch`, if `drive.ts r doctor` shows
`none running`, run `drive.ts r serve` again. It proves that ChatGPT today
puts the model in code mode and writes scripts nisse runs. Save `evidence/`
with the screens.

- **Pick a model.** `drive.ts r rpc models/list '{}'` saves ChatGPT's list
  to `/tmp/nisse-verify/r/home/cache/openai-models.json`. Pick a `slug`
  whose entry there has `"tool_mode": "code_mode_only"`, and copy the file
  into `evidence/`. Use it as `<model>` below.
- **Calls.** `drive.ts r tui start --provider openai --model <model>`,
  `drive.ts r tui wait READY`, take `<id>` from the header, send
  `Use exec to run a script that calls tools.Bash with the command 'echo approved', then reply with its output.`,
  `drive.ts r tui wait --timeout 120000 'allow this call?'`: `▸ exec` and
  `▸ Bash(echo approved)` asking. `drive.ts r tui key C-y`,
  `drive.ts r tui wait --timeout 120000 READY`, `drive.ts r tui screen real`:
  `✓ allowed by ada`, `approved`, and the answer.
  `drive.ts r watch <id> --save real` shows the nested `Bash` `tool_call`
  with a `parent`.
- **Memory across scripts.** Send
  `Use exec to store the value 42 under the key answer, then in a second exec load it and print it.`,
  `drive.ts r tui wait --timeout 120000 READY`: two `▸ exec` calls, the
  second printing `42`.
- **Reopen.** `drive.ts r tui stop`, `drive.ts r tui start --conversation <id>`,
  send `What did the last script print?`: ChatGPT answers from the script's
  output.
- **Direct tools.** `drive.ts r tui stop`, then
  `drive.ts r tui start --provider openai --model gpt-5.5`, send
  `Use the Bash tool to run exactly: echo approved  Then reply with its output.`
  and `drive.ts r tui wait --timeout 120000 'allow this call?'`:
  `▸ Bash(echo approved)` asks directly, with no `▸ exec` above it.
  `drive.ts r tui key C-y`, `drive.ts r tui wait --timeout 120000 READY`,
  `drive.ts r tui screen direct`.
