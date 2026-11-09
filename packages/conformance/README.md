# Conformance

pi-durable's own test suite, kept as an outside measure of nisse's kernel. It is
private to this repository: nothing imports it, and it is outside root `tsc`,
prettier and `bun test`.

`upstream/` is pi-durable's `test/` and `src/testing/` at the commit in
`upstream/COMMIT`, under the MIT license in `upstream/LICENSE` (Copyright 2025
Mario Zechner). Do not edit it. `port.ts` regenerates it and applies the only
allowed test edits: the `gc` lookup, and the removed-backend edits in
`patches.json`.

## Running

`bun run check` runs `bun packages/conformance/check.ts`: the suite in both modes
(normal, and with every unattached document evicted after use) through
`adapter/`. Every test is compared with its row in `expected.json`, and the check
fails on a mismatch, a test with no row, or an exclusion citing an unknown
decision.

| Row                | Meaning                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `pass`             | must pass                                                                              |
| `pending <child>`  | not judged yet; that child flips it to `pass` and `check` reports how many already pass |
| `flaky <reason>`   | reported, never fails `check`                                                          |
| `amended <file>`   | skipped; the rewrite in `amended/<file>` has its own row                               |
| `excluded <D>`     | skipped; listed in `exclusions.json` with its decision                                 |

`bun check.ts --target=reference` runs the same suite against the reference copy
of pi-durable and compares each result with `baseline/<platform>.json`. It needs
`reference/`, which `bun port.ts --source=<checkout of earendil-works/pi at
COMMIT>` generates. Linux is authoritative; a row that differs across runs or
platforms is `flaky`.

## How the rows were made

- `baseline.ts` runs the reference copy three times per mode and writes
  `baseline/<platform>.json`.
- `derive.ts owners` builds one tree per child in delivery order: that child's
  and earlier children's modules are real, later ones throw. The earliest stage
  where a test passes is its owner (`classification/owners.json`). A module
  `Harness.open` needs in order to run at all stays with `harness-shell`.
- `rows.ts` combines those with the test files each child's brief names (a row
  in a named file belongs to that child or a later one) and writes
  `expected.json`, `exclusions.json` and `amendments.json`.
- `amendments.json` lists pinned tests that a spec section backs. The owning
  child writes the rewrite in `amended/` against the public API, then flips the
  row to `amended <file>`.

## The adapter

`adapter/` mirrors the module paths the suite imports. Each export not yet
implemented is `unimplemented(name, owner)`: it loads, and throws naming the
owner on first use. A child replaces the exports it owns with thin wrappers over
its package. `derive.ts adapter` generated the first version and is not rerun
once children edit it. `setDefaultDocumentRetention` is real, because the setup
file calls it in every run; `kernel-session` connects it.

Test doubles behind the Storage port: `adapter/durable/src/storage/memory.ts` is
upstream's `MemoryStorage` copied unchanged, and `ControlledStorage` stays in
`upstream/test/session-support.ts`. A reopen in the suite keeps one store across
Session close.

## Stand-ins

| Stand-in                                                    | Owner                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pi-ai` root, `models`, `providers/faux`                    | `models-seam`, including the faux model's deferred polling and retry     |
| `pi-schema`                                                 | re-exports `packages/schema`                                             |
| `pi-telemetry` contexts                                     | `harness-compaction`, fed by an Effect tracer (D7)                       |
| chord `context`                                             | copied here, in `adapter/chord/src/context`                              |
| chord `json`, `delta`                                       | re-export `packages/delta`                                               |
| chord `output`                                              | unassigned; still a stand-in, used by `harness-tools` and `tools-package` |
| chord `sqlite`                                              | `kernel-storage`                                                         |
| chord `watch`                                               | `kernel-documents`                                                       |
| `pi-codemode`                                               | `codemode-package`                                                       |

`reference-support/` holds the hand-written `pi-ai` stand-in and the `bun:sqlite`
overlay that only the reference copy uses.
