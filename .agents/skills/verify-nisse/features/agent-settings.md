# Per-conversation agent and settings

A conversation's configuration is durable, forkable and watchable, and harness settings change without a restart.

## Sub-features

- `agent-document` [kernel] `pi.agent` document holding a conversation's configuration (R380-404): Configuration is durable, forkable, watchable
- `agent-instructions` [kernel] `configure()`: instructions change later (R380-404): Change the brief without restarting
- `configure-rpc` [pending surface-conversations] The client path for `configure()`: instructions change later (R380-404): Change the brief without restarting
- `agent-cwd` [kernel] `configure()`: working directory change (R380-404): Move a conversation to another directory
- `agent-model` [kernel] `configure()`: model (R380-404): Switch model mid-conversation
- `agent-thinking` [kernel] `configure()`: thinking level (R380-404): Change reasoning depth
- `agent-tools-filter` [kernel] `configure()`: tools filter (R380-404): Limit which tools a conversation has
- `agent-inherit` [kernel] Children and forks inherit agent settings (§3.7): A subagent starts with its parent's setup
- `agent-visible` [kernel] Agent changes visible on the watch and rewindable (§2.2): Every client sees configuration changes and forks can read old ones
- `settings-live` [kernel] Live harness settings (R406-428): Change policy without a restart
- `settings-default-extensions` [kernel] Default extension selection (R406-428): New conversations get a chosen extension set
- `settings-tool-execution` [kernel, pending harness-tools] `toolExecution`: parallel or sequential (R406-428, §8.5): Trade speed against ordering
- `settings-progress-intervals` [kernel] Output progress intervals (§8.2): Tune how often running output is stored
- `settings-as-functions` [kernel] `models` and `settings` given as functions are read at each decision.
- `agent-resolved` [kernel] `conversation.agent()` returns the resolved agent: model, extensions, offered and callable tools, sections and working directory.
- `settings-context-retention` [kernel] `contextRetentionMs` sets how long an idle conversation's context read is kept.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `configure-rpc` lands with `surface-conversations`, which adds its entry point and recipe.

## Sources

Feature ledger area H: spec §2.2, §3.7, §8.2, §8.5; README Per-Conversation Agent, Settings; example 06-configuration.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
