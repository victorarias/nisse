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

- `subagent-spawn` starts a subagent from a `spawn_agent` call: the TUI shows
  `▸ spawn_agent(<name>)`, then a `⧉ <name>` card, and `conversation/list`
  gains a conversation whose `lineage` names its `parent`, `root`, `call`,
  `task` and `title`.
- `subagent-fork` gives a subagent its parent's history up to the spawn
  (`lineage.forkedAt`), or none with `"fork_turns": "none"`.
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
  at its next step, as a `user` entry with `"mail": {"kind": "message", ...}`
  inside the same run; it starts no run.
- `subagent-agents` shows the tree with `list_agents` (each agent's name and
  `running`, `interrupted`, `completed` or `errored`), and stops one
  subagent from its parent with `interrupt_agent`, answering its previous
  status.
- `subagent-root-env` runs a subagent's commands with
  `NISSE_ROOT_CONVERSATION` set to the conversation people started.
- `subagent-answer` hands a subagent's last message to its parent: a waiting
  `wait_agent` returns `Wait completed.`, and the message shows under a
  `/root/<name>` author in the parent's transcript; an idle parent gets it in
  its transcript without starting a run.
- `subagent-followup` wakes an idle subagent with `followup_task`, and each of
  its answers reaches the parent.
- `subagent-interrupt` stops the parent's run and every run under it with
  `Esc` or `conversation/interrupt`; the card shows `interrupted`. Stopping
  just a subagent, from its own conversation, tells its parent: a waiting
  `wait_agent` returns `Wait completed.` and the parent hears
  `A person interrupted this agent.`
- `subagent-exec` makes `nisse exec` without `--auto` deny the calls its
  subagents would ask about, as it does its own.
- `subagent-limits` takes `[agents] max_depth` (default 1) and `max_threads`
  (default 6) from `NISSE_HOME/config.toml`: at the depth limit
  `spawn_agent` is not offered, and a tree runs at most `max_threads`
  subagents at once.
- `subagent-types` reads agent types from `.claude/agents/*.md` from the
  directory up to the repository root, then Claude Code's config directory's
  `agents/`; a type's `model` applies when it names an OpenAI model.
- `subagent-claude` gives each subagent Claude Code starts a conversation of
  its own: the parent shows `▸ Agent` and a `⧉ <description> (<agent type>)`
  card, the subagent's conversation holds its prompt, calls, results and last
  message, and its `lineage` has no `task`. Its calls wait on a person there
  and on its card. Input to it is refused with `TakesNoInput`, and its TUI
  prompt reads `INPUT GOES THROUGH ITS PARENT`. `Esc` there stops only it;
  stopping the parent ends it `interrupted`, and so does a server crash.

## How to get to it (user POV)

- Ask an OpenAI conversation for work it hands to subagents, in the TUI or with
  `nisse exec --provider openai`.
- Ask a Claude conversation to use its Task tool.
- Drive it without a model through `NISSE_MODEL_SCRIPT`: a step with
  `"agent": "/root/<name>"` is played by that subagent, the others by the
  parent.
- Read the tree with `conversation/list` (`lineage`) and open a subagent with
  `nisse --conversation <id>`.
- Set `[agents] max_depth` and `max_threads` in `NISSE_HOME/config.toml`
  before the server starts.

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
    { "agent": "/root/scribe", "tool": { "name": "Bash", "input": { "command": "echo scribbled" } } },
    { "agent": "/root/scribe", "text": "wrote it" }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `delegate` and `Enter`. Wait
  for `allow Bash(echo scribbled)?`: the screen shows `▸ spawn_agent(scribe)`,
  `⧉ scribe waiting on you`, `Bash(echo scribbled)` and `◆ WAITING`. Press
  `C-y` and wait for `the scribe is done`: the card reads `⧉ scribe done` over
  `wrote it`, `▸ wait_agent` shows
  `{"message":"Wait completed.","timed_out":false}`, then `/root/scribe` says
  `wrote it` and `NISSE` says `the scribe is done`, `■ READY`.
  `drive.ts r rpc conversation/list` lists the subagent with
  `"lineage": {"parent": <the TUI's conversation>, "task": "/root/scribe", "title": "scribe", "forkedAt": <seq>, ...}`.

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
      "tool": { "name": "Read", "input": { "file_path": "/etc/hostname" } }
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
  `drive.ts r watch <reader id> --save reader` shows the `new_task`, the
  `Read` call and its result, then a `user` entry `also say it twice` with
  `"mail": {"kind": "message", ...}`, then `read it` and a `run_end`
  `answered`: the message joined the run after its call finished.

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
  `stopped it`. `drive.ts r watch <slowpoke id>` shows the `new_task` and a
  `run_end` `interrupted`.

- **Stopped from its own conversation.** With the script

  ```json
  [
    {
      "tool": {
        "name": "spawn_agent",
        "input": { "task_name": "slowpoke", "message": "count slowly", "fork_turns": "none" }
      }
    },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "heard back" },
    { "agent": "/root/slowpoke", "text": "one two three four five six seven eight nine ten", "delayMs": 1500 }
  ]
  ```

  run `drive.ts r serve`, start a `script` conversation as above, and
  `drive.ts r watch <id> --submit count --until subagent --save own-start`.
  Take the `conversation` of its `subagent` entry (the subagent's id) and the
  `seq` of its last line. Open the parent with
  `drive.ts r tui start --conversation <id>` and run
  `drive.ts r rpc conversation/interrupt '{"conversation": "<subagent id>", "author": "ada"}'`
  (result `null`), then
  `drive.ts r watch <id> --since <seq> --until run_end --timeout 30000 --save own`:
  `wait_agent` returns `Wait completed.`, a `user` entry from `/root/slowpoke`
  with `"mail": {"kind": "final_answer", ...}` says
  `A person interrupted this agent. If you still need it, use the available collaboration tools to give it another task.`,
  and the parent ends `heard back`, `answered`. `drive.ts r tui wait READY`,
  `drive.ts r tui screen own`
  shows `⧉ slowpoke interrupted` and `READY`, and
  `drive.ts r watch <subagent id>` ends with a `run_end` `interrupted`.

- **Answered over the wire.** With the `Spawn, approve, answer` script, run
  `drive.ts r serve`, start a `script` conversation, and
  `drive.ts r watch <id> --submit delegate --until subagent`; take the
  subagent's id from its `subagent` entry. Run `drive.ts r watch <subagent id> --save scribe-asking`
  and take the `approval` id of its `approval` entry. Run
  `drive.ts r rpc approval/resolve '{"conversation": "<subagent id>", "approval": "<approval>", "author": "bo", "allow": true}'`:
  `"accepted": true`; the same call with `"author": "cy"` and
  `"allow": false` answers `"accepted": false`. `drive.ts r watch <subagent id>`
  shows the `approval_answer` by `bo`, the `tool_result` `scribbled`, then
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
    { "agent": "/root/lead/helper", "tool": { "name": "Bash", "input": { "command": "echo deep" } } },
    { "agent": "/root/lead/helper", "text": "did it" }
  ]
  ```

  `drive.ts r tui start`, wait for `READY`, type `delegate` and `Enter`, and
  wait for `allow Bash(echo deep)?`: on the parent's screen `⧉ lead waiting on you`
  holds `allow Bash(echo deep)?  ^Y  allow  ^N  deny`, though the call is the
  helper's. Press `C-y` and wait for `the lead is done` and `READY`: the card
  reads `⧉ lead done` over `the helper is done`.
  `drive.ts r rpc conversation/list` has `"task": "/root/lead/helper"`, and
  `drive.ts r watch <helper id>` shows the `approval`, an `approval_answer` by
  `ada`, and the `tool_result` `deep`.

- **Root conversation in a subagent.** With the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "envy", "message": "show your root" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "text": "envy answered" },
    { "agent": "/root/envy", "tool": { "name": "Bash", "input": { "command": "echo root=$NISSE_ROOT_CONVERSATION" } } },
    { "agent": "/root/envy", "text": "shown", "delayMs": 1 }
  ]
  ```

  run `drive.ts r nisse exec --auto delegate`: stdout `envy answered`. Take the
  ids from `drive.ts r rpc conversation/list`: the subagent's `lineage` names
  the parent as `root`. `drive.ts r watch <subagent id> --save root-env`
  holds a `tool_result` `root=<the parent's id>`.

- **Exec denies a subagent's call.** With the same script, in a fresh run,
  `drive.ts r nisse exec delegate`: exit 0, stdout `the scribe is done`,
  stderr `› spawn_agent(scribe)`, `› wait_agent` and
  `denied Bash(echo scribbled): exec cannot ask, pass --auto to allow calls`.
  `drive.ts r watch <subagent id>` shows the `approval`, then the
  `tool_result` `denied: the person did not allow this call`, then
  `wrote it`. In another fresh run, `drive.ts r nisse exec --auto delegate`
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
  `⧉ slowpoke interrupted`, `▸ wait_agent` shows
  `interrupted; it may or may not have taken effect`, then `◆ interrupted`.

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
  each `wait_agent` returns `Wait completed.`, each followed by a `user`
  entry from the subagent with `"mail": {"kind": "final_answer", ...}`,
  `first note` then `second note`, then `both notes in`.
  `drive.ts r watch <subagent id> --save scribe` shows two runs, started by
  `note one thing` and `note another`, each a `new_task` from `/root`.

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
  `lineage` has no `forkedAt`. Run
  `drive.ts r watch <loner id> --until run_end`, then
  `drive.ts r watch <id> --save idle-parent`: after the parent's `run_end`
  comes `back later` from `/root/loner` as a `user` entry, with no new run and
  the status `idle`.

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
  `spawn_agent`'s result
  `this tree already runs 1 subagents, the most it may run at once; wait for one to finish`.
  Depth limit: in a fresh run, `drive.ts r up --fake-openai subagent`, write
  `[agents]` and `max_depth = 0` to the same file, and run
  `drive.ts r nisse exec --provider openai 'Send a scout to find the gnome.'`:
  in `evidence/fake-openai.ndjson` the first request's `tools` has no
  `spawn_agent`. The recording calls it anyway, so the second request, the
  parent's own, holds the result `no tool named spawn_agent` and a
  `wait_agent` that timed out after 30 s; the recording's subagent answer,
  `Under the floor.`, is what the parent says. `conversation/list` holds no
  subagent. Both requests are `as recorded`, since the recording matches any
  input, and its third reply goes unused.

- **OpenAI subagent** (`--fake-openai subagent`). `drive.ts r tui start --provider openai`,
  wait for `READY`, type `Send a scout to find the gnome.` and `Enter`, then
  wait for `The scout says` and `READY`: `▸ spawn_agent(scout)`,
  `⧉ scout done` over `Under the floor.`, `▸ wait_agent` with
  `{"message":"Wait completed.","timed_out":false}`, `/root/scout` saying
  `Under the floor.`, then `The scout says: under the floor.`
  `conversation/list` has the subagent with `"task": "/root/scout"`. In
  `evidence/fake-openai.ndjson` all three requests are `as recorded`; the
  second is the subagent's: no `spawn_agent` tool, and two input items, the
  parent's prompt and `Message Type: NEW_TASK` for `/root/scout`.

- **Agent types, no history** (`--fake-openai subagent_of_a_type`, whose
  `spawn_agent` names `"agent_type": "reviewer"` and `"fork_turns": "none"`).
  Make a project with an agent type:

  ```sh
  P=/tmp/nisse-verify/r/project
  mkdir -p $P/.git $P/.claude/agents
  printf -- '---\nname: reviewer\ndescription: Reviews diffs\n---\nBe strict about tests.\n' > $P/.claude/agents/reviewer.md
  ```

  Run `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"cwd": "/tmp/nisse-verify/r/project", "provider": "openai"}'`
  and
  `drive.ts r watch <id> --submit 'Get the diff reviewed.' --until run_end --save typed`:
  a `subagent` entry with `"agentType": "reviewer"`, then
  `The reviewer approves.` The subagent's `lineage` has no `forkedAt`. In
  `evidence/fake-openai.ndjson`, all `as recorded`, the parent's
  `spawn_agent` tool lists `- reviewer: Reviews diffs`, and the second
  request, the subagent's, has one input item, instructions holding
  `# You are a reviewer agent`, and no `spawn_agent` tool.

- **Claude subagent asks** (`--fake-claude subagent_asks`).
  `drive.ts r tui start --provider claude`, wait for `READY`, type
  `Use the Task tool to start a general-purpose subagent that reads notes.txt with the Read tool and reports where the gnome lives. Do not read it yourself. Then reply with where the gnome lives, in three words.`
  and `Enter`, then wait for `waiting on you`: `▸ Agent`, then
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
  `Under the floor.` and `READY`: `▸ Agent`, then
  `⧉ Find gnome location in notes (general-purpose) done` over its last
  message, and the answer. No call waits on you. `conversation/list` lists
  the subagent with `"title": "Find gnome location in notes"` and
  `"agentType": "general-purpose"`. `drive.ts r watch <subagent id> --save plain-sub`
  holds the prompt, a `Read` call that ran without an `approval`, its
  result, a `message` and a `run_end` `answered`. `drive.ts r tui stop`, then
  `drive.ts r tui start --conversation <subagent id>` and
  `drive.ts r tui wait 'INPUT GOES THROUGH ITS PARENT'`: the same transcript.
  The recording's prompt and answer name the checkout it was recorded in and
  the recorded `notes.txt` text, which the fake does not read from your disk.

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
  with the `message` `The subagent was stopped.` and a `run_end`
  `answered`: only the subagent stopped.

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

## With a real account

Proves that a real model chooses to start subagents and that Claude Code's
real subagents ask. Follow the skill's [Real accounts](../SKILL.md#real-accounts),
and start each run with its first check. No step needs a person. Give every
`tui wait` `--timeout 180000`, and save `evidence/` and the screens.

ChatGPT, in a run made with `drive.ts r up --openai-auth <your saved sign-in>`:

- **Spawn and answer.** `drive.ts r tui start --provider openai`, send
  `Start a subagent named scout that replies with exactly: found it. Wait for it, then tell me what it said.`,
  wait for `READY` and save the screen: `▸ spawn_agent(scout)`,
  `⧉ scout done` and an answer naming `found it`.
- **Another model.** Pick a model from `drive.ts r rpc models/list '{}'` other
  than the conversation's whose entry in `/tmp/nisse-verify/r/home/cache/openai-models.json`
  has no `"tool_mode": "code_mode_only"`; if every other model has it, install
  the host first with
  `NISSE_HOME=/tmp/nisse-verify/r/home scripts/code-mode-host.sh`. Then send
  `Start a subagent named scout on the model <that id> that replies with exactly: found it. Wait for it, then tell me what it said.`:
  the subagent's conversation in `conversation/list` has
  `"model": {"provider": "openai", "model": "<that id>", ...}`.
- **Follow-up.** Then send
  `Give scout a follow-up task: reply with exactly: found again. Wait for it, then tell me what it said.`:
  `▸ followup_task`, the card's last message `found again`, and the same
  subagent conversation, no new one.
- **Message and list.** Then send
  `Send scout the message "stay put", then list your agents and tell me each one's status.`:
  `▸ send_message`, `▸ list_agents` with `/root/scout` in its result, and a
  `user` entry `stay put` in the subagent's conversation with
  `"mail": {"kind": "message", ...}`.

Claude, in a run made with `drive.ts r up --real-claude`:

- **Spawn and answer.** `drive.ts r tui start --provider claude`, send
  `Use the Task tool to start a general-purpose subagent that replies with exactly: found it. Then tell me what it said.`:
  `▸ Agent`, a `⧉ ... done` card, and `conversation/list` holds the subagent.
- **A subagent asks.** Send
  `Use the Task tool to start a general-purpose subagent that runs exactly: touch /tmp/nisse-verify/r/sub-made with the Bash tool. Then reply with one word: done`,
  wait for `waiting on you`: the card shows `allow Bash(touch /tmp/nisse-verify/r/sub-made)?`.
  Press `C-y` and wait for `READY`: the card reads `done`, and
  `/tmp/nisse-verify/r/sub-made` exists.
