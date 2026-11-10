# @nisse/tools

The tools a model works with, on `@nisse/harness` and Effect. Each tool reaches files and processes only through the
calling conversation's environment (`api.env`, an `@nisse/env` `ExecutionEnv`), so it works on whichever environment
the conversation uses.

| Export                                         | Tool                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `createReadTool({ images? })`                  | `read`: text with head truncation and continuation hints, or one image              |
| `createWriteTool()`                            | `write`: create or replace a file and its parent directories                        |
| `createEditTool()`                             | `edit`: exact replacements with fuzzy matching; details carry a diff and a patch    |
| `createBashTool({ commandPrefix?, prepare? })` | `bash`: streamed output, tail kept, spill file, programs get `{ output, exitCode }` |
| `createPowerShellTool()`                       | `powershell`: the same through `pwsh` or Windows PowerShell                         |
| `createGrepTool()`, `createGlobTool()`         | `grep` and `glob`: search below a directory, skipping what git ignores              |
| `createApplyPatchTool()`                       | `apply_patch`: add, update, move and delete files from one Codex-format patch       |
| `createToolSearchExtension()`                  | `tool_search`: BM25 over deferred tools, loading the matches for the next request   |
| `createCodingTools()`, `CodingTools`           | the `coding-tools` extension: `read`, `write`, `edit` and `bash`                    |

- `edit`, `write` and `apply_patch` serialize their mutations of one file with `withFileMutationQueue`, keyed by the
  environment's `id` and the file's canonical path, so parallel calls on one file both land (spec 7.3).
- `rootConversationEnv` is a `bash` `prepare` that sets `NISSE_ROOT_CONVERSATION` to the conversation people started,
  found through the owners of the calling conversation.
- Images: `@nisse/tools/images` has `createPhotonImages(wasm)`, Photon's WebAssembly preparing images on the calling
  thread; `@nisse/tools/images/node` has `createNodePhotonImages()`, which reads the WebAssembly from the installed
  package and prepares images in a worker thread. Photon runs under Bun, in the worker too. Without a processor, `read`
  passes inline formats within the model's limits through as they are.

`read`, `write`, `edit`, `bash`, `powershell`, `tool_search`, the BM25 ranker (`src/search.ts`), `edit-diff`, image
detection and EXIF are derived from pi-durable's `src/tools/`, `src/images/`, `src/tool-search/` and `src/search.ts` at
commit `7d073328e` (earendil-works/pi), under the MIT license in `LICENSE`; each file names its source. `grep`, `glob`
and `apply_patch` carry nisse's own tools over to the environment.

## Tests

The conformance suite (`packages/conformance`) runs upstream's tool, image and search tests through its adapter. `test/`
holds package tests through a real Harness with a scripted model, for what no upstream row covers: two parallel edits
of one file, `grep`, `glob`, `apply_patch`, `NISSE_ROOT_CONVERSATION`, and images in user input and tool results.
