# Durable code mode

The model composes tool calls in a deterministic script that survives a server restart. This file is the durable behavior; [Code mode](./code-mode.md) is the host-based path that ships today.

## Sub-features

- `codemode-tool` [kernel, pending codemode-package] One `codemode` tool taking a script (§7.6, R355-368): The model composes many tool calls in one step
- `codemode-sandbox` [kernel, pending codemode-package] Deterministic QuickJS sandbox (§7.6, pi-codemode): A script behaves the same when replayed
- `codemode-replay` [kernel, pending codemode-package] Journal and replay after a restart (§7.6): A script survives a server restart
- `codemode-divergence` [kernel, pending codemode-package] Divergence detection (§7.6): Replay that takes another path stops with a clear error
- `codemode-nested-policy` [kernel, pending codemode-package] Nested calls pass hooks and approvals (§7.6): A script cannot skip policy
- `codemode-namespaces` [kernel, pending codemode-package] Tools as namespaces in the script (§7.6): Scripts read clearly with many tools
- `codemode-discovery` [kernel, pending codemode-package] `searchTools`, `describeTool`, `describeNamespace`, `ALL_TOOLS` (§7.6): A script discovers tools at runtime
- `codemode-description` [kernel, pending codemode-package] Tool description section with a 3000-token budget (§7.6): Many tools fit the prompt, and overflow says so
- `codemode-store` [kernel, pending codemode-package] `store` values per conversation (§7.6): Scripts keep state between runs, forked with the conversation
- `codemode-result` [kernel, pending codemode-package] Result format and `max_output_tokens` (§7.6): The script controls how much comes back
- `codemode-images` [kernel, pending codemode-package] Images in script results (§7.6): Scripts can show pictures
- `codemode-models-catalog` [kernel, pending codemode-package] `models.*` catalog (§7.6, codemode/models.ts): A script sees which models are available
- `codemode-classify` [kernel, pending codemode-package] `models.classify` (§7.6): A script gets cheap structured judgments from a classifier model
- `codemode-generate-images` [kernel, pending codemode-package] `models.generateImages` (§7.6): A script makes images
- `codemode-grammar` [kernel, pending codemode-package] Lark grammar for constrained sampling (§7.6): The model produces valid scripts
- `codemode-temp-files` [kernel, pending codemode-package] Temporary files for large outputs (§7.6): Large script results are reachable
- `codemode-details` [kernel, pending codemode-package] `CodemodeToolDetails` for UIs (§7.6): Clients draw a script's calls as a list
- `codemode-documents` [kernel, pending codemode-package] Documents `pi.codemode.run`, `journal`, `store` (§7.6): The durable records behind M3 and M9
- `codemode-imports` [kernel] The extension loads without the WASM runtime.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area M: spec §7.6; README Code Mode.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
