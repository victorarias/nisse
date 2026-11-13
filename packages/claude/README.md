# @nisse/claude

Claude Code as a run task on `@nisse/harness`. A conversation whose model a Claude Code instance serves runs each run as
the `claude.run` task, served by the conversation's Claude Code process, started through the Claude Agent SDK. The
process stays live after a run for the conversation's next one, and closes after 30 minutes without a run. Claude Code
keeps its own session and runs its own tools; nisse's transcript stays the truth, and every frame Claude Code sends
becomes a commit.

`claudeRunTasks(options)` returns the two task definitions, to install in the registry, and the `RunTasks` to open the
harness with, which choose `claude.run` for a model whose provider `options.settings` knows. `options.processes` is the
server's `makeClaudeProcesses`, opened with the idle period and the hold that keeps the server up while a process is
live.

- `src/run.ts`: `claude.run`. An invocation starts by recording, as interrupted, the calls a previous process left
  without results, which only a crash or a stop leaves, and each ends its process; a stop is not counted as a
  restart. It then leases the conversation's live process, told only the entries after the newest one it has seen,
  when the process key matches and those entries are continuable. Otherwise it starts a process (a cold start) where
  Claude Code's session starts: a resume at the conversation's position, a fork of it when the position belongs to the
  conversation this one forked from, or a fresh session when there is none, another provider's Claude Code held it, or
  a reset, a compaction or another model's answer came after it. A fresh session is named with the conversation's title, which
  `ClaudeRunOptions.title` gives, so Claude Code does not ask a model for one. A live process that exited while it
  waited costs a cold start. A session Claude Code no longer has, or no longer holds the position of (as after its
  compaction), is dropped and the run starts over in a fresh one, once. A run that answers leaves its process live;
  one that fails, is stopped, hits the turn limit or leaves Claude Code background work closes it. The
  `claude.subagent` task holds the run of a hosted subagent's conversation until Claude Code says the subagent ended.
- `src/processes.ts`: the server's live processes, at most one per conversation: the lease, the idle release after
  `IDLE_RELEASE` (30 minutes), the release of a process that exited while it waited, and closing them all when the
  server stops. Each process holds the server's lifetime from its start to its close. Nothing about them is durable: a
  restart cold starts every conversation from `claude.session`.
- `src/process.ts`: one Claude Code process, started through the Claude Agent SDK at a resume, a fork or a fresh
  session. It owns the query, the inbox its messages go through, the frame pump, the callbacks Claude Code makes, its
  session id across `/clear`, its usage (`modelUsage` reports running totals of the process's own, so a second run
  counts only what came after the first), and the tasks Claude Code started and has not ended. `serve` hands its
  frames and callbacks to one run until the run ends; while it serves none, a callback fails, and the process reads
  ahead so that its exit is seen. `processKey` names what a process is spawned with and cannot change: the provider,
  executable, environment, arguments, directory, own and withheld tools, turn limit, model and effort.
- `src/serving.ts`: what one run does with its process's frames. A call Claude Code makes is committed as an assistant
  entry and a live slot before its PreToolUse hook is answered, with the extensions' `beforeTool` applied; a call it
  would ask about waits on `nisse.approvals`, keyed `<task>/<call>`, where the first answer counts. An extension's tool
  reaches Claude Code over nisse's in-process MCP server and runs as a `pi.tool` task. `afterTool` runs through
  PostToolUse: Claude Code takes a changed result only for `Read`, so another tool's change is reported. Steers placed
  at a round of results are sent with priority `next`. Claude Code's compaction is kept as a compaction entry holding
  its summary, `/clear` as a reset. The subagents a run hosts end with the process.
- `src/environment.ts`: how every Claude Code process starts, a run's, the account probe's and `claude auth`'s: the
  server's environment without the variables a host Claude Code session sets, then the provider instance's `env`. A
  run's settings also turn tool search on where the person's Claude Code settings leave it at `auto`.
- `src/session.ts`: `claude.session`, the conversation's position in Claude Code's session: the session, the newest
  message nisse committed, and the newest entry Claude Code was shown. Rewindable, so a fork sees it as of its fork.
- `src/retell.ts`: what a session is told of the conversation: the entries a resumed one missed, or, for a fresh one,
  the conversation so far within about 64,000 characters.
- `src/links.ts`: how a hosted subagent ended and how to stop it, shared in memory by the run and its subagent tasks.

The tests in `test/` drive `claude.run` through a Harness with nisse's fake `claude` replaying `fixtures/claude`;
`packages/nisse/test/claude.test.ts` drives it over the wire.
