# Watches and views

Clients and extensions follow conversations and documents through windowed views and in-process observers.

## Sub-features

- `view-watch` [kernel, pending harness-views] Conversation watch (R477-527, §9): Every client follows a conversation live
- `view-resume` [kernel, pending harness-views] Resume a watch from a position (§9.3): A reconnect gets only what it missed
- `view-window` [kernel, pending harness-views] Conversation view with a window, minimum 50, up to twice (§9.3): A long conversation opens instantly
- `watch-rpc` [pending wire-complete] The client path for Conversation view with a window, minimum 50, up to twice (§9.3): A long conversation opens instantly
- `view-transcript` [kernel, pending harness-views] `ConversationTranscript` items (§9.3): A client gets a ready model of the transcript
- `view-gap` [kernel, pending harness-views] Transcript gap marker (§9.3): A client knows history is missing and where
- `view-load-earlier` [kernel, pending harness-views] `earlier`, `loadEarlier` (§9.3): Scroll back and load more
- `tui-load-earlier` [pending tui-views] The client path for `earlier`, `loadEarlier` (§9.3): Scroll back and load more
- `view-fill-gap` [kernel, pending harness-views] `fillGap` (§9.3): A reconnecting client repairs a hole
- `doc-watch` [kernel, pending kernel-documents] Watch a document, `watchDoc` (R816-853, §9.1): A client or extension follows any state
- `view-documents` [kernel, pending harness-views] Documents on the conversation view (§9): One subscription carries agent, usage and extension state
- `observer-conversation` [kernel, pending harness-views] Observers for in-process code (§9.2): An extension reacts to changes, each with its own queue
- `observer-commits` [kernel, pending kernel-documents] `observeCommits` (§4): Extensions see every commit
- `view-slow-folding` [kernel, pending kernel-documents] Slow-watcher folding and 10,000-op root replacement (§9.2): A slow client catches up with merged changes rather than being dropped
- `view-live` [kernel, pending harness-run-core] Live state, `pi.live` (§8.2): Clients see partial answers and running tools
- `view-reasoning` [kernel, pending harness-views] Reasoning streamed live (§8.2): People see the model thinking
- `view-partial-arguments` [kernel, pending harness-run-core] Partial tool arguments streamed (`harness/partial-changes`): See a file being written as it is generated
- `view-run` [kernel, pending harness-views] A run as the view shows it: turns, partials, tool rounds, and a late joiner.
- `view-watch-end` [kernel, pending harness-views] A watch ends once, and `closed` or `stop()` gives its end reason and last value.

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `watch-rpc` lands with `wire-complete`, which adds its entry point and recipe.
- Not reachable yet: `tui-load-earlier` lands with `tui-views`, which adds its entry point and recipe.

## Sources

Feature ledger area P: spec §4, §8.2, §9; README Watching a Conversation; examples 04-watches, 20-late-join, 31-transcript, 36-durable-views.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
