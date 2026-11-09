# Task kernel

Durable work is a task with phases and checkpoints, scheduled across restarts, waiting on other tasks, sleeping, and ending with a stored outcome.

## Sub-features

- `task-definition` [kernel, pending harness-tools] Task definitions and registry (§5, R772-814): Name a durable unit of work
- `task-phases` [kernel, pending harness-run-core] Phases (§5): Work is broken into resumable steps
- `task-checkpoint` [kernel, pending harness-run-core] Checkpoints (§5): Restart continues from the last checkpoint
- `task-memo` [kernel, pending harness-tools] Memos (§5.1): A side effect runs once, and its result is reused on replay
- `task-effect-sandwich` [kernel, pending harness-run-core] Effect sandwich: intent, effect, record (§5.2): Every side effect has a crash story
- `task-terminal` [kernel, pending kernel-tasks] Terminal outcomes and results (§5.3): Waiters get a stored result
- `task-scheduler` [kernel, pending harness-run-core] Scheduler (§5.4, 3,164 lines upstream): Many tasks progress concurrently and restart correctly
- `task-wait` [kernel, pending harness-tools] Waiting on another task (§5.5): A task pauses for a result, across restarts
- `task-sleep` [kernel, pending harness-run-core] Durable `sleep` (R140-212, §5.6): Wait an hour or a day and survive restarts
- `task-wake` [kernel, pending harness-shell] Durable timers and `wake` (§5.6): Work resumes at a time or on a signal
- `task-completing` [kernel, pending harness-tools] Completing state (§5.5): A parent's finishing work runs after its children end
- `task-fail-fast` [kernel, pending harness-tools] `failFast` and `allSettled` (§5.5): Choose how a group of children fails
- `task-cycle-check` [kernel, pending harness-tools] Cycle check (§5.5): Tasks waiting on each other fail clearly
- `task-abort-bottom-up` [kernel, pending harness-tools] Abort bottom-up (§5.5): Children stop before their parent
- `task-orphaned` [kernel, pending harness-run-core] Orphaned tasks (§5.4): Work whose definition is gone is marked and kept
- `task-blocked` [kernel, pending harness-run-core] Blocked tasks and reports (R214-222, §5.4): A broken extension's work waits to be fixed, and people are told
- `task-migration` [kernel, pending harness-tools] Task migrations (§5.4): Running tasks survive a new version
- `task-handover` [kernel, pending harness-run-core] Task handover (§5.4): One task passes its work to another without a gap
- `task-restart-count` [kernel, pending harness-run-core] Restarts counted per task (§5.4): One bad task stops, others go on
- `task-inspect` [kernel, pending harness-run-core] `inspect` (§2.2): See what is running and why
- `task-abort` [kernel, pending harness-run-core] `abortTask` (§5.4): Stop one piece of work
- `task-wait-for` [kernel, pending kernel-tasks] `waitForTask` (§5.4): Wait for a result
- `task-wait-for-idle` [kernel, pending harness-run-core] `waitForIdle` (§5.4): Hosts and tests wait for quiet on a real signal
- `task-owned` [kernel, pending harness-run-core] `ownedTasks` (§5.4): See a conversation's work
- `task-lifecycle-times` [kernel, pending kernel-tasks] Lifecycle times and outcomes stored (§5.3): Timing and history of work
- `task-extension-defined` [kernel, pending kernel-tasks] Extension-defined tasks (§7.1, R772-797): An add-on runs durable work of its own
- `task-after-run` [kernel, pending kernel-tasks] After-run tasks (R659-714): Durable work starts when a run ends
- `task-children-from-tools` [kernel, pending kernel-tasks] Child tasks from tools (R772-797): A tool fans out durable work
- `task-builtin` [kernel, pending harness-run-core] Built-in tasks `pi.generation`, `pi.tool`, `pi.compaction` (§8.3, §8.4, §8.7): The agent loop is observable and restartable by the same rules
- `task-graph` [kernel, pending harness-views] Task graph view (R799-814, §9.4): See and draw all work and its dependencies
- `task-graph-rpc` [pending surface-conversations] The client path for Task graph view (R799-814, §9.4): See and draw all work and its dependencies
- `task-tool-rounds` [kernel, pending harness-tools] Tool rounds as tasks (§8.5): A round finishes or restarts as a unit
- `task-scheduling-ownership` [kernel, pending harness-tools] Scheduling ownership on one process (§5.4): Restart picks up exactly the unfinished work
- `task-id-order` [kernel, pending kernel-tasks] Live and ended tasks are listed in a stable order through ids that always increase.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `task-graph-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area R: spec §2.2, §5, §7.1, §8.3, §8.4, §8.5, §8.7, §9.4; README Sleeping and Waking Up, Failures and Recovery, Work at the end of a run, Child Tasks, Task Graph; examples 11-tasks, 12-recovery, 23-child-tasks.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
