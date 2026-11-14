# Context the model sees

What the model sees is derived from the recorded entries by written rules, so it can be worked out exactly and edited without touching history.

## Sub-features

- `context-derived` [kernel] Context derived from entries by written rules (§2.1, rules 1-10): What the model saw can be worked out exactly from the record
- `context-omit` [kernel] Context edit: omit an entry (§2.1): Hide a large or wrong entry from the model while it stays in the transcript
- `context-replace` [kernel] Context edit: replace an entry (§2.1): Swap in a shortened version for the model
- `context-head` [kernel] Head markers (§2.1): Context starts at a chosen point after reset or compaction, and history stays readable
- `context-synthesized-results` [kernel] Synthesize missing tool results (§2.1): A crash never leaves the provider an unanswered call
- `context-at-entry` [kernel] `Conversation.context(at)` (§2.2): Inspect the exact context at any entry
- `context-rpc` The client path for `Conversation.context(at)` (§2.2): Inspect the exact context at any entry
- `entries-paged` [kernel] Entries read with paging (§2.2): Read part of a long transcript
- `entries-rpc` The client path for Entries read with paging (§2.2): Read part of a long transcript
- `context-stale-head` [kernel] Stale head check (§6): An input aimed at a context that has moved is settled, not misapplied

## How to get to it

### People

None yet.

### Agents

- Call `conversation/context` with `conversation` and an optional entry `at`:
  the `messages` the model is sent, and the `entries` they come from.
- Call `conversation/entries` with `conversation`, `limit`, and optionally
  `from`, `to`, `order` and the `cursor` a page answered as `next`.

## Driving it with drive.ts

Preconditions:

- `drive.ts r up --script <file>` with the script
  `[{"text": "a"}, {"text": "b"}, {"text": "c"}]`, then `drive.ts r serve`.

- **Fill a transcript.** Run `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp"}'`, then
  `drive.ts r watch <id> --submit one --until run_end`, the same with `two` and `three`, and
  `drive.ts r watch <id> --save full`: nine or more entries.
- **Page through it** (`entries-rpc`). Run
  `drive.ts r rpc conversation/entries '{"conversation": "<id>", "limit": 4}'`: the four newest entries, newest
  first, and a `next`. Pass that `next` as `"cursor"` until a page has no `next`: together the pages hold every entry
  of `full`. `drive.ts r rpc conversation/entries '{"conversation": "<id>", "from": <the user entry "two">, "order": "ascending", "limit": 3}'`
  answers `two`, `b` and its `sigma.run_end`. `"limit": 0` is refused naming `limit`.
- **Read the context** (`context-rpc`). Run
  `drive.ts r rpc conversation/context '{"conversation": "<id>"}'`: `messages` alternate `user` and `assistant`
  through `c`, after any `system` message. With `"at": <the pi.assistant entry "a">` they end at `a`, and `entries`
  ends at that entry. An `at` from another conversation answers `NoSuchEntry`.

## Sources

Feature ledger area B: spec §2.1, §2.2, §6; examples 08-context, 13-chat, 20-late-join.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- entries-rpc: a client reads a long transcript a page at a time, newest first or in order from an entry
- context-rpc: a client reads the exact context the model is sent, now or as it was at an entry

Package, `packages/harness/test/context.test.ts`:

- context-synthesized-results: ${name}

## Gotchas

None recorded yet.
