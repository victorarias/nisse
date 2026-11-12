# Conversations and forks

A conversation is created with its settings, listed, reopened, owned by a task or another conversation, and forked at any entry.

## Sub-features

- `conversation-options` [kernel] Create a conversation with options (§2.2): Start with model, instructions, tools, extensions and limits
- `conversation-owner` [kernel] Ownership kinds (§2, §3): A conversation is owned by a task or another conversation, and goes away with it
- `fork-at-entry` [kernel] Fork at any entry (R716-723, §3.7): Try another direction from an earlier point
- `fork-rpc` [pending surface-conversations] The client path for Fork at any entry (R716-723, §3.7): Try another direction from an earlier point
- `fork-document-policy` [kernel] Fork document policies: asOf, current, initial (§3.7): Each kind of state chooses what a fork inherits
- `fork-provider-identity` [kernel] Each fork has its own provider session identity (§3.7, R716): Forks don't collide in provider session or cache
- `conversation-list` [kernel] Conversation list (§2.2): Find conversations
- `conversation-reopen` [kernel] Reopen by id and continue (§2.2): Come back to a conversation
- `conversation-init` [kernel] `init` on create, fork and root writes per-call data in the creating commit.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `fork-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area C: spec §2, §2.2, §3.7; README More Conversations and Forks; examples 02-forks, 03-owned-conversations, 07-harness-conversations.

## Tests

Package, `packages/harness/test/harness.test.ts`:

- fork-provider-identity: the root and each of its forks have their own provider session id
- conversation-list, conversation-reopen: conversations are found again after a restart, with their agent and history
- reset-context, reset-handoff, fork-at-entry: a fork that resets starts a new context with its handoff, and the original and the fork's earlier entries keep theirs

## Gotchas

None recorded yet.
