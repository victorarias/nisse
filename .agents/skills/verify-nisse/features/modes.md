# Modes and patterns

Whole-app patterns: print, JSON, plan mode, a reviewer, per-conversation sandboxes, and the model layer.

## Sub-features

- `mode-print` [kernel, pending wire-complete] Print mode (example 17): Run one prompt, print the answer
- `mode-json` [kernel, pending wire-complete] JSON mode (example 18): Scripts read events
- `exec-json` [pending wire-complete] The client path for JSON mode (example 18): Scripts read events
- `mode-plan` [kernel, pending wire-complete] Plan mode (example 26): Model plans with write tools withheld, then a person approves
- `mode-reviewer` [kernel, pending wire-complete] Reviewer extension (example 27): A second model checks each run
- `mode-sandbox` [kernel, pending wire-complete] Sandbox per conversation (example 28): Isolate work
- `mode-model-layer` [kernel, pending wire-complete] Model layer with many providers through pi-ai (R94-104, dependencies): Use any provider or a local model

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `exec-json` lands with `wire-complete`, which adds its entry point and recipe.

## Sources

Feature ledger area Y: README Examples; examples 05-harness, 13-chat, 15-real-model, 17-print, 18-json, 25-coding-agent, 26-plan-mode, 27-reviewer, 28-sandbox-per-conversation, 30-reload-and-restart, 32-tests-after-edits.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
