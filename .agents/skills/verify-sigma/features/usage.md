# Usage and cost

Tokens and cost are counted per conversation, model and tool, and totalled for
the home. The TUI's status bar shows `<n> tokens · context <n>` on the right:
what the conversation spent and how full its context is after the newest
answer. `/usage` opens a `USAGE` panel with this conversation's tokens and
every conversation's, by model, with the input the provider read from its
prompt cache apart, in [Prompt cache](./prompt-cache.md); `usage/get` answers
the same ledger.

## Sub-features

- `usage-conversation` [kernel] `pi.usage` per conversation (§8.6, R855-861): See tokens used by a conversation
- `usage-rpc` The client path for `pi.usage` per conversation (§8.6, R855-861): See tokens used by a conversation
- `usage-per-model` Per-model breakdown (§8.6): Know which model spent what
- `usage-per-tool` [kernel] Per-tool usage (§8.6): Attribute spend to a tool
- `usage-total` `Harness.usage` totals (R855-861): One number across the home
- `usage-cost` [kernel] Cost in currency (§8.6): See money spent
- `usage-context-live` Context used, for live display (§8.2): People see how full the context is

## How to get to it

### People

- Read the status bar once a conversation has spent tokens.
- Type `/usage` in the TUI's prompt and press `⏎`; `esc` closes the panel.

### Agents

- Call `usage/get` with `{"conversation": "<id>"}` for one conversation, or `{}` for the home's total.
- Watch a conversation: its view's `pi.usage` document holds the same ledger.

## Driving it with drive.ts

Preconditions:

- A fresh run whose script reports usage,
  `[{"text": "answer one", "usage": {"input": 1200, "output": 300}}, {"text": "answer two", "usage": {"input": 2000, "output": 500}}, {"text": "answer three", "usage": {"input": 50, "output": 5}}]`,
  `drive.ts r up --script s.json`, then
  `drive.ts r tui start --conversation talk` and `drive.ts r tui wait READY`:
  the status bar shows no tokens yet.

- **Live count.** Send `one` and `drive.ts r tui wait '1.5k tokens'`: the
  status bar reads `1.5k tokens · context 1.5k`. Send `two` and
  `drive.ts r tui wait '4.0k tokens'`: `4.0k tokens · context 2.5k`, the
  total growing and the context the newest request's.
- **Another conversation.** `drive.ts r sigma exec three`: stdout
  `answer three`, in a conversation of its own.
- **The panel.** Type `/usage` and `Enter`, `drive.ts r tui wait USAGE`:
  `this conversation: 4.0k tokens` over `script/script  4.0k (3.2k in, 0 cached, 800 out)`,
  then `every conversation: 4.1k tokens` over
  `script/script  4.1k (3.3k in, 0 cached, 805 out)`. `drive.ts r tui key Escape` and
  `drive.ts r tui wait --gone USAGE`: the transcript is back.
- **Over the wire.** `drive.ts r rpc usage/get '{"conversation": "talk"}'`:
  `"models": {"script/script": {"input": 3200, "output": 800, ..., "totalTokens": 4000, "cost": {...}}}, "tools": {}`.
  `drive.ts r rpc usage/get '{}'`: `input` 3250, `output` 805,
  `totalTokens` 4055. `{"conversation": "nope"}` fails `NoSuchConversation`.

## Contexts

- **Provider.** The scripted model spends nothing unless its step names
  `usage`; ChatGPT and Claude Code report their own.

## Sources

Feature ledger area U: spec §8.2, §8.6; README Usage and Cost.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- usage-rpc, usage-per-model, usage-total: a client reads the tokens each conversation spent, by model, and the home's total

Screen, `packages/sigma/test/screen.test.ts`:

- usage-rpc, usage-context-live: the status bar counts tokens and the context, and /usage lists them by model

## Gotchas

- `usage/get` and `/usage` work on a read-only server too.
- A script step's `usage` takes `cacheRead` and `cacheWrite` beside `input`
  and `output`, as [Prompt cache](./prompt-cache.md) drives.
- `cost` is an estimate in US dollars, 0 for the scripted model and on a subscription.
