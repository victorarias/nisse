# Context the model sees

What the model sees is derived from the recorded entries by written rules, so it can be worked out exactly and edited without touching history.

## Sub-features

- `context-derived` [kernel] Context derived from entries by written rules (§2.1, rules 1-10): What the model saw can be worked out exactly from the record
- `context-omit` [kernel] Context edit: omit an entry (§2.1): Hide a large or wrong entry from the model while it stays in the transcript
- `context-replace` [kernel] Context edit: replace an entry (§2.1): Swap in a shortened version for the model
- `context-head` [kernel] Head markers (§2.1): Context starts at a chosen point after reset or compaction, and history stays readable
- `context-synthesized-results` [kernel] Synthesize missing tool results (§2.1): A crash never leaves the provider an unanswered call
- `context-at-entry` [kernel] `Conversation.context(at)` (§2.2): Inspect the exact context at any entry
- `context-rpc` [pending wire-complete] The client path for `Conversation.context(at)` (§2.2): Inspect the exact context at any entry
- `entries-paged` [kernel] Entries read with paging (§2.2): Read part of a long transcript
- `entries-rpc` [pending wire-complete] The client path for Entries read with paging (§2.2): Read part of a long transcript
- `context-stale-head` [kernel] Stale head check (§6): An input aimed at a context that has moved is settled, not misapplied

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `context-rpc` lands with `wire-complete`, which adds its entry point and recipe.
- Not reachable yet: `entries-rpc` lands with `wire-complete`, which adds its entry point and recipe.

## Sources

Feature ledger area B: spec §2.1, §2.2, §6; examples 08-context, 13-chat, 20-late-join.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
