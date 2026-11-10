# System prompt and sections

Extensions contribute named prompt sections, and what the model was told is recorded in place so later changes keep the provider's cache.

## Sub-features

- `section-contributed` [kernel] Named sections contributed by extensions (R370-378, §7.1): An extension adds durable instructions
- `section-positional` [kernel] System prompt stored as positional `pi.system` entries (§7.4): Records what the model was told and when, and later changes land where they happen
- `section-deltas` [kernel] Deltas after a baseline keep the prompt cache intact (§7.4): Changing a section does not rebuild the whole cache
- `section-new-baseline` [kernel] New baseline after a head (§7.4): A summary starts with fresh instructions
- `section-order` [kernel] Section ordering rules (§7.4): Stable, predictable prompts across extensions
- `section-wrap` [kernel] `wrapSection` (§7.1): An extension edits another's section
- `section-base` [kernel] Harness base instructions (R370-378): The host sets the foundation prompt

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area I: spec §7.1, §7.4; README System Prompt; example 14-system-prompt.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
