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
- `subagent-card` shows the card's state: `working`, `waiting on you` with the
  asked call and `allow <Tool(subject)>?  ^Y  allow  ^N  deny`, `done` with its
  last message, `interrupted` or `failed`.
- `subagent-approve` answers a subagent's asked call with `^Y` or `^N` in the
  parent's TUI, or `approval/resolve` on the subagent's conversation. A call
  asked deeper in the tree shows on the card of the subagent above it.
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
  its own: the parent shows `▸ Agent(...)` and a `⧉ <description>` card, the
  subagent's conversation holds its prompt, calls, results and last message,
  and its `lineage` has no `task`. Its calls wait on a person there and on its
  card. Input to it is refused with `TakesNoInput`, and its TUI prompt reads
  `INPUT GOES THROUGH ITS PARENT`. `Esc` there stops only it; stopping the
  parent ends it `interrupted`, and so does a server crash.

## How to get to it

### People

- Ask an OpenAI conversation for work it hands to subagents, in the TUI.
- Open a subagent with `nisse --conversation <id>`.

### Agents

- Run `nisse exec --provider openai` with such a prompt.
- Drive it without a model through `NISSE_MODEL_SCRIPT`: a step with `"agent": "/root/<name>"` is played by that subagent, the others by the parent.
- Read the tree with `conversation/list` (`lineage`).

## Driving it with drive.ts

Preconditions:

- A fresh run with a script. Real OpenAI subagents need a ChatGPT sign-in, as
  [OpenAI](./openai.md) says; without one they are not verified.

- **Spawn, approve, answer.** Write this script and run
  `drive.ts r up --script <file>`:

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
  `"lineage": {"parent": <the TUI's conversation>, "task": "/root/scribe", "title": "scribe", ...}`.

- **Interrupt.** With the script

  ```json
  [
    { "tool": { "name": "spawn_agent", "input": { "task_name": "slowpoke", "message": "count slowly" } } },
    { "tool": { "name": "wait_agent", "input": { "timeout_ms": 600000 } } },
    { "agent": "/root/slowpoke", "text": "one two three four five six seven eight nine ten", "delayMs": 1500 }
  ]
  ```

  type `count`, `Enter`, wait for `slowpoke`, press `Escape` and wait for
  `READY`: the card reads `⧉ slowpoke interrupted`, `▸ wait_agent` shows
  `interrupted; it may or may not have taken effect`, then `◆ interrupted`.

- **Limits, follow-ups, idle parents.** These are wire promises covered by
  `bun test` in `wire.test.ts`; drive them with `rpc` and `watch` when a change
  touches them.

- **Claude subagents.** Without a Claude sign-in, drive the recorded fake
  Claude Code the tests use: start the run's server with
  `NISSE_CLAUDE=$PWD/packages/nisse/test/support/fake-claude`,
  `FAKE_CLAUDE_FIXTURE=$PWD/fixtures/claude/subagent_asks.ndjson` and
  `FAKE_CLAUDE_DIR=/tmp/nisse-verify/r/fake-claude` on `drive.ts r serve`.
  `drive.ts r tui start --provider claude`, type `go`, `Enter`, and wait for
  `waiting on you`: the card reads `⧉ Find gnome location in notes waiting on
you` with `allow Bash(touch made.txt)?`. Press `C-y` and wait for `READY`:
  the card reads `done`. `drive.ts r tui start --conversation <subagent id>`
  shows its transcript and a prompt titled `INPUT GOES THROUGH ITS PARENT`.
  With a sign-in, ask Claude to use the Task tool for the same journey.

## Contexts

- **Provider.** Claude keeps Claude Code's own subagents, which take input only through their parent. OpenAI uses Codex's agent tools.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- interrupting a conversation stops the runs of its subagents too
- a person interrupting a subagent wakes its parent's wait, which hears who stopped it
- a subagent's answer lands in its idle parent's transcript without starting a run
- a follow-up task wakes an idle subagent, and each of its answers reaches the waiting parent
- a tree runs at most as many subagents at once as config.toml allows
- a follow-up task does not wake an idle subagent while the tree runs as many as config.toml allows
- a subagent waiting on a person shows as its whole tree waiting, to watchers then and later
- commands a conversation runs, its subagents' included, know the conversation people started
- a conversation keeps the instructions it started with, and its subagents start without them

Screen, `packages/nisse/test/screen.test.ts`:

- a subagent shows as a card under its parent, and ctrl+y answers the call it asks about
- a call a subagent's subagent asks about shows on the card above it, and ctrl+y answers it
- a Claude subagent shows as a card in place of its call's result, and its own screen sends input to its parent

Stack, `packages/nisse/test/stack.test.ts`:

- nisse exec without --auto denies the calls its subagents would ask about too

Provider, `packages/nisse/test/openai.test.ts`:

- a spawned agent starts from its parent's history, and its last answer reaches the parent
- an agent of a type gets its instructions, and fork_turns none leaves the parent's history out

Provider, `packages/nisse/test/claude.test.ts`:

- a Claude subagent works in a conversation of its own under the one that started it
- a Claude subagent takes input only through its parent
- a Claude subagent leaves the model a new conversation starts with as the person last chose it
- a call a Claude subagent wants to make waits for a person in the subagent's conversation
- stopping a Claude subagent stops only it, and its parent's run carries on
- stopping a run ends the Claude subagents working under it

## Gotchas

- Steps play in order per author: the parent's steps and each
  `/root/<name>`'s steps are separate queues in the one script.
- A subagent's run is its own: wait for its end with `watch` on its
  conversation, not the parent's.
