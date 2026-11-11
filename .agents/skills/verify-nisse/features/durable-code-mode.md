# Durable code mode

The model composes tool calls in a deterministic script that survives a server restart. This file is the durable behavior; [Code mode](./code-mode.md) is the host-based path that ships today.

## Sub-features

- `codemode-tool` [kernel] One `codemode` tool taking a script (§7.6, R355-368): The model composes many tool calls in one step
- `codemode-sandbox` [kernel] Deterministic QuickJS sandbox (§7.6, pi-codemode): A script behaves the same when replayed
- `codemode-replay` [kernel] Journal and replay after a restart (§7.6): A script survives a server restart
- `codemode-divergence` [kernel] Divergence detection (§7.6): Replay that takes another path stops with a clear error
- `codemode-nested-policy` [kernel] Nested calls pass hooks and approvals (§7.6): A script cannot skip policy
- `codemode-namespaces` [kernel] Tools as namespaces in the script (§7.6): Scripts read clearly with many tools
- `codemode-discovery` [kernel] `searchTools`, `describeTool`, `describeNamespace`, `ALL_TOOLS` (§7.6): A script discovers tools at runtime
- `codemode-description` [kernel] Tool description section with a 3000-token budget (§7.6): Many tools fit the prompt, and overflow says so
- `codemode-store` [kernel] `store` values per conversation (§7.6): Scripts keep state between runs, forked with the conversation
- `codemode-result` [kernel] Result format and `max_output_tokens` (§7.6): The script controls how much comes back
- `codemode-images` [kernel] Images in script results (§7.6): Scripts can show pictures
- `codemode-models-catalog` [kernel] `models.*` catalog (§7.6, codemode/models.ts): A script sees which models are available
- `codemode-classify` [kernel] `models.classify` (§7.6): A script gets cheap structured judgments from a classifier model
- `codemode-generate-images` [kernel] `models.generateImages` (§7.6): A script makes images
- `codemode-grammar` [kernel] Lark grammar for constrained sampling (§7.6): The model produces valid scripts
- `codemode-temp-files` [kernel] Temporary files for large outputs (§7.6): Large script results are reachable
- `codemode-details` [kernel] `CodemodeToolDetails` for UIs (§7.6): Clients draw a script's calls as a list
- `codemode-documents` [kernel] Documents `pi.codemode.run`, `journal`, `store` (§7.6): The durable records behind M3 and M9
- `codemode-imports` [kernel] The extension loads without the WASM runtime.
- `codemode-stop` [kernel] A stopped run ends its script at once, even one stuck in a long built-in (F19): The server never waits on a script to stop

## How to get to it

### People

None until the TUI runs on the kernel.

### Agents

- On a kernel server (`NISSE_KERNEL=1`), start a conversation on a model that
  takes only code mode: `conversation/start` with `"model": "script-code-mode"`
  on the script provider, or `"provider": "openai"` and a model ChatGPT's
  catalog marks `"tool_mode":"code_mode_only"`, such as `gpt-6.1-sol`. That
  model is offered `codemode` alone; every other model is offered nisse's
  tools and not `codemode`.
- `conversation/interrupt` and `server/stop` stop a running script.

## Driving it with drive.ts

Preconditions: a fresh run for each group, `drive.ts r down` after.

- **A script's calls ask.** Write a script step file such as
  `[{"tool":{"name":"codemode","input":{"code":"text(await tools.bash({ command: \"echo hi\" }))\ntext(JSON.stringify((await searchTools(\"shell\")).map(t => t.name)))"}}},{"text":"done"}]`,
  then `drive.ts r up --kernel --script <file>`, `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"cwd":"/tmp/nisse-verify/r","model":"script-code-mode"}'`
  and `drive.ts r watch <id> --submit 'go' --save ask` (it returns once the run waits):
  `nisse.approvals` holds a request for `bash` whose `callId` is
  `<codemode call>/c1`. `drive.ts r rpc approval/resolve '{"conversation":"<id>","approval":"<request>","author":"ada","allow":true}'`,
  then `drive.ts r watch <id> --save done`: a `pi.tool-result` for
  `codemode` reading `Script completed`, the command's output and `["bash"]`,
  then `done` and `run_end` `answered`.
- **ChatGPT.** `drive.ts r up --kernel --fake-openai codemode_script`,
  `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"cwd":"/tmp/nisse-verify/r","provider":"openai","model":"gpt-6.1-sol","approvals":"auto"}'`,
  `drive.ts r watch <id> --submit 'compute 2 + 2' --until run_end --save chatgpt`:
  the script `text(2 + 2);` and its result `Script completed`, `4`.
  `evidence/fake-openai.ndjson` shows each request offering one tool, the
  custom `codemode` with a Lark grammar.

## Sources

Feature ledger area M: spec §7.6; README Code Mode.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
