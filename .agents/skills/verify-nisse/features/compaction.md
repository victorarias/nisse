# Compaction

Long conversations keep working: older context becomes a summary, automatically or on demand, and the raw history stays.

## Sub-features

- `compaction-manual` [kernel, pending harness-compaction] Manual compact (R606-657, §8.7): Shrink context on demand
- `compact-rpc` [pending surface-conversations] The client path for Manual compact (R606-657, §8.7): Shrink context on demand
- `compaction-blocking` [kernel, pending harness-compaction] Automatic compaction at a threshold, blocking the next request (§8.7): A long conversation keeps working
- `compaction-background` [kernel, pending harness-compaction] Background compaction (§8.7, default 32768 tokens): The summary is ready before it is needed, so no pause
- `compaction-overflow` [kernel, pending harness-compaction] Overflow retry: compact on a context-limit error and retry (§8.3, §8.7): A surprise overflow does not fail the run
- `compaction-policy` [kernel, pending harness-compaction] Policy settings: reserve 16384, keepRecent 20000 (§8.7): Tune when and how much to compact
- `compaction-per-model` [kernel, pending harness-compaction] Per-model overrides (R606-657): Different models get different policies
- `compaction-per-conversation` [kernel, pending harness-compaction] Per-conversation compaction settings, inherited by children and forks (Unreleased): One conversation turns compaction off or tunes it
- `compaction-range` [kernel, pending harness-compaction] Range selection that never splits a tool round (§8.7): The summary never orphans a call from its result
- `compaction-summary-prompt` [kernel, pending harness-compaction] Summary prompts and summary model (§8.7): Control what a summary keeps and what it costs
- `compaction-recorded` [kernel, pending harness-compaction] Compaction recorded in the transcript with placement (§8.1, §8.7): People see where and why context was compacted
- `compaction-hook` [kernel, pending harness-compaction] `beforeCompact` hook (§7.2): An extension cancels or customizes a compaction
- `compaction-usage` [kernel, pending harness-compaction] Compaction usage is counted (§8.6, §8.7): Totals include what summaries cost
- `compaction-stale` [kernel, pending harness-compaction] Stale ordering: late background results are discarded or placed correctly (§8.7): A slow summary cannot rewrite newer context
- `compaction-live-status` [kernel, pending harness-compaction] Live compaction status and last failure (§8.2): People see "compacting" and why one failed
- `compaction-abort` [kernel, pending harness-compaction] Cancelling a compaction without losing the run (§8.7): Esc during a summary behaves predictably
- `compaction-blocking-failure` [kernel, pending harness-compaction] A failed blocking compaction fails the generation without a request; a declined or empty one lets the request go ahead.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `compact-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area E: spec §8.1, §8.2, §8.7, §7.2; README Compaction; example 24-compaction.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
