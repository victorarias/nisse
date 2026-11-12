# Watches and views

Clients and extensions follow conversations and documents through windowed views and in-process observers.

## Sub-features

- `view-watch` [kernel] Conversation watch (R477-527, §9): Every client follows a conversation live
- `view-resume` [kernel] Resume a watch from a position (§9.3): A reconnect gets only what it missed
- `view-window` [kernel] Conversation view with a window, minimum 50, up to twice (§9.3): A long conversation opens instantly
- `watch-rpc` The client path for Conversation view with a window, minimum 50, up to twice (§9.3): A long conversation opens instantly
- `view-transcript` [kernel] `ConversationTranscript` items (§9.3): A client gets a ready model of the transcript
- `view-gap` [kernel] Transcript gap marker (§9.3): A client knows history is missing and where
- `view-load-earlier` [kernel] `earlier`, `loadEarlier` (§9.3): Scroll back and load more
- `tui-load-earlier` The client path for `earlier`, `loadEarlier` (§9.3): Scroll back and load more
- `view-fill-gap` [kernel] `fillGap` (§9.3): A reconnecting client repairs a hole
- `tui-fill-gap` The client path for `fillGap` (§9.3): a TUI that fell behind shows `… missing messages` where entries are missing, and loads them once scrolled to
- `doc-watch` [kernel] Watch a document, `watchDoc` (R816-853, §9.1): A client or extension follows any state
- `view-documents` [kernel] Documents on the conversation view (§9): One subscription carries agent, usage and extension state
- `observer-conversation` [kernel] Observers for in-process code (§9.2): An extension reacts to changes, each with its own queue
- `observer-commits` [kernel] `observeCommits` (§4): Extensions see every commit
- `view-slow-folding` [kernel] Slow-watcher folding and 10,000-op root replacement (§9.2): A slow client catches up with merged changes rather than being dropped
- `view-live` [kernel] Live state, `pi.live` (§8.2): Clients see partial answers and running tools
- `view-reasoning` [kernel] Reasoning streamed live (§8.2): People see the model thinking
- `view-partial-arguments` [kernel] Partial tool arguments streamed (`harness/partial-changes`): See a file being written as it is generated
- `view-run` [kernel] A run as the view shows it: turns, partials, tool rounds, and a late joiner.
- `view-watch-end` [kernel] A watch ends once, and `closed` or `stop()` gives its end reason and last value.

## How to get to it

### People

- In the TUI, scroll the transcript up with the mouse wheel. Above the oldest entry the TUI holds it
  shows `↑ earlier messages`, and scrolling it into view loads the page before it, keeping the rows in view where
  they were; the marker is gone once the first entry is loaded.
- A TUI that fell behind, and watched again from the newest entry it held, shows `… missing messages` where entries
  are missing; scrolling it into view loads them a page at a time.

### Agents

- Call `conversation/watch`, with an optional `window` of `from`, `min` and `max`.

## Driving it with drive.ts

Preconditions: a run made with `drive.ts r up`, so Nisse echoes `You said: <prompt>`.

- **Watch.** Run `drive.ts r serve`, take the id from
  `drive.ts r rpc conversation/start '{"cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit 'a b c d e f g h i j k l m n o p q r s t u v w x y z one two three four five six seven eight nine ten' --until run_end --save answer`
  (a prompt this long streams; a short one ends before any live text
  commits): the first line is `{"_tag": "view", ...}` with `entries` and `docs`, then one
  `{"_tag": "change", "ops": [...]}` per commit, live words as `"a"` ops on
  `docs.pi.live.generation.message`, and the entries `nisse.user`,
  `pi.assistant` and `nisse.run_end` spliced into `entries`. A fresh
  `drive.ts r watch <id> --save fresh` shows the same entries in its first
  view, and `--from <entry id>` starts the window at that entry.
- **Load earlier.** Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "id": "long"}'`, then forty times
  `drive.ts r watch long --submit 'prompt <n>' --until run_end` for `<n>` from 1 to 40: 120 entries, more than
  twice the window. Run `drive.ts r tui start --conversation long` and `drive.ts r tui wait 'You said: prompt 40'`.
  Turn the wheel up with `drive.ts r tui type $'\e[<64;20;5M'`, five at a time, until
  `drive.ts r tui screen top` shows `prompt 1` under `ADA` and no `↑ earlier messages` (about forty turns of five).
- **Reconnect.** With the TUI open, `drive.ts r kill-server`, then `drive.ts r tui type 'prompt 41'` and
  `drive.ts r tui key Enter`: the TUI brings a server back and the prompt reaches it. Scroll down to
  `You said: prompt 41`, then back up to `prompt 1`: no `… missing messages` on the way.
- **Missing messages.** Not drivable by hand: a TUI falls behind only when it leaves 4,096 changes unread, which takes
  hundreds of prompts while it is frozen. The screen test `tui-fill-gap` freezes the TUI against a server with
  a small queue.

## Sources

Feature ledger area P: spec §4, §8.2, §9; README Watching a Conversation; examples 04-watches, 20-late-join, 31-transcript, 36-durable-views.

## Contexts

None.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- watch-rpc: a watch through a window opens on the newest entries, and from a position gets only what followed
- watch-rpc: a window that is not one is refused by name, and the connection's other watches go on

Screen, `packages/nisse/test/screen.test.ts`:

- answer-scroll, tui-load-earlier: a conversation longer than the window scrolls back to its first message, loading earlier entries on the way, and a reconnect leaves no gap
- tui-fill-gap: a TUI that fell behind marks where entries are missing, and loads them once scrolled to

Package, `packages/harness/test/partial-changes.test.ts`:

- view-partial-arguments: a call that ends between a partial's capture and its commit keeps the arguments streamed so far
- view-partial-arguments: a call already committed that ends before its next commit keeps the newer arguments
- view-live: a partial copied ahead of the text events seen commits the copied text, never the deltas twice

Package, `packages/harness/test/view.test.ts`:

- view-resume, view-gap, view-fill-gap: a client reconnecting from its position gets what it missed, or a gap it fills
- view-load-earlier: a loader that throws building its load fails that call, and the next call loads

Package, `packages/harness/test/harness.test.ts`:

- doc-watch: a document watch a task keeps past its handler ends with the invocation

Package, `packages/kernel/test/documents.test.ts`:

- doc-watch: a watch gets each commit's change while it keeps up, a retirement, then the next incarnation whole
- doc-watch: closing the Session ends the watch's stream
- doc-watch: a watch whose scope ends completes its stream, also for a consumer outside the scope
- view-slow-folding: a stalled watch neither slows commits nor grows, and resumes with one root replacement

## Gotchas

- The TUI keeps every entry it saw for as long as it runs; only a fresh TUI opens on the newest 50.
