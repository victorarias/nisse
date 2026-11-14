# Code mode

The model composes tool calls in a deterministic script that survives a server restart. Models ChatGPT marks code-mode-only get one `codemode` tool whose scripts run in sigma's own QuickJS sandbox; each call a script makes is an ordinary sigma call that asks like a direct one.

## Sub-features

- `code-mode-models` puts the models ChatGPT marks code-mode-only in code
  mode: offered `codemode` alone. Every other model is offered sigma's tools
  and not `codemode`; in the list sigma ships, `gpt-5.5` keeps direct tools.
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

Start the TUI on a code-mode-only model, such as `sigma --provider openai --model gpt-6.1-sol`, and ask for something that takes tools: the TUI shows `▸ codemode` and the calls its script makes, asking before those that change things.

### Agents

- Start a conversation on a model that
  takes only code mode: `conversation/start` with `"model": "script-code-mode"`
  on the script provider, or `"provider": "openai"` and a model ChatGPT's
  catalog marks `"tool_mode":"code_mode_only"`, such as `gpt-6.1-sol`. That
  model is offered `codemode` alone; every other model is offered sigma's
  tools and not `codemode`.
- `conversation/interrupt` and `server/stop` stop a running script.

## Driving it with drive.ts

Preconditions: a fresh run for each group, `drive.ts r down` after.

- **A script's calls ask.** Write a script step file such as
  `[{"tool":{"name":"codemode","input":{"code":"text(await tools.bash({ command: \"echo hi\" }))\ntext(JSON.stringify((await searchTools(\"bash\")).map(t => t.name)))"}}},{"text":"done"}]`,
  then `drive.ts r up --script <file>`, `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd":"/tmp/sigma-verify/r","model":"script-code-mode"}'`
  and `drive.ts r watch <id> --submit 'go' --save ask` (it returns once the run waits):
  `sigma.approvals` holds a request for `bash` whose `callId` is
  `<codemode call>/c1`. `drive.ts r rpc approval/resolve '{"conversation":"<id>","approval":"<request>","author":"ada","allow":true}'`,
  then `drive.ts r watch <id> --save done`: a `pi.tool-result` for
  `codemode` reading `Script completed`, the command's output and `["bash"]`,
  then `done` and a `sigma.run_end` `answered`.
- **ChatGPT.** `drive.ts r up --fake-openai codemode_script`,
  `drive.ts r serve`,
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd":"/tmp/sigma-verify/r","provider":"openai","model":"gpt-6.1-sol","approvals":"auto"}'`,
  `drive.ts r watch <id> --submit 'compute 2 + 2' --until run_end --save chatgpt`:
  the script `text(2 + 2);` and its result `Script completed`, `4`.
  `evidence/fake-openai.ndjson` shows each request offering one tool, the
  custom `codemode` with a Lark grammar.

## With a real account

Needs a ChatGPT sign-in kept for verification, as SKILL.md's
[Real accounts](../SKILL.md#real-accounts) says. Start with
`drive.ts r up --openai-auth <that file>`, `drive.ts r serve`, and check that
`drive.ts r rpc providers/list '{}'` lists `openai` as `"status": "ready"`;
otherwise stop and report what it shows.

- **Pick a model.** `drive.ts r rpc models/list '{}'` saves ChatGPT's list
  to `/tmp/sigma-verify/r/home/cache/openai-models.json`. Pick a `slug`
  whose entry there has `"tool_mode":"code_mode_only"`, and copy the file
  into `evidence/`.
- **Calls.** `drive.ts r tui start --provider openai --model <model>`, send
  `Use codemode to run a script that calls tools.bash with the command 'echo approved', then reply with its output.`
  and `drive.ts r tui wait --timeout 120000 'allow this call?'`:
  `▸ codemode` and `bash` asking. `drive.ts r tui key C-y`,
  `drive.ts r tui wait --timeout 120000 READY`, `drive.ts r tui screen real`.

## Sources

Feature ledger area M: spec §7.6; README Code Mode.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- codemode-nested-policy: a script's call that changes things asks first, and a denied one fails in the script without running

Screen, `packages/sigma/test/screen.test.ts`:

- approval-ask, codemode-nested-policy: a script's call that waits for a person shows its command under the script before ctrl+y allows it
- subagent-card, codemode-nested-policy: a subagent a script started shows as a card under the script, and ctrl+y answers the call it asks about

Stack, `packages/sigma/test/stack.test.ts`:

- codemode-replay: a script whose server is killed during a nested call resumes in a new server without running its finished calls again
- codemode-stop: a script stuck in a long built-in stops when its run is interrupted, and the server then exits at once

Provider, `packages/sigma/test/openai.test.ts`:

- code-mode-models, openai-code-mode, codemode-grammar, codemode-tool: a model ChatGPT marks code-mode-only is offered codemode alone, writes raw JavaScript for it, and gets the script's result
- code-mode-models: a model that takes sigma's tools directly is offered them, and not codemode

## Gotchas

None recorded yet.
