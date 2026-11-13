# Tools

Tools return separate channels for the model, programs and clients, are bounded and replay-safe, and can call each other under the same hooks.

## Sub-features

- `tool-output-channel` [kernel] Result channel `output` for the model, with text and images (R279): Model gets prepared content
- `tool-structured-output` [kernel] Result channel `structuredOutput` for programs (R279): Scripts and other tools get typed values, not parsed text
- `tool-details` [kernel] Result channel `details` for UIs (R279, §7.3): A client draws a diff or a table without the model paying for it
- `tool-diagnostics` [kernel] Diagnostics, delivered in a `<harness>` block (§7.3): Model learns output was cut or an image dropped, without polluting results
- `tool-usage` [kernel] Usage on a tool result (§7.3, §8.6): A tool that calls a model has its cost counted
- `tool-terminate` [kernel] `control.terminate` (§7.3): A tool ends the run with no further model call
- `tool-add-tools` [kernel] `control.addTools` (§7.3): A tool makes more tools available at the next step
- `tool-handoff` [kernel] `control.handoff` (§7.3): A tool resets context and carries a brief
- `tool-replay-policy` [kernel] Replay policy safe or unsafe (§7.3, §8.4): Read-only calls rerun after a crash; the rest are marked interrupted
- `tool-prepare-arguments` [kernel] `prepareArguments` (§7.3): Normalize odd model arguments before validation and hooks
- `tool-output-schema` [kernel] `structuredOutputSchema` validation (R279, §7.3): Programs can trust a declared shape
- `tool-callers` [kernel] `callers`: who may call a tool (R333-349): A tool can be reachable only from scripts or only from the model
- `tool-model-tools` [kernel] `modelTools`: offered versus callable (R333-349): Trim the prompt without removing a capability
- `tool-deferred-search` [kernel] Deferred tools and `tool_search` with BM25 (R333-349, `tool-search`): Hundreds of tools without a huge prompt; loaded tools stay offered after compaction
- `tool-parallel` [kernel] Parallel tool rounds (§8.5): Several read-only calls finish faster
- `tool-execution-mode` [kernel] `executionMode` per tool (§7.3): A tool forces its call to run alone
- `tool-output-limits` [kernel] Output limits per tool, default 50 KiB, 2000 lines, head or tail (§7.3): No tool can flood the context, and extension tools get it free
- `tool-sanitize` [kernel] Output sanitizing (§7.3): Control characters and bad bytes never reach the model or terminal
- `tool-truncated-file` [kernel] Truncated output saved to a file (§7.3): The model can still read what was cut
- `tool-output-throttle` [kernel] Adaptive throttle on running output (§7.3): A chatty command doesn't overload storage
- `tool-output-window` [kernel] `outputWindow`, `skipped` count (§7.3, §8.2): Live view shows head, tail and how much was skipped
- `tool-unavailable` [kernel] `tool_unavailable` when a call names a tool not offered (§7.3): A model can't call something withheld
- `tool-retained-output` [kernel] `retainedOutput` kept across a crash (§7.3): Output so far survives
- `tool-api-env` [kernel] `api.env` in the tool API (§7.3): Tools work on whichever environment the conversation uses
- `tool-api-commit` [kernel] `api.commit` and `api.memo` in tools (§7.3): A tool stores progress atomically and doesn't repeat steps after a crash
- `tool-api-create` [kernel] `api.createTask`, `api.conversation` (§7.3, R772-797): A tool starts durable work or a conversation
- `tool-execute-tool` [kernel] `executeTool`: tools calling tools (R307-331): Compose tools with the same hooks and approvals
- `tool-nested-live` [kernel] Live view of nested calls, `nestedTools` (§7.3, §8.2): People see what a script or tool is doing inside
- `tool-nested-key` [kernel] Nested call key and reattach, `NestedCallDoc` (§7.3): A restarted tool finds its running nested call and does not start a new one
- `tool-abandon-on-restart` [kernel] `abandonOnRestart` (R351-353, §5.4): A long-lived server-type tool is dropped on restart, not rerun
- `tool-file-queue` [kernel] Per-file mutation queue (§7.3, `file-mutation-queue`): Two parallel edits to a file don't overwrite each other
- `tool-edit` [kernel] Edit details: fuzzy matching, line endings, a diff (`edit-diff`): Fewer failed edits and a diff to show
- `tool-read` [kernel] `read` with text and images (R245-305): Reads handle pictures
- `tool-write` [kernel] `write` (R245-305): Create or replace a file
- `tool-bash` [kernel] `bash` with streaming and timeouts (R245-305): Run commands
- `tool-bash-prefix` [kernel] `commandPrefix` and `prepare` on `bash` (`tools/bash.ts`): Set up shells or wrap commands per deployment
- `tool-argument-validation` [kernel] Argument coercion and validation (R245-305): A bad call returns a readable error
- `tool-crash-result` [kernel] A tool crash becomes an error result (§7.3): One broken tool doesn't kill the run
- `tool-search-ranking` [kernel] BM25 ranking and tokenizing order what `tool_search` finds.
- `tool-image-preparation` [kernel] Reading images resizes them, honours EXIF orientation and re-reads a file that changed.
- `tool-args-typebox` [kernel] Tool arguments declared with a TypeBox schema are validated the same way as JSON Schema.
- `tool-powershell` [kernel] `powershell` runs on Windows hosts.
- `tool-streamed-output` [kernel] `api.output()` streams from a custom tool and becomes the result when `execute()` returns no output.
- `tool-grep` [kernel] `grep` searches file contents with a regular expression through the conversation's environment, skipping binary and git-ignored files.
- `tool-glob` [kernel] `glob` lists files matching a glob, newest first, through the conversation's environment.
- `tool-apply-patch` [kernel] `apply_patch` adds, updates, moves and deletes files from one patch in the Codex format, under the per-file mutation queue.
- `tool-root-env-kernel` [kernel] `bash` with `rootConversationEnv` sets `SIGMA_ROOT_CONVERSATION` to the conversation people started, also in a conversation a task owns.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area L: spec §5.4, §7.3, §8.2, §8.4, §8.5; README Tools, Calling tools from tools, Who may call a tool, Tasks a restart abandons; examples 16-coding-tools, 25-coding-agent, 29-tool-override.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
