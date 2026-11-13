# Compaction

Long conversations keep working: older context becomes a summary, automatically
or on demand, and the raw history stays. `/compact [instructions]` in the TUI
or `conversation/compact` summarizes the context now: every TUI shows
`◆ compacting` in its status bar while it runs, then `◆ compacted the context`
in the transcript. A context still within what a summary keeps answers
`nothing to compact: the context is short enough already`, and a failed
compaction shows `✗ compaction failed: <why>` above the prompt, its cause named
once.

A Claude conversation compacts the same way, from the same command and call:
Claude Code runs its loop, so sigma sends it `/compact [instructions]` as the
conversation's input, named for whoever asked, and Claude Code writes the
summary that becomes the `◆ compacted the context` entry. Behind a run in
flight that input queues, and the call answers once its run ends. The idle
compaction (`claude-idle-compaction`) sends the same input by `sigma`, and
skips a conversation that is busy again.

## Sub-features

- `compaction-manual` [kernel] Manual compact (R606-657, §8.7): Shrink context on demand
- `compact-rpc` The client path for Manual compact (R606-657, §8.7): Shrink context on demand
- `compaction-blocking` [kernel] Automatic compaction at a threshold, blocking the next request (§8.7): A long conversation keeps working
- `compaction-background` [kernel] Background compaction (§8.7, default 32768 tokens): The summary is ready before it is needed, so no pause
- `compaction-overflow` [kernel] Overflow retry: compact on a context-limit error and retry (§8.3, §8.7): A surprise overflow does not fail the run
- `compaction-policy` [kernel] Policy settings: reserve 16384, keepRecent 20000 (§8.7): Tune when and how much to compact
- `compaction-per-model` [kernel] Per-model overrides (R606-657): Different models get different policies
- `compaction-per-conversation` [kernel] Per-conversation compaction settings, inherited by children and forks (Unreleased): One conversation turns compaction off or tunes it
- `compaction-range` [kernel] Range selection that never splits a tool round (§8.7): The summary never orphans a call from its result
- `compaction-summary-prompt` [kernel] Summary prompts and summary model (§8.7): Control what a summary keeps and what it costs
- `compaction-recorded` [kernel] Compaction recorded in the transcript with placement (§8.1, §8.7): People see where and why context was compacted
- `compaction-hook` [kernel] `beforeCompact` hook (§7.2): An extension cancels or customizes a compaction
- `compaction-usage` [kernel] Compaction usage is counted (§8.6, §8.7): Totals include what summaries cost
- `compaction-stale` [kernel] Stale ordering: late background results are discarded or placed correctly (§8.7): A slow summary cannot rewrite newer context
- `compaction-live-status` Live compaction status and last failure (§8.2): People see "compacting" and why one failed
- `compaction-abort` [kernel] Cancelling a compaction without losing the run (§8.7): Esc during a summary behaves predictably
- `compaction-blocking-failure` [kernel] A failed blocking compaction fails the generation without a request; a declined or empty one lets the request go ahead.

## How to get to it

### People

- Type `/compact` or `/compact <instructions>` in the TUI's prompt and press `⏎`.

### Agents

- Call `conversation/compact` with `conversation`, `author` and optional `instructions`; it answers once the compaction ends, with `outcome` `compacted`, `nothing_to_compact`, `failed` (with a `message`) or `stopped`. On Claude, `compacted` means the `/compact` run committed a `pi.compaction` entry, `nothing_to_compact` that it answered without one, and `stopped` that the input was withdrawn or its run stopped.

### Triggers

- A context past its threshold compacts on its own before the next request, and a provider's context-window error compacts and sends the request again.
- A Claude conversation past 200,000 tokens compacts while idle, two minutes before its prompt cache expires: `claude-idle-compaction` in [Claude](./claude.md).

## Driving it with drive.ts

Preconditions:

- A fresh run whose script is
  `[{"text": "answer one"}, {"text": "answer two"}, {"text": "the summary of it all", "delayMs": 2000}, {"text": "answer three"}, {"fail": "the summary model is gone"}]`,
  `drive.ts r up --script s.json`. The third step is the summary; its delay
  keeps `◆ compacting` on screen long enough to see.
- A summary keeps the newest 20,000 tokens as they are, so a context only
  compacts once it is past that. Send the long turns over the wire: set
  `LONG=$(python3 -c 'print("word "*20000)')`, 100,000 characters, and submit
  with `drive.ts r rpc conversation/submit "{\"conversation\": \"talk\", \"requestId\": \"long-1\", \"author\": \"ada\", \"text\": \"$LONG\"}"`,
  a new `requestId` each time.

- **Nothing to compact.** Run `drive.ts r tui start --conversation talk`,
  `drive.ts r tui wait READY`, type `/compact` and `Enter`, and
  `drive.ts r tui wait 'nothing to compact'`: above the prompt,
  `◆ nothing to compact: the context is short enough already`.
- **Compact from the TUI.** Submit the long text twice, waiting for
  `answer one`, then `answer two`, and `READY` after each. Start, in the background,
  `drive.ts r watch talk --until pi.compaction --timeout 30000 --save compaction`.
  Type `/compact keep the numbers` and `Enter`, then
  `drive.ts r tui wait '◆ compacting'`: the status bar reads
  `■ READY  ◆ compacting`. `drive.ts r tui wait 'compacted the context'`:
  `◆ compacted the context` under `answer two`, and the status bar back to
  `■ READY`. The watch saw `pi.live` `compactions` set to
  `[{"trigger": "manual", ...}]`, then cleared in the commit that placed a
  `pi.compaction` entry with `{"reason": "manual"}`.
  `drive.ts r rpc conversation/context '{"conversation": "talk"}'` answers the
  summary (`The conversation history before this point was compacted ...`),
  then the second long prompt and `answer two`: the first exchange is gone
  from the context and still on the screen.
- **A failed compaction.** Submit the long text a third time and wait for
  `answer three` and `READY`. Run
  `drive.ts r rpc conversation/compact '{"conversation": "talk", "author": "ada", "instructions": "keep the numbers"}'`:
  `"outcome": "failed", "message": "Summarization failed: the summary model is gone"`,
  and the TUI shows
  `✗ compaction failed: the summary model is gone` above the prompt: the
  harness's `Summarization failed:` is not repeated under it. It stays there after the next run and in a TUI opened
  anew.

- **Compact a Claude conversation.** In a fresh run,
  `drive.ts r up --fake-claude idle_compaction`, then
  `drive.ts r tui start --provider claude --conversation talk`,
  `drive.ts r tui wait READY`. Type `Reply with exactly: one`, `Enter`, wait
  for `READY`; the same with `Reply with exactly: two`. Type `/compact` and
  `Enter`, `drive.ts r tui wait 'compacted the context'`: `/compact` under
  `ADA`, then `◆ compacted the context`. The fake's log shows `/compact` as
  the process's third user message. Over the wire, in another fresh run with
  the same recording, `conversation/start` `talk` with `"provider": "claude"`,
  submit the two prompts, then
  `drive.ts r rpc conversation/compact '{"conversation": "talk", "author": "ada", "instructions": "keep the numbers"}'`:
  `"outcome": "compacted"`, the log's third user message is
  `/compact keep the numbers`, and the transcript holds that `sigma.user` by
  `ada`, then a `pi.compaction`.

## Contexts

- **Second client.** The failure line is the conversation's state, not the
  asking client's: a compaction asked for over the wire shows its failure in
  the TUI.

## Sources

Feature ledger area E: spec §8.1, §8.2, §8.7, §7.2; README Compaction; example 24-compaction.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- compact-rpc, compaction-live-status: compacting shows live, then a summary replaces the context; a failed one says why

Screen, `packages/sigma/test/screen.test.ts`:

- compact-rpc, compaction-live-status: /compact says when there is nothing to compact, shows a compaction running, and why one failed

Provider, `packages/sigma/test/claude.test.ts`:

- compact-rpc, claude-compact: conversation/compact compacts a Claude conversation by sending Claude Code /compact with the instructions, and answers once it has

Screen, `packages/sigma/test/screen.test.ts`, on the fake `claude`:

- compact-rpc, claude-compact: /compact in a Claude conversation sends Claude Code /compact as the person's input, and shows the compaction

Provider, `packages/sigma/test/openai.test.ts`:

- compaction-overflow, models-overflow: ChatGPT's context-window error compacts the conversation, and the request goes again

## Gotchas

- The scripted model writes the summary too: a compaction takes the next
  script step, and a step with `fail` fails the compaction, not a run.
- `tui type` of 100,000 characters is slow; submit long turns with `rpc`.
- While the summary is written the TUI shows `◆ compacting` twice: in the
  status bar and as the notice above the prompt.
