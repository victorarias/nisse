---
name: verify-conformance
description: Use before opening a pull request that changes a kernel package (kernel, harness, models, env, tools, codemode, claude, delta, schema) or anything in packages/conformance.
---

# Verify conformance

Pi-durable's test suite in `packages/conformance` is the outside measure of the
kernel. Check that this change moved the measure honestly. Report findings. Do
not edit. `packages/conformance/README.md` explains the rows and the tools.

## Run

From `packages/conformance`:

1. `bun check.ts` compares both suite modes with `expected.json`. Note its counts
   and how many pending rows already pass.
2. Compare with the base: `git diff "$(git merge-base HEAD origin/main)" -- expected.json exclusions.json amendments.json`.
3. When the change touches `upstream/`, `port.ts`, `patches.json` or the
   baselines, run `bun port.ts --source=<checkout of earendil-works/pi at
upstream/COMMIT>`, confirm `git status upstream` shows nothing new, then run
   `bun check.ts --target=reference` on macOS and on Linux. Linux is
   authoritative.

`check` cannot see an unhandled rejection under Bun: vitest reports nothing for
one and the test still passes. Read for them in code that floats a promise.

## Judge

- Did every row this child owns move to `pass`, in both modes? A row it cannot
  make pass is reported on its seed and stays `pending` (D14).
- Does any `pending` row pass and still say `pending`? The owning child flips it.
- Did a `pass` row change to anything else? That is a regression unless a named
  decision says otherwise.
- Did a row become `flaky`? It needs a reason measured over repeated runs, not
  one failure.
- Does a new exclusion cite a decision or spec amendment named in the pull
  request? The list was reviewed once, against the count in `exclusions.json`.
- Is `upstream/` unchanged? Only `port.ts` writes it.
- Is each `amended/` test written against public behavior, with the spec section
  from `amendments.json`, and does its row say `amended <file>`?
- Is the adapter a thin translation? Logic there is a kernel behavior the kernel
  does not have, and the suite is then judging the adapter.
- Does the adapter reach private state to satisfy a test? That test should be in
  `amendments.json` or `exclusions.json`.

## Report

For each finding, give the test or `file:line`, the question it fails, and what
to do. Then give `check`'s counts against the base. If nothing has a finding, say
so in one line with those counts.
