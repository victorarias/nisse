# Reset and handoff

A reset starts over with an empty context in the same conversation, history kept, optionally carrying a brief.

## Sub-features

- `reset-context` [kernel] `reset()` (R593-604): Start over with an empty context in the same conversation, history kept
- `reset-rpc` [pending surface-conversations] The client path for `reset()` (R593-604): Start over with an empty context in the same conversation, history kept
- `reset-handoff` [kernel] Handoff text on reset (R593-604): Carry a short brief into the fresh context
- `reset-at-boundary` [kernel] Reset while busy applies at a boundary (§6): A reset from one client does not cut another's tool call in half

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `reset-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area D: spec §6; README Reset and Handoff; example 25-coding-agent.

## Tests

Package, `packages/harness/test/harness.test.ts`:

- reset-context, reset-handoff, fork-at-entry: a fork that resets starts a new context with its handoff, and the original and the fork's earlier entries keep theirs

## Gotchas

None recorded yet.
