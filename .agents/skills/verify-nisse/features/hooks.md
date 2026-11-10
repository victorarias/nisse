# Hooks

Hooks let an extension shape requests, react to responses and tools, keep a run going, and start work at the end of a run, safely across restarts.

## Sub-features

- `hook-before-request` [kernel] `beforeRequest` (§7.2): Shape context, instructions and tools before each model call
- `hook-before-provider-request` [kernel] `beforeProviderRequest` (§7.2): Change the raw provider payload
- `hook-after-response` [kernel] `afterResponse` (§7.2): React to or revise a finished response
- `hook-on-yield` [kernel] `onYield` (§7.2): Keep the run going when the model wants to stop, for example for a checklist
- `hook-after-tools` [kernel] `afterTools` (§7.2): React after a whole tool round
- `hook-after-run` [kernel, pending harness-tools] `afterRun` (§7.2, R659-714): Start durable after-run work such as summarizing or notifying
- `hook-before-tool` [kernel] `beforeTool`: block or rewrite (§7.2): Enforce policy on every call
- `hook-after-tool` [kernel] `afterTool` (§7.2): Change or annotate results
- `hook-api` [kernel] Hook API: read state, write entries, memos (§7.2): A hook makes durable, replay-safe decisions
- `hook-replay` [kernel] Hooks replay safely after a crash through memos (§5, §7.2): A hook with a side effect doesn't run twice
- `hook-reads` [kernel] A hook reads raw history and single entries.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area K: spec §5, §7.2; README Hooks, Work at the end of a run; examples 26-plan-mode, 27-reviewer, 32-tests-after-edits.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
