# Task kernel

Durable work is a task with phases and checkpoints, scheduled across restarts,
waiting on other tasks, sleeping, and ending with a stored outcome. `/tasks` in
the TUI opens a live `TASKS` panel of the work running now in every
conversation, one line per task with its id, kind, conversation, status and
phase, and `nothing is running` once it is done. `tasks/watch` streams the same
graph to a client.

## Sub-features

- `task-definition` [kernel] Task definitions and registry (§5, R772-814): Name a durable unit of work
- `task-phases` [kernel] Phases (§5): Work is broken into resumable steps
- `task-checkpoint` [kernel] Checkpoints (§5): Restart continues from the last checkpoint
- `task-memo` [kernel] Memos (§5.1): A side effect runs once, and its result is reused on replay
- `task-effect-sandwich` [kernel] Effect sandwich: intent, effect, record (§5.2): Every side effect has a crash story
- `task-terminal` [kernel] Terminal outcomes and results (§5.3): Waiters get a stored result
- `task-scheduler` [kernel] Scheduler (§5.4, 3,164 lines upstream): Many tasks progress concurrently and restart correctly
- `task-wait` [kernel] Waiting on another task (§5.5): A task pauses for a result, across restarts
- `task-sleep` [kernel] Durable `sleep` (R140-212, §5.6): Wait an hour or a day and survive restarts
- `task-wake` [kernel] Durable timers and `wake` (§5.6): Work resumes at a time or on a signal
- `task-completing` [kernel] Completing state (§5.5): A parent's finishing work runs after its children end
- `task-fail-fast` [kernel] `failFast` and `allSettled` (§5.5): Choose how a group of children fails
- `task-cycle-check` [kernel] Cycle check (§5.5): Tasks waiting on each other fail clearly
- `task-abort-bottom-up` [kernel] Abort bottom-up (§5.5): Children stop before their parent
- `task-orphaned` [kernel] Orphaned tasks (§5.4): Work whose definition is gone is marked and kept
- `task-blocked` [kernel] Blocked tasks and reports (R214-222, §5.4): A broken extension's work waits to be fixed, and people are told
- `task-migration` [kernel] Task migrations (§5.4): Running tasks survive a new version
- `task-handover` [kernel] Task handover (§5.4): One task passes its work to another without a gap
- `task-restart-count` [kernel] Restarts counted per task (§5.4): One bad task stops, others go on
- `task-inspect` [kernel] `inspect` (§2.2): See what is running and why
- `task-abort` [kernel] `abortTask` (§5.4): Stop one piece of work
- `task-wait-for` [kernel] `waitForTask` (§5.4): Wait for a result
- `task-wait-for-idle` [kernel] `waitForIdle` (§5.4): Hosts and tests wait for quiet on a real signal
- `task-owned` [kernel] `ownedTasks` (§5.4): See a conversation's work
- `task-lifecycle-times` [kernel] Lifecycle times and outcomes stored (§5.3): Timing and history of work
- `task-extension-defined` [kernel] Extension-defined tasks (§7.1, R772-797): An add-on runs durable work of its own
- `task-after-run` [kernel] After-run tasks (R659-714): Durable work starts when a run ends
- `task-children-from-tools` [kernel] Child tasks from tools (R772-797): A tool fans out durable work
- `task-builtin` [kernel] Built-in tasks `pi.generation`, `pi.tool`, `pi.compaction` (§8.3, §8.4, §8.7): The agent loop is observable and restartable by the same rules
- `task-graph` [kernel] Task graph view (R799-814, §9.4): See and draw all work and its dependencies
- `task-graph-rpc` The client path for Task graph view (R799-814, §9.4): See and draw all work and its dependencies
- `task-tool-rounds` [kernel] Tool rounds as tasks (§8.5): A round finishes or restarts as a unit
- `task-scheduling-ownership` [kernel] Scheduling ownership on one process (§5.4): Restart picks up exactly the unfinished work
- `task-memory-bounded` [kernel] The scheduler's memory and the cost of each task follow the work alive, not how deep its ownership chain runs, and work that ended leaves nothing behind.
- `task-id-order` [kernel] Live and ended tasks are listed in a stable order through ids that always increase.

## How to get to it

### People

- Type `/tasks` in the TUI's prompt and press `⏎`; `esc` closes the panel.

### Agents

- Call `tasks/watch`, a stream: first the graph of the home's live tasks, then each commit's changes to it.

## Driving it with drive.ts

Preconditions:

- A fresh run whose script is
  `[{"tool": {"name": "bash", "input": {"command": "echo hi"}}}, {"text": "all done"}]`,
  `drive.ts r up --script s.json`, then
  `drive.ts r tui start --conversation talk` and `drive.ts r tui wait READY`.

- **Nothing running.** Type `/tasks` and `Enter`,
  `drive.ts r tui wait 'nothing is running'`: the `TASKS   esc  close` panel
  over `nothing is running`. `drive.ts r rpc tasks/watch` prints the stream's
  first chunk, `{"_tag": "graph", "graph": {"tasks": {}}}`. Press `Escape`.
- **Work waiting on a person.** Type `check` and `Enter`,
  `drive.ts r tui wait 'allow this call?'`, then `/tasks` and `Enter`,
  `drive.ts r tui wait pi.tool`: two lines such as
  `14  pi.generation  conversation 4  waiting · tools` and
  `17  pi.tool  conversation 4  running · call`. `drive.ts r rpc tasks/watch`
  answers both, the generation's `state`
  `{"status": "waiting", "phase": "tools", "on": [<the tool's id>], ...}`.
- **It empties live.** With the panel open, press `drive.ts r tui key C-y`
  and `drive.ts r tui wait 'nothing is running'`: the panel followed the work
  to its end without being reopened. `Escape` shows the call
  `✓ allowed by ada`, `hi` and `all done`; `rpc tasks/watch` answers an empty
  graph again.

## Sources

Feature ledger area R: spec §2.2, §5, §7.1, §8.3, §8.4, §8.5, §8.7, §9.4; README Sleeping and Waking Up, Failures and Recovery, Work at the end of a run, Child Tasks, Task Graph; examples 11-tasks, 12-recovery, 23-child-tasks.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- task-graph-rpc: a client watches the home's live work, a run and the call it waits on, until it is done

Screen, `packages/nisse/test/screen.test.ts`:

- task-graph-rpc: /tasks lists the work running now, and it empties once the work is done

Package, `packages/harness/test/harness.test.ts`:

- task-memory-bounded: long chains of ended tasks leave the scheduler and the document cache as they were

Package, `packages/kernel/test/tasks.test.ts`:

- task-terminal: a task runs phase by phase to its outcome, and waitForTask gets the stored receipt
- task-terminal: a phase that fails, throws, or returns without durable progress ends its task faulted and reported
- task-wait-for: waitForTask answers a terminal task at once, and a wait still open when the Session closes fails with SessionClosed
- task-wait-for: a wait interrupted while the scheduler reads for it keeps no waiter behind
- session-clock, task-lifecycle-times: a TestClock drives a durable sleep, and the receipt stores when the task started and ended
- task-children-from-tools, task-id-order: a tool fans out child tasks whose ids increase, listed in id order, and the parent collects their outcomes
- task-extension-defined: a task whose definition is not registered waits blocked, and runs once an extension registers it
- task-terminal: an abort joins the phase's Promise work before the abort handler starts, and close joins the abort handler's before storage closes
- task-terminal: a task whose process is killed mid-phase resumes from its checkpoint in a new process, with the restart counted even after a read-only scheduler opened and closed it
- task-terminal: a close while an aborted owner waits for its child's abort handler leaves both resumable, with no restart counted
- task-memory-bounded: an ownership chain a thousand tasks deep costs the scheduler one index entry per task, and nothing once it ends

## Gotchas

- `drive.ts r rpc tasks/watch` prints only the stream's first chunk, the graph
  as it is now; call it again to see it later. The TUI panel is the live view.
- The panel names conversations by number (`conversation 4`), even one opened
  as `talk`.
- The panel covers the transcript and the `allow this call?` line, but `^Y`
  and `^N` still answer the call.
