# Subagents on the kernel

Delegated work runs in a child conversation owned by the task or conversation that started it, foreground or background. [Subagents](./subagents.md) is the path that ships today.

## Sub-features

- `child-conversation` [kernel] Child conversation under a parent (R725-770): Delegated work has its own transcript
- `child-foreground` [kernel] Foreground: the parent's turn waits on the child through a task (R725-770): A delegation behaves as one tool call, also across a restart
- `child-background` [kernel] Background: a reporter delivers the result (R725-770, §7.3): Work continues while the parent does other things
- `child-abort-cascade` [kernel] Abort cascades to children (R725-770, §5.5): Stop means everything stops
- `child-abort-background` [kernel] `abort({ background: true })` (R725-770): plain `abort()` leaves background work running, and `{ background: true }` aborts it too
- `child-tools` [kernel] Subagent tools for the model: spawn, send, follow up, wait, list, interrupt: The model manages helpers

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area Q: spec §5.5, §7.3; README Abort and Subagents; examples 21-subagent-foreground, 22-subagent-background.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

Kernel wire, `packages/nisse/test/kernel/wire.test.ts`, on a server under `NISSE_KERNEL=1`:

- child-tools: the model spawns a subagent, waits for it, and its final answer is mailed back
- child-tools: a subagent takes messages and follow-up tasks, and cannot start subagents past the depth limit
- child-tools: interrupting a subagent stops its turn and reports what it was doing

## Gotchas

None recorded yet.
