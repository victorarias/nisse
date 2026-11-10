# Usage and cost

Tokens and cost are counted per conversation, model and tool, and totalled for the home.

## Sub-features

- `usage-conversation` [kernel, pending harness-run-core] `pi.usage` per conversation (§8.6, R855-861): See tokens used by a conversation
- `usage-rpc` [pending surface-conversations] The client path for `pi.usage` per conversation (§8.6, R855-861): See tokens used by a conversation
- `usage-per-model` [kernel, pending harness-run-core] Per-model breakdown (§8.6): Know which model spent what
- `usage-per-tool` [kernel, pending harness-run-core] Per-tool usage (§8.6): Attribute spend to a tool
- `usage-total` [kernel, pending harness-run-core] `Harness.usage` totals (R855-861): One number across the home
- `usage-cost` [kernel, pending harness-run-core] Cost in currency (§8.6): See money spent
- `usage-context-live` [kernel] Context used, for live display (§8.2): People see how full the context is
- `usage-spending-limit` [kernel, pending harness-run-core] Spending limit: Stop at a budget

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `usage-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area U: spec §8.2, §8.6; README Usage and Cost.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
