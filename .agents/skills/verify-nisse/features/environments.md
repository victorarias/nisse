# Execution environments

Tools work through an execution environment, per conversation, for commands, files and watches.

## Sub-features

- `env-per-conversation` [kernel] `env` factory per conversation (R430-463, example 28): Each conversation can be sandboxed apart
- `env-interface` [kernel] `ExecutionEnv` interface (R430-463, `env/index.ts`): Tools work unchanged on another machine or container
- `env-exec` [kernel] `exec` with argv, no shell (§7.3): A tool runs a program without quoting hazards
- `env-binary-reader` [kernel] Binary reader and `scanLines` (§7.3): Read huge files in a bounded way
- `env-directory-reader` [kernel] Directory reader and `listFiles` (§7.3): Bounded listing
- `env-watch` [kernel] File `watch` (§7.3, `env/node-watch`): An extension reacts to file changes
- `env-file-serialization` [kernel] File work serialized by environment id (§7.3): The queue from L31 works across conversations on the same files
- `env-conformance` [kernel] Environment conformance suite (`testing/env-conformance`, 633 lines): A custom environment can be proven correct
- `env-variables` [kernel] Environment variables to commands (R430-463): Commands know their conversation
- `env-text-reader` [kernel] Text line reading decodes multi-byte splits and reports newline termination.
- `env-filesystem` [kernel] Files and directories read, write, list, rename and fail with typed errors.
- `env-shell` [kernel] Shell execution streams, spills, times out, aborts and reports exit codes.
- `env-truncate` [kernel] Truncation by lines and UTF-8 bytes reports what it cut.

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

- `packages/env` is the implementation: `LocalExecutionEnv` from `@nisse/env/local`, on Effect. Interrupting an
  operation is how it is cancelled, and an interrupted `exec` completes only once its processes are gone. A caller that
  needs the spill path of an interrupted command passes `onSpill`.
- `listFiles` is optional in the interface, and the local environment does not implement it, as upstream's does not;
  its conformance cases run only for an environment that does.
- The `env` factory per conversation is the harness's (`harness-tools`), and the file mutation queue keyed by the
  environment's `id` is the tools' (`tools-package`). This package supplies the `id`.
