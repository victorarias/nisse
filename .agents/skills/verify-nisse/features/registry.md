# Extensions and registry

Extensions package tools, hooks, sections, tasks, entries and documents, install and reload at runtime, and are selected per conversation.

## Sub-features

- `extension-shape` [kernel] Extension shape with tools, hooks, sections, tasks, entries, documents (R224-243, §7.1): One unit packages everything an add-on needs
- `extension-install` [kernel] Registry install and uninstall at runtime (§7.1, example 37): Add or remove one extension while running
- `extension-replace` [kernel] Replace one extension in place (§7.1): Update without touching the others
- `extension-per-conversation` [kernel] Per-conversation extension selection (§7.1): A conversation chooses its add-ons
- `extension-reload` [kernel] Reload semantics: running work finishes on old code, boundaries switch (R465-475, §7.5): Reload never breaks a running call
- `extension-tool-override` [kernel] Same-name tool override (R245-305): Replace a built-in tool
- `extension-wrap-tool` [kernel] `wrapTool` (§7.1): Add behavior around any tool without replacing it
- `extension-tool-metadata` [kernel] Typed tool metadata in the registry (§7.1): Extensions read and filter on tool facts
- `extension-state` [kernel] Extension-owned durable state via documents (§3): An add-on remembers across restarts and forks
- `extension-conversation-access` [kernel, pending harness-run-core] Extension access to its conversation (§7.2, §7.3): An add-on reads entries, writes, submits
- `extension-stored-by-name` [kernel] Conversations store extension and tool names, so a selection survives uninstall and restart, stops applying while the code is absent, and binds to what is installed later.
- `registry-install-conflict` [kernel] Installing an extension whose task name is taken is refused.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area J: spec §3, §7.1, §7.2, §7.3, §7.5; README Extensions, Reload; examples 09-registry-reload, 10-extension-state, 37-harness-registry, 29-tool-override.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
