# @nisse/codemode

Durable code mode on `@nisse/harness` and Effect: one `codemode` tool whose argument is a JavaScript script. The script
calls the conversation's other tools as `await tools.<name>(args)`, each one a nested call under the `codemode` call
that passes the same hooks and approvals as a direct call. Every result is journaled before the script sees it, so after
a restart the script runs again from the start, gets its finished calls from the journal without running them again,
and stops with an error if it takes another path.

| Export                                                                  | What it is                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCodemodeExtension({ sandbox, … })`                               | the `codemode` extension: the tool, the `codemode` prompt section (rendered only when the agent offers `codemode`) and the internal `models.*` tools |
| `createCodemodeTool(options)`                                           | the `codemode` tool alone                                                                                                                            |
| `CodemodeRunDoc`, `CodemodeJournalDoc`, `CodemodeStoreDoc`              | the documents `pi.codemode.run`, `pi.codemode.journal` and `pi.codemode.store`                                                                       |
| `codemodeDescription`, `codemodeSection`, `formatResult`, `catalogCall` | the tool description, the prompt section, the result format and the `models.*` catalog                                                               |
| `@nisse/codemode/sandbox`                                               | `CodemodeSandbox`: the deterministic QuickJS sandbox, run in a worker thread                                                                         |

- A script sees `tools`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`, `store`, `text`, `image`,
  `console`, `exit` and `models.*`. Its first line may be `// @options: {"max_output_tokens": N, "timeout_ms": N}`.
- Interrupting the call ends the script at once and never waits for its worker, which may be stuck in a long built-in.
  The worker keeps the process alive, so the binary's `serve` exits explicitly at the end of its lifetime.
- `codemode` takes a Lark grammar (`constrainedSampling`), which ChatGPT's code-mode models are offered as a custom
  tool.

`src/sandbox/` is pi-codemode's `src/` (earendil-works/pi, `packages/codemode`, commit `7d073328e`) without its remote
and Cloudflare runtimes. `src/codemode.ts`, `src/describe.ts`, `src/models.ts` and `src/output.ts` are derived from
pi-durable's `src/codemode/` at the same commit, with Promises turned into Effects. Both are under the MIT license in
`LICENSE`; each file names its source. The QuickJS WebAssembly comes from the `quickjs-wasi` package.
