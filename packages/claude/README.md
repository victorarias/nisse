# @nisse/claude

Claude Code as a run task on `@nisse/harness`. A conversation whose model a Claude Code instance serves runs each run as
the `claude.run` task: one Claude Code process, started through the Claude Agent SDK, from the run's inputs to its
`run_end`. Claude Code keeps its own session and runs its own tools; nisse's transcript stays the truth, and every
frame Claude Code sends becomes a commit.

`claudeRunTasks(options)` returns the two task definitions, to install in the registry, and the `RunTasks` to open the
harness with, which choose `claude.run` for a model whose provider `options.settings` knows.

- `src/run.ts`: `claude.run`. An invocation starts by recording, as interrupted, the calls a previous process left
  without results; no process outlives an invocation, and a stop is not counted as a restart. It then picks where
  Claude Code's session starts: a resume at the conversation's position, a fork of it when the position belongs to the
  conversation this one forked from, or a fresh session when there is none, another provider's Claude Code held it, or
  a reset, a compaction or another model's answer came after it. A session Claude Code no longer has, or no longer
  holds the position of (as after its compaction), is dropped and the run starts over in a fresh one, once. The
  `claude.subagent` task holds the run of a hosted subagent's conversation until Claude Code says the subagent ended.
- `src/process.ts`: one Claude Code process. A call Claude Code makes is committed as an assistant entry and a live slot
  before its PreToolUse hook is answered, with the extensions' `beforeTool` applied; a call it would ask about waits on
  `nisse.approvals`, keyed `<task>/<call>`, where the first answer counts. An extension's tool reaches Claude Code over
  nisse's in-process MCP server and runs as a `pi.tool` task. `afterTool` runs through PostToolUse: Claude Code takes a
  changed result only for `Read`, so another tool's change is reported. Steers placed at a round of results are sent
  with priority `next`. Claude Code's compaction is kept as a compaction entry holding its summary, `/clear` as a
  reset. Usage is taken from `modelUsage`, which each process reports as running totals of its own.
- `src/session.ts`: `claude.session`, the conversation's position in Claude Code's session: the session, the newest
  message nisse committed, and the newest entry Claude Code was shown. Rewindable, so a fork sees it as of its fork.
- `src/retell.ts`: what a session is told of the conversation: the entries a resumed one missed, or, for a fresh one,
  the conversation so far within about 64,000 characters.
- `src/links.ts`: how a hosted subagent ended and how to stop it, shared in memory by the run and its subagent tasks.

The tests in `test/` drive `claude.run` through a Harness with nisse's fake `claude` replaying `fixtures/claude`;
`packages/nisse/test/claude.test.ts` drives it over the wire.
