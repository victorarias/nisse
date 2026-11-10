# Conversations and forks

A conversation is created with its settings, listed, reopened, owned by a task or another conversation, and forked at any entry.

## Sub-features

- `conversation-options` [kernel, pending harness-run-core] Create a conversation with options (§2.2): Start with model, instructions, tools, extensions and limits
- `conversation-owner` [kernel, pending harness-tools] Ownership kinds (§2, §3): A conversation is owned by a task or another conversation, and goes away with it
- `fork-at-entry` [kernel, pending harness-run-core] Fork at any entry (R716-723, §3.7): Try another direction from an earlier point
- `fork-rpc` [pending surface-conversations] The client path for Fork at any entry (R716-723, §3.7): Try another direction from an earlier point
- `fork-document-policy` [kernel] Fork document policies: asOf, current, initial (§3.7): Each kind of state chooses what a fork inherits
- `fork-provider-identity` [kernel, pending harness-shell] Each fork has its own provider session identity (§3.7, R716): Forks don't collide in provider session or cache
- `conversation-list` [kernel, pending harness-shell] Conversation list (§2.2): Find conversations
- `conversation-reopen` [kernel, pending harness-shell] Reopen by id and continue (§2.2): Come back to a conversation
- `conversation-init` [kernel, pending harness-run-core] `init` on create, fork and root writes per-call data in the creating commit.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `fork-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area C: spec §2, §2.2, §3.7; README More Conversations and Forks; examples 02-forks, 03-owned-conversations, 07-harness-conversations.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
