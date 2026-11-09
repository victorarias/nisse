# Execution environments

Tools work through an execution environment, per conversation, for commands, files and watches.

## Sub-features

- `env-per-conversation` [kernel, pending env-package] `env` factory per conversation (R430-463, example 28): Each conversation can be sandboxed apart
- `env-interface` [kernel, pending env-package] `ExecutionEnv` interface (R430-463, `env/index.ts`): Tools work unchanged on another machine or container
- `env-exec` [kernel, pending env-package] `exec` with argv, no shell (§7.3): A tool runs a program without quoting hazards
- `env-binary-reader` [kernel, pending env-package] Binary reader and `scanLines` (§7.3): Read huge files in a bounded way
- `env-directory-reader` [kernel, pending env-package] Directory reader and `listFiles` (§7.3): Bounded listing
- `env-watch` [kernel, pending env-package] File `watch` (§7.3, `env/node-watch`): An extension reacts to file changes
- `env-file-serialization` [kernel, pending env-package] File work serialized by environment id (§7.3): The queue from L31 works across conversations on the same files
- `env-conformance` [kernel, pending env-package] Environment conformance suite (`testing/env-conformance`, 633 lines): A custom environment can be proven correct
- `env-variables` [kernel, pending env-package] Environment variables to commands (R430-463): Commands know their conversation
- `env-text-reader` [kernel, pending env-package] Text line reading decodes multi-byte splits and reports newline termination.
- `env-filesystem` [kernel, pending harness-run-core] Files and directories read, write, list, rename and fail with typed errors.
- `env-shell` [kernel, pending env-package] Shell execution streams, spills, times out, aborts and reports exit codes.
- `env-truncate` [kernel, pending env-package] Truncation by lines and UTF-8 bytes reports what it cut.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area N: spec §7.3; README Environment; example 28-sandbox-per-conversation.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
