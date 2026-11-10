# @nisse/harness

The agent harness over `@nisse/kernel`, rewritten on Effect from pi-durable's specification
(`packages/kernel/docs/spec.md`, sections 2, 5 and 7). A Harness owns one Session and its task scheduler and adds
conversations, their agents and the extension registry.

So far it holds the shell; running a model turn comes with the next steps of the kernel rebuild:

- `src/harness.ts`: `openHarness` opens the Session and the scheduler over one Storage. It creates the root lazily,
  creates and forks conversations, resets them with an optional handoff, and gives tasks their services. The built-in
  creation hook (spec 7.1) runs in every commit that creates or forks a conversation: empty `pi.live`, `pi.inbox` and
  `pi.usage`, a fresh `pi.provider`, and the owner's agent copied into `pi.agent`. A Session that fails is reported as
  `storage_failed`, and a scheduler report about a task names the extension whose definition it has.
- `src/services.ts`: `TaskServices`, the per-phase service a harness task reads: its conversation's agent (resolved
  once per handler, against the phase's registry snapshot), settings, models, environment, hooks, context and
  conversation handles. Every operation ends with the invocation.
- `src/agent.ts`: `pi.agent` and `configure` (spec 7.1): a conversation stores names, not objects, so a selection
  survives uninstall and restart. `resolveAgent` binds the names to a registry snapshot: extension selection, tools in
  place, wraps, the tools filter, who may call each tool, sections and the instructions section.
- `src/registry.ts`: `createRegistry` and the extension helpers. Installing replaces an extension of the same name in
  place and publishes a new immutable snapshot; running work keeps the snapshot it started with (spec 7.5).
- `src/prompt.ts`: system prompt sections as Effects, rendered in order, and the positional `pi.system` entries that
  record what changed (spec 7.4).
- `src/context.ts`: context derivation from entries, heads and edits (spec 2.1).
- `src/entries.ts`, `src/documents.ts` and `src/builtin.ts`: the built-in entry kinds, documents and tasks. The tasks
  `pi.generation`, `pi.tool` and `pi.compaction` are registered by name; their phases fail naming the step that brings
  them.

Extension code is Effect-shaped: a section renders as an Effect, hook handlers return Effects, and an extension's tasks
are kernel tasks whose handlers need `TaskServices`.

`src/agent.ts`, `src/registry.ts`, `src/prompt.ts`, `src/context.ts` and `src/harness.ts` are derived from
pi-durable's `src/harness/` files of the same names at commit `7d073328e` (earendil-works/pi), under the MIT license
in `LICENSE`.

## Tests

The conformance suite (`packages/conformance`) runs the upstream harness tests through its adapter, which converts
upstream's Promise extensions to these Effect ones at install. `test/` holds package tests for use cases no upstream
row covers: agent configuration and inheritance, provider identity per fork, reopening conversations, a fork that
resets, the registry's conflicts and stored names, extension state, an extension reloaded mid-run, and memory over
long chains of ended tasks.
