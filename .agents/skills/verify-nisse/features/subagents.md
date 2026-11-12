# Subagents

An OpenAI or scripted model can start subagents with Codex's agent tools:
`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`
and `interrupt_agent`. Each subagent works in a conversation of its own, on
its parent's provider and in its directory, addressed by a task name such as
`/root/scribe`. The parent's transcript shows a card per subagent with what it
last did and whether it works, waits on a person or ended; a call the subagent
asks about shows on its card and `^Y` or `^N` answers it from the parent. A
subagent's last message of each run reaches its parent. `Esc` stops the run
and every subagent's under it. On Claude, Claude Code runs its own subagents,
and nisse commits each into a conversation of its own the same way.

## Sub-features

- `subagent-spawn` starts a subagent from a `spawn_agent` call: the TUI draws a
  `⧉ <name>` card in place of the call, and `conversation/list`
  gains a conversation whose `lineage` names its `parent`, `root`, `call`,
  `task` and `title`.
- `subagent-fork` gives a subagent its parent's history up to the spawn
  (its view's `conversation.parent`), or none with `"fork_turns": "none"`.
- `subagent-model` runs a subagent on its parent's model, or on the `model`
  its `spawn_agent` names when the parent's provider lists it; an unlisted
  model fails the call.
- `subagent-card` shows the card's state: `working`, `waiting on you` with the
  asked call and `allow <Tool(subject)>?  ^Y  allow  ^N  deny`, `done` with its
  last message, `interrupted` or `failed`.
- `subagent-approve` answers a subagent's asked call with `^Y` or `^N` in the
  parent's TUI, or `approval/resolve` on the subagent's conversation. A call
  asked deeper in the tree shows on the card of the subagent above it.
- `subagent-message` delivers a parent's `send_message` to a running subagent
  at its next step, as a `nisse.mail` entry of kind `message`
  inside the same run; it starts no run.
- `subagent-agents` shows the tree with `list_agents` (each agent's name and
  `running`, `interrupted`, `completed` or `errored`), and stops one
  subagent from its parent with `interrupt_agent`, answering its previous
  status.
- `subagent-root-env` runs a subagent's commands with
  `NISSE_ROOT_CONVERSATION` set to the conversation people started.
- `subagent-answer` hands a subagent's last message to its parent: a waiting
  `wait_agent` returns `Wait completed.`, and the message shows under a
  `/root/<name>` author in the parent's transcript; an idle parent gets it as
  input that starts a run.
- `subagent-followup` wakes an idle subagent with `followup_task`, and each of
  its answers reaches the parent.
- `subagent-interrupt` stops the parent's run and every run under it with
  `Esc` or `conversation/interrupt`; the card shows `interrupted`. Stopping
  just a subagent, from its own conversation, stops it and the subagents
  under it, not its parent.
- `subagent-exec` makes `nisse exec` without `--auto` deny the calls its
  subagents would ask about, as it does its own; `exec` follows every
  conversation of its tree.
- `subagent-limits` takes `[agents] max_depth` (default 1) and `max_threads`
  (default 6) from `NISSE_HOME/config.toml`: a conversation at the depth
  limit is not offered `spawn_agent`, the root too when `max_depth = 0`, and
  its code mode scripts have no `tools.spawn_agent` either; a tree runs at
  most `max_threads` subagents at once.
- `subagent-types` reads agent types from `.claude/agents/*.md` from the
  directory up to the repository root, then Claude Code's config directory's
  `agents/` (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). A ChatGPT conversation
  is told them under `# Agent types` and names one as `spawn_agent`'s
  `agent_type`; an unknown one fails the call, naming the types there are.
  A subagent offered no `spawn_agent` is told no types. The subagent's
  instructions end with `# You are a <name> agent` and the
  type's body, its `lineage` has `agentType`, its card reads
  `⧉ <name> (<agent type>)`, and it runs on the type's `model` when ChatGPT
  lists it.
- `subagent-claude` gives each subagent Claude Code starts a conversation of
  its own: the parent shows a `⧉ <description> (<agent type>)` card in place
  of the `Agent` call, the subagent's conversation holds its prompt, calls, results and last
  message, and its `lineage` has no `task`. Its calls wait on a person there
  and on its card. Input to it is refused with `TakesNoInput`, and its TUI
  prompt reads `INPUT GOES THROUGH ITS PARENT`. `Esc` there stops only it;
  stopping the parent ends it `interrupted`, and so does a server crash.

## How to get to it

### People

- Ask an OpenAI conversation for work it hands to subagents, in the TUI.
- Ask a Claude conversation to use its Task tool.
- Open a subagent with `nisse --conversation <id>`.
- Set `[agents] max_depth` and `max_threads` in `NISSE_HOME/config.toml` before the server starts.

### Agents

- Run `nisse exec --provider openai` with such a prompt.
- Drive it without a model through `NISSE_MODEL_SCRIPT`: a step with `"agent": "/root/<name>"` is played by that subagent, the others by the parent.
- Read the tree with `conversation/list` (`lineage`).
- Set `[agents] max_depth` and `max_threads` in `NISSE_HOME/config.toml` before the server starts.

## Driving it with drive.ts

Preconditions:

- A fresh run for each journey, with the script or fixture it names, and
  `drive.ts r down` after it. Write each script to a file and pass it with
  `drive.ts r up --script <file>`.
- Take ids from `drive.ts r rpc conversation/list`: the parent has no
  `lineage`, each subagent has one.

- **Spawn, approve, answer.** With this script:

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "scribe", "message": "write it down" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "the scribe is done" },
    { "agent": "/root/scribe", "tool": { "name": "bash", "input": { "command": "echo scribbled" } } },
    { "agent": "/root/scribe", "text": "wrote it" }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `delegate` and `Enter`. Wait
  for `allow bash(echo scribbled)?`: the screen shows
  `⧉ scribe waiting on you` (the card stands in place of the call), `bash(echo scribbled)` and `◆ WAITING`. Press
  `C-y` and wait for `the scribe is done`: the card reads `⧉ scribe done` over
  `wrote it`, `▸ wait_agent` shows
  `{"message":"Wait completed.","timed_out":false}`, then `/root/scribe` says
  `wrote it` and `NISSE` says `the scribe is done`, `■ READY`.
  `drive.ts r rpc conversation/list` lists the subagent with
  `"lineage": {"parent": <the TUI's conversation>, "task": "/root/scribe", "title": "scribe", ...}`.

- **Message, list and interrupt.** With this script:

  ```json
  [
    {
      "tool": {
        "name": "spawn_agent",
        "input": { "task_name": "reader", "message": "read the hostname", "fork_turns": "none" }
      }
    },
    { "tool": { "name": "list_agents", "input": {} } },
    { "tool": { "name": "send_message", "input": { "target": "reader", "message": "also say it twice" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "reader reported" },
    {
      "agent": "/root/reader",
      "text": "reading it now slowly",
      "delayMs": 600,
      "tool": { "name": "read", "input": { "path": "/etc/hosts" } }
    },
    { "agent": "/root/reader", "text": "read it" }
  ]
  ```

  run `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "provider": "script"}'`
  and
  `drive.ts r watch <id> --submit delegate --until run_end --timeout 30000 --save message`:
  `list_agents` returns
  `{"agents":[{"agent_name":"/root","agent_status":"running"},{"agent_name":"/root/reader","agent_status":"running"}]}`,
  `send_message` returns an empty result, `wait_agent` returns
  `Wait completed.`, and `reader reported` ends the run.
  `drive.ts r watch <reader id> --save reader` shows a `nisse.mail`
  `new_task`, the `read` call and its result, then a `nisse.mail` `message`
  `also say it twice`, then `read it` and a `nisse.run_end` `answered`: the
  message joined the run after its call finished.

- **Interrupt one subagent from the parent.** In a fresh run, with this
  script:

  ```json
  [
    {
      "tool": {
        "name": "spawn_agent",
        "input": { "task_name": "slowpoke", "message": "count slowly", "fork_turns": "none" }
      }
    },
    { "tool": { "name": "interrupt_agent", "input": { "target": "slowpoke" } } },
    { "tool": { "name": "list_agents", "input": {} } },
    { "text": "stopped it" },
    { "agent": "/root/slowpoke", "text": "one two three four five six seven eight nine ten", "delayMs": 1500 }
  ]
  ```

  start a `script` conversation as above and run
  `drive.ts r watch <id> --submit 'stop the slowpoke' --until run_end --save interrupt-agent`:
  `interrupt_agent` returns `{"previous_status":"running"}`, `list_agents`
  then lists `/root/slowpoke` as `interrupted`, and the run ends
  `stopped it`. `drive.ts r watch <slowpoke id>` shows the `nisse.mail`
  `new_task` and a `nisse.run_end` `interrupted`.

- **Answered over the wire.** With the `Spawn, approve, answer` script, run
  `drive.ts r serve`, start a `script` conversation, and
  `drive.ts r watch <id> --submit delegate --until pi.tool-result`; take the
  subagent's id from `drive.ts r rpc conversation/list`. Run
  `drive.ts r watch <subagent id> --save scribe-asking` and take the key of
  the request in its `docs.nisse.approvals.requests`, the approval id. Run
  `drive.ts r rpc approval/resolve '{"conversation": "<subagent id>", "approval": "<approval>", "author": "bo", "allow": true}'`:
  `"accepted": true`; the same call with `"author": "cy"` and
  `"allow": false` answers `"accepted": false`. `drive.ts r watch <subagent id>`
  shows the `nisse.approval` by `bo`, the `pi.tool-result` `scribbled`, then
  `wrote it`, and `drive.ts r watch <id>` ends `the scribe is done`.

- **Asked two levels down.** After `up`, write the depth to the home's config
  before anything starts the server:

  ```sh
  printf '[agents]\nmax_depth = 2\n' > /tmp/nisse-verify/r/home/config.toml
  ```

  and use the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "lead", "message": "get it done" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "the lead is done" },
    {
      "agent": "/root/lead",
      "tool": { "name": "spawn_agent", "input": { "task_name": "helper", "message": "do the thing" } }
    },
    { "agent": "/root/lead", "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "agent": "/root/lead", "text": "the helper is done" },
    { "agent": "/root/lead/helper", "tool": { "name": "bash", "input": { "command": "echo deep" } } },
    { "agent": "/root/lead/helper", "text": "did it" }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `delegate` and `Enter`, and
  wait for `allow bash(echo deep)?`: on the parent's screen `⧉ lead waiting on you`
  holds `allow bash(echo deep)?  ^Y  allow  ^N  deny`, though the call is the
  helper's. Press `C-y` and wait for `the lead is done` and `READY`: the card
  reads `⧉ lead done` over `the helper is done`.
  `drive.ts r rpc conversation/list` has `"task": "/root/lead/helper"`, and
  `drive.ts r watch <helper id>` shows a `nisse.approval` by `ada` and the
  `pi.tool-result` `deep`.

- **Root conversation in a subagent.** With the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "envy", "message": "show your root" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "envy answered" },
    { "agent": "/root/envy", "tool": { "name": "bash", "input": { "command": "echo root=$NISSE_ROOT_CONVERSATION" } } },
    { "agent": "/root/envy", "text": "shown", "delayMs": 1 }
  ]
  ```

  run `drive.ts r nisse exec --auto delegate`: stdout `envy answered`. Take the
  ids from `drive.ts r rpc conversation/list`: the subagent's `lineage` names
  the parent as `root`. `drive.ts r watch <subagent id> --save root-env`
  holds a `pi.tool-result` `root=<the parent's id>`.

- **Exec denies a subagent's call.** With the `Spawn, approve, answer` script, in a fresh run,
  `drive.ts r nisse exec delegate`: exit 0, stdout `the scribe is done`,
  stderr `› spawn_agent(scribe)`, `› wait_agent` and
  `denied bash(echo scribbled): exec cannot ask, pass --auto to allow calls`:
  `exec` follows every conversation of its tree. `drive.ts r watch <subagent id>`
  shows the denied call's `pi.tool-result`, then `wrote it`. In another fresh run, `drive.ts r nisse exec --auto delegate`
  prints no denial.

- **Interrupt.** With the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "slowpoke", "message": "count slowly" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "agent": "/root/slowpoke", "text": "one two three four five six seven eight nine ten", "delayMs": 1500 }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `count`, `Enter`, wait for
  `slowpoke`, press `Escape` and wait for `READY`: the card reads
  `⧉ slowpoke interrupted`, then `◆ interrupted`.

- **Interrupt over the wire.** With the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "slow", "message": "make it", "fork_turns": "none" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "tool": { "name": "bash", "input": { "command": "touch made" } }, "agent": "/root/slow" }
  ]
  ```

  run `drive.ts r serve`, start a conversation with `conversation/start`, and
  `drive.ts r watch <id> --submit 'start a slow one' --save root-start`; take
  the subagent's id from the `details` of the `spawn_agent` result.
  `drive.ts r watch <subagent id>` shows its `bash` call in
  `nisse.approvals`. Run
  `drive.ts r rpc conversation/interrupt '{"conversation": "<id>"}'` (result
  `null`) on the root only. `drive.ts r watch <id>` and
  `drive.ts r watch <subagent id>` each end with a `nisse.run_end`
  `interrupted`, no `pi.live` run, and the subagent's approval requests are
  empty; `made` was never created.

- **Follow-up.** With the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "scribe", "message": "note one thing" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "tool": { "name": "followup_task", "input": { "target": "scribe", "message": "note another" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "both notes in" },
    { "agent": "/root/scribe", "text": "first note", "delayMs": 1000 },
    { "agent": "/root/scribe", "text": "second note", "delayMs": 1000 }
  ]
  ```

  run `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "provider": "script"}'`
  and
  `drive.ts r watch <id> --submit 'take notes' --until run_end --save followup`:
  each `wait_agent` returns `Wait completed.`, each followed by a
  `nisse.mail` `final_answer` from `/root/scribe`,
  `first note` then `second note`, then `both notes in`.
  `drive.ts r watch <subagent id> --save scribe` shows two runs, started by
  `note one thing` and `note another`, each a `nisse.mail` `new_task` from
  `/root`.

- **Idle parent, no history, another model.** With the script

  ```json
  [
    {
      "tool": {
        "name": "spawn_agent",
        "input": { "task_name": "loner", "message": "go alone", "fork_turns": "none" }
      }
    },
    {
      "tool": {
        "name": "spawn_agent",
        "input": { "task_name": "other", "message": "go elsewhere", "model": "gpt-5.5" }
      }
    },
    { "text": "sent off" },
    { "agent": "/root/loner", "text": "back later", "delayMs": 1500 }
  ]
  ```

  start a `script` conversation as above and run
  `drive.ts r watch <id> --submit 'send them' --until run_end --save sent`:
  the second `spawn_agent` fails with
  `no model gpt-5.5 on script; leave model out to use yours`, and the run ends
  `sent off`. `conversation/list` holds one subagent, `/root/loner`, whose
  view has no `conversation.parent`. Run
  `drive.ts r watch <loner id> --until run_end`, then
  `drive.ts r watch <id> --save idle-parent`: after the parent's
  `nisse.run_end` comes `back later` from `/root/loner` as a `nisse.mail`
  `final_answer`, which starts a new run of the parent.

- **Limits.** Thread limit: write `[agents]` and `max_threads = 1` to
  `/tmp/nisse-verify/r/home/config.toml` after `up` and before anything starts
  the server, and use the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "first", "message": "go" } } },
    { "tool": { "name": "spawn_agent", "input": { "task_name": "second", "message": "go too" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "one at a time" },
    { "agent": "/root/first", "text": "first done", "delayMs": 1000 }
  ]
  ```

  `drive.ts r nisse exec spread`: stdout `one at a time`, and
  `drive.ts r watch <parent id> --save threads` shows the second
  `spawn_agent`'s result starting
  `at most 1 subagents work at once (maxThreads)`.
  Depth limit: in a fresh run, `drive.ts r up --fake-openai subagent`, write
  `[agents]` and `max_depth = 0` to the same file, and run
  `drive.ts r nisse exec --provider openai 'Send a scout to find the gnome.'`:
  in `evidence/fake-openai.ndjson` the first request's `tools` has no
  `spawn_agent`. The recording calls it anyway, and the call's result is
  `Tool spawn_agent is not available`. `conversation/list` holds no
  subagent.

- **OpenAI subagent** (`--fake-openai subagent`). `drive.ts r tui start --provider openai`,
  wait for `READY`, type `Send a scout to find the gnome.` and `Enter`, then
  wait for `The scout says` and `READY`: `⧉ scout done` over `Under the floor.`, `▸ wait_agent` with
  `{"message":"Wait completed.","timed_out":false}`, `/root/scout` saying
  `Under the floor.`, then `The scout says: under the floor.`
  `conversation/list` has the subagent with `"task": "/root/scout"`. In
  `evidence/fake-openai.ndjson` all three requests are `as recorded`; the
  second is the subagent's: no `spawn_agent` tool, and six input items: the
  parent's prompt, the `spawn_agent` and `wait_agent` calls from the spawning
  response, two placeholder results reading
  `Tool result unavailable: history ends before this call completed.`, then
  `Message Type: NEW_TASK` for `/root/scout`.

- **Agent types, no history** (`--fake-openai subagent_of_a_type`, whose
  `spawn_agent` names `"agent_type": "reviewer"` and `"fork_turns": "none"`).
  Make a project with an agent type:

  ```sh
  P=/tmp/nisse-verify/r/project
  mkdir -p $P/.git $P/.claude/agents
  printf -- '---\nname: reviewer\ndescription: Reviews diffs\n---\nBe strict about tests.\n' > $P/.claude/agents/reviewer.md
  ```

  Run `drive.ts r serve` with `CLAUDE_CONFIG_DIR` set to an empty folder, so
  your own agent types stay out,
  `drive.ts r rpc conversation/start '{"cwd": "/tmp/nisse-verify/r/project", "provider": "openai"}'`
  and
  `drive.ts r watch <id> --submit 'Get the diff reviewed.' --until run_end --save typed`:
  the answer is `The reviewer approves.`, and `conversation/list` shows the
  subagent with `"agentType": "reviewer"` in its `lineage` and no
  `forkedAt`. In `evidence/fake-openai.ndjson`, all `as recorded`, the
  parent's instructions list `- reviewer: Reviews diffs` under
  `# Agent types`, and the second request,
  the subagent's, has one input item, instructions holding
  `# You are a reviewer agent`, and no `spawn_agent` tool.

- **Claude subagent asks** (`--fake-claude subagent_asks`).
  `drive.ts r tui start --provider claude`, wait for `READY`, type
  `Use the Task tool to start a general-purpose subagent that reads notes.txt with the Read tool and reports where the gnome lives. Do not read it yourself. Then reply with where the gnome lives, in three words.`
  and `Enter`, then wait for `waiting on you`:
  `⧉ Find gnome location in notes (general-purpose) waiting on you` over
  `Bash(touch made.txt)` and `allow Bash(touch made.txt)?  ^Y  allow  ^N  deny`.
  Press `C-y` and wait for `READY`: the card reads `done` over
  `Made made.txt.`, then `Under the floor.` `drive.ts r rpc conversation/list`
  lists the subagent with `lineage` `parent`, `root`, `call`,
  `"title": "Find gnome location in notes"` and
  `"agentType": "general-purpose"`, and no `task`. `drive.ts r tui stop`,
  then `drive.ts r tui start --conversation <subagent id>` and
  `drive.ts r tui wait 'INPUT GOES THROUGH ITS PARENT'`: its prompt, the call
  `✓ allowed by ada`, and `Made made.txt.`
  `drive.ts r rpc conversation/submit '{"conversation": "<subagent id>", "author": "ada", "text": "hi", "requestId": "r1"}'`
  fails with `TakesNoInput`.

- **Claude subagent, plain** (`--fake-claude subagent`). Send the same prompt
  as `Claude subagent asks`, with `drive.ts r tui start --provider claude`, and wait for
  `Under the floor.` and `READY`:
  `⧉ Find gnome location in notes (general-purpose) done` over its last
  message, and the answer. No call waits on you. `conversation/list` lists
  the subagent with `"title": "Find gnome location in notes"` and
  `"agentType": "general-purpose"`. `drive.ts r watch <subagent id> --save plain-sub`
  holds the prompt, a `Read` call that ran without a `nisse.approval`, its
  `pi.tool-result`, the answer and a `nisse.run_end` `answered`. `drive.ts r tui stop`, then
  `drive.ts r tui start --conversation <subagent id>` and
  `drive.ts r tui wait 'INPUT GOES THROUGH ITS PARENT'`: the same transcript.
  The recording's prompt and answer name your checkout, which replaces the
  recording's `<workspace>` paths, and the recorded `notes.txt` text, which
  the fake does not read from your disk.

- **Claude subagent stopped over the wire** (`--fake-claude subagent_stopped`).
  Send the same prompt and wait for `(general-purpose) working`. Run
  `drive.ts r rpc conversation/interrupt '{"conversation": "<subagent id>", "author": "ada"}'`,
  then wait for `READY`: the card reads `interrupted`, and the parent goes on
  to `The subagent was stopped.` `evidence/fake-claude/log.ndjson` holds a
  `stop_task` request.

- **Claude subagent stopped with `Esc` in its own pane**
  (`--fake-claude subagent_stopped`). Send the same prompt and wait for
  `(general-purpose) working`. `drive.ts r tui stop`; the parent's run goes
  on. `drive.ts r tui start --conversation <subagent id>`,
  `drive.ts r tui wait 'INPUT GOES THROUGH ITS PARENT'`,
  `drive.ts r tui screen sub-working`: `WORKING`, the prompt and
  `▸ Read(<checkout>/notes.txt)`. Press `Escape`, wait for `interrupted`,
  `drive.ts r tui screen sub-stopped`: `◆ interrupted`. The log holds one
  `stop_task` request, and `drive.ts r watch <parent id> --save parent` ends
  with the answer `The subagent was stopped.` and a `nisse.run_end`
  `answered`: only the subagent stopped.

## Contexts

- **Ids.** `conversation/list` lists each subagent after its parent, with
  `lineage` naming `parent`, `root`, `call` (the `spawn_agent` call's id),
  `title` and `task`, and with the model its `spawn_agent` named. Ids are
  numbers, or the id a client chose at `conversation/start`.
- **Provider.** Claude keeps Claude Code's own subagents, which take input only through their parent. OpenAI uses Codex's agent tools.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- child-tools, subagent-answer: the model spawns a subagent, waits for it, and its final answer is mailed back
- subagent-types: spawning an agent of a type nisse doesn't know is refused, naming it
- subagent-limits, child-tools: spawns in one response start at most maxThreads subagents
- subagent-limits, child-tools: a follow-up task does not wake an idle subagent while maxThreads subagents work
- child-tools, subagent-message, subagent-followup: a subagent takes messages and follow-up tasks, and cannot start subagents past the depth limit
- child-tools, subagent-agents: interrupting a subagent stops its turn and reports what it was doing
- subagent-root-env, tool-root-env: an extension's tool run by a subagent knows the conversation people started
- subagent-limits: a tree runs at most as many subagents at once as config.toml allows
- subagent-interrupt: interrupting a conversation stops the runs of its subagents too, and the tree goes idle
- subagent-spawn, subagent-model: conversation/list shows each subagent with its lineage, on its parent's model or the one its spawn_agent names, and an unlisted model fails the call
- subagent-answer: a subagent's answer reaches its idle parent as input that starts a run, so the parent acts on it

Screen, `packages/nisse/test/screen.test.ts`:

- subagent-card: a subagent shows as a card under its parent, and ctrl+y answers the call it asks about
- subagent-card, codemode-nested-policy: a subagent a script started shows as a card under the script, and ctrl+y answers the call it asks about
- subagent-approve: a call a subagent's subagent asks about shows on the card above it, and ctrl+y answers it
- subagent-card: a Claude subagent shows as a card in place of its call's result, and its own screen sends input to its parent

Stack, `packages/nisse/test/stack.test.ts`:

- subagent-exec: nisse exec without --auto denies the calls its subagents would ask about too
- subagent-exec: nisse exec continuing a subagent denies the calls of the subagents it starts

Provider, `packages/nisse/test/openai.test.ts`:

- subagent-fork: a spawned agent's requests carry its own conversation, and its last answer reaches the parent
- subagent-types: an agent of a type gets its instructions and its model, and fork_turns none leaves the parent's history out

Provider, `packages/nisse/test/claude.test.ts`:

- subagent-claude: a Claude subagent works in a conversation of its own under the one that started it
- subagent-claude: a call a Claude subagent wants to make waits for a person in the subagent's conversation
- subagent-interrupt: stopping a Claude subagent stops only it, and its parent's run carries on
- subagent-interrupt: stopping a run ends the Claude subagents working under it
- subagent-spawn: a Claude subagent is listed under its parent with the call that started it, and takes no input of its own
- subagent-claude: a Claude subagent that hands back its report answers with the report, not Claude Code's placeholder

## Gotchas

- Steps play in order per author: the parent's steps and each
  `/root/<name>`'s steps are separate queues in the one script.
- A scripted subagent answers as soon as it starts. Give its step a `delayMs`
  when the parent should be waiting in `wait_agent` by then: a message that
  arrives before the wait is steered into the parent's run, and the wait then
  sits until its timeout.
- A subagent's run is its own: wait for its end with `watch` on its
  conversation, not the parent's.
- `[agents]` is read when the server starts: write `config.toml` before the
  first `exec`, `serve` or TUI start, or `rpc server/stop` after it.
- A recording proves nisse's side only; the fake Claude does not run the
  subagent's calls, so no `made.txt` appears.
- No recording has an OpenAI `spawn_agent` that names a `model`; the scripted
  step shows the refusal only, and the real account shows a subagent on
  another model.
- Stopping a subagent from its own conversation sends its parent no report:
  a parent waiting in `wait_agent` waits on until its timeout.

## With a real account

Proves that a real model chooses to start subagents and that Claude Code's
real subagents ask. Follow the skill's [Real accounts](../SKILL.md#real-accounts),
and start each run with its first check. No step needs a person. Give every
`tui wait` `--timeout 180000`, and save `evidence/` and the screens.

ChatGPT, in a run made with `drive.ts r up --openai-auth <your saved sign-in>`:

- **Spawn and answer.** `drive.ts r tui start --provider openai`, send
  `Start a subagent named scout that replies with exactly: found it. Wait for it, then tell me what it said.`,
  wait for `READY` and save the screen: `⧉ scout done` and an answer naming `found it`.
- **Another model.** Pick a model from `drive.ts r rpc models/list '{}'` other
  than the conversation's whose entry in `/tmp/nisse-verify/r/home/cache/openai-models.json`
  has no `"tool_mode":"code_mode_only"`; if every other model has it, the
  subagent answers through the `codemode` tool, as
  [Code mode](./code-mode.md) says. Then send
  `Start a subagent named ranger on the model <that id> that replies with exactly: found it. Wait for it, then tell me what it said.`
  (a new name: `scout` exists from the step before, and a name is never reused):
  `/root/ranger`'s conversation in `conversation/list` has
  `"model": {"provider": "openai", "model": "<that id>", ...}`.
- **Follow-up.** Then send
  `Give scout a follow-up task: reply with exactly: found again. Wait for it, then tell me what it said.`:
  `▸ followup_task`, the card's last message `found again`, and the same
  subagent conversation, no new one.
- **Message and list.** Then send
  `Send scout the message "stay put", then list your agents and tell me each one's status.`:
  `▸ send_message`, `▸ list_agents` with `/root/scout` in its result, and a
  `nisse.mail` `message` `stay put` in the subagent's conversation.

Claude, in a run made with `drive.ts r up --real-claude`:

- **Spawn and answer.** `drive.ts r tui start --provider claude`, send
  `Use the Task tool to start a general-purpose subagent that replies with exactly: found it. Then tell me what it said.`:
  a `⧉ ... done` card over `found it`, and `conversation/list` holds the
  subagent, whose last message is `found it`. Claude Code 2.1.312 has the
  subagent hand its report back through a `SubagentHandback` call, and
  reports only a placeholder (`This agent's report was delivered to you as a
message...`) as its summary; neither the card nor the subagent shows that
  placeholder.
- **A subagent asks.** Send
  `Use the Task tool to start a general-purpose subagent that runs exactly: touch /tmp/nisse-verify/r/sub-made with the Bash tool. Then reply with one word: done`,
  wait for `waiting on you`: the card shows `allow Bash(touch /tmp/nisse-verify/r/sub-made)?`.
  Press `C-y` and wait for `READY`: the card reads `done`, and
  `/tmp/nisse-verify/r/sub-made` exists.
