# Reset and handoff

A reset starts over with an empty context in the same conversation, history kept, optionally carrying a brief.

## Sub-features

- `reset-context` [kernel] `reset()` (R593-604): Start over with an empty context in the same conversation, history kept
- `reset-rpc` [pending surface-conversations] The client path for `reset()` (R593-604): Start over with an empty context in the same conversation, history kept
- `reset-handoff` [kernel] Handoff text on reset (R593-604): Carry a short brief into the fresh context
- `reset-at-boundary` [kernel, pending harness-run-core] Reset while busy applies at a boundary (§6): A reset from one client does not cut another's tool call in half

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `reset-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area D: spec §6; README Reset and Handoff; example 25-coding-agent.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
