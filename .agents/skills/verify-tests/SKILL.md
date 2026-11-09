---
name: verify-tests
description: Use before opening a pull request whose changes add, change or delete nisse's own tests.
---

# Verify tests

Judge whether each test this change adds, changes or deletes earns its place in
the suite. Report findings. Do not edit.

The "Testing" section of `AGENTS.md` is nisse's test strategy. Read it first;
this skill does not repeat it. `packages/conformance` is outside this skill:
`verify-conformance` covers it.

## Read

1. List the changed tests and the code they cover:
   `git diff --stat "$(git merge-base HEAD origin/main)"` and the new files in
   `git ls-files --others --exclude-standard`.
2. Read each changed test file whole, not only its hunks.
3. Read the code change, so you know which promises it touches.
4. For each new or changed test, search the suite for tests of the same
   behavior and read them. Duplicates are usually outside the diff.

## Run

Run each changed test file with `bun test <file>`, then ten times in a row. A
failure in any run is a flake.

When you doubt that a test can fail, break the behavior it guards and run it.
Do that in a scratch worktree (`git worktree add --detach`), never in this
checkout, and remove the worktree when you are done.

## Judge each test

- Which promise does it guard, and does its name say what someone would see if
  it broke? A test that guards none is a finding.
- Is it the highest kind that can observe the behavior: Wire, Screen, Stack or
  Provider? A Package test needs specified logic with a large input space, or a
  promise no wire test can reach. Name which.
- Would it break if the code were rewritten with the same behavior?
- Does another test guard the same promise through the same entry? Name the one
  to keep.
- Can it fail? Does it assert only on its own fakes, check what the compiler
  guarantees, read source files, or test a helper?
- Could it fail on a good run? Look for sleeps, wall-clock deadlines, shared
  state, order between tests, and a `NISSE_HOME` it does not own.
- Does a deleted test leave a promise unguarded?

## Report

For each finding, give the test's `file:line`, the question above it fails, and
what to do: delete it, move it to another kind, or name what it should assert.
If no test has a finding, say so in one line.
