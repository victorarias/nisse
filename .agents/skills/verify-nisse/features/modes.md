# Modes and patterns

Whole-app patterns: print, JSON, plan mode, a reviewer and per-conversation sandboxes.

## Sub-features

- `mode-print` [kernel, pending cli-kernel] Print mode (example 17): Run one prompt, print the answer
- `mode-json` [kernel, pending cli-kernel] JSON mode (example 18): Scripts read events
- `exec-json` [pending cli-kernel] The client path for JSON mode (example 18): Scripts read events
- `mode-plan` [kernel] Plan mode (example 26): Model plans with write tools withheld, then a person leaves plan mode to carry it out
- `mode-reviewer` [kernel] Reviewer extension (example 27): A second agent on its own model reviews the work
- `mode-sandbox` [kernel] Sandbox per conversation (example 28): Isolate work
- `models-script` [kernel] The `script` provider answers through the Models seam (`packages/models`) from `NISSE_MODEL_SCRIPT`'s steps: text word by word, a tool call, a failure, one step list per agent, and `You said: <last user text>` once the steps run out.
- `models-faux` [kernel] The faux model answers through the Models seam: scripted responses one per request, a deferred response pending for a set number of fetches and then ready, cancel, a retryable error as the final message, and usage with a simulated prompt cache.
- `models-overflow` [kernel] A provider error is read as a context overflow by pi-ai's patterns for each provider, so a run compacts instead of failing.
- `models-retryable` [kernel] A provider error is read as transient or final by pi-ai's patterns, and the retry delay doubles up to its cap.
- `models-unsupported` [kernel] A Models method a provider lacks fails with `Unsupported` naming the method and the provider; a model whose provider is missing fails with `UnknownProvider`.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `exec-json` lands with `cli-kernel`, which adds its entry point and recipe.

## Sources

Feature ledger area Y: README Examples; examples 05-harness, 13-chat, 15-real-model, 17-print, 18-json, 25-coding-agent, 26-plan-mode, 27-reviewer, 28-sandbox-per-conversation, 30-reload-and-restart, 32-tests-after-edits.

## Tests

Package, `packages/models/test/seam.test.ts`:

- models-script, models-faux, models-unsupported: a run through each provider behind the seam, and what a missing method or provider answers

Package, `packages/harness/test/modes.test.ts`, each pattern built only from `@nisse/harness`'s public API with the faux model:

- mode-plan: `configure` selects the plan extension and narrows the tools to `read` and `submit_plan`, a `write` the model calls anyway is refused, the plan lands in the extension's document, and clearing both gives every tool back, which the model sees as a system prompt change
- mode-reviewer: a reviewer conversation stores its own model, extensions, `read` only and checkout beside a main agent that runs without them, and its `onYield` hook asks again until the answer says it is done
- mode-sandbox: the environment builder reads each conversation's sandbox document on every call, so each conversation's tools work in its own directory, also after the app moves it, and a fork without one gets no environment

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
