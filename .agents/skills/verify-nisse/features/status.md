# Status and chosen ids

A client can follow every conversation people started without reading its
transcript: `status/watch` lists the trees that are busy, then reports each
commit that changes a tree's status or ends its root's run, with how that run
ended and what the model said last. A client that was not watching when a run
ended reads the same from the conversation's `ended`. A client can also choose
a new conversation's id, and starting with an id that exists answers with that
conversation. attn uses these to run Nisse sessions.

## Sub-features

- `status-snapshot` opens with every tree that is not idle; the rest are idle.
- `status-follow` reports `working`, `waiting` and `idle` for each tree, in
  `seq` order.
- `status-subagent` shows a subagent waiting on a person as its whole tree
  `waiting`.
- `status-ended` carries the outcome of the root's run and its last message.
- `conversation-ended` shows how a conversation's last run ended, as `ended`
  on it in `conversation/list`, also after a restart; a conversation that
  never ran has none.
- `start-with-id` starts a conversation with a chosen id, and answers a second
  start with that id with the first conversation.

## How to get to it

### People

None.

### Agents

- Call `status/watch`, a stream.
- Call `conversation/start` with `id`.
- Call `conversation/list`.

## Driving it with drive.ts

Preconditions:

- A fresh run, here `r`, with `--script` steps that spawn a subagent which writes a file (put your run id where the path says `<run>`):
  `[{"tool": {"name": "spawn_agent", "input": {"task_name": "writer", "message": "go"}}}, {"tool": {"name": "wait_agent", "input": {"timeout_ms": 600000}}}, {"agent": "/root/writer", "tool": {"name": "write", "input": {"path": "/tmp/nisse-verify/<run>/note.txt", "content": "hi"}}}]`.

- **Chosen id.** Run
  `drive.ts r rpc conversation/start '{"id": "11111111-1111-4111-8111-111111111111", "cwd": "/tmp"}'`,
  then the same call with `"cwd": "/elsewhere"`. Both answer
  `"conversation": "11111111-1111-4111-8111-111111111111"`, and
  `conversation/list` shows it once, with `cwd` `/tmp`. After
  `drive.ts r kill-server` and `drive.ts r serve` the same call answers the
  same conversation. An all-digit id such as `"42"` is refused by name.
- **Follow.** In one shell run
  `drive.ts r watch-status 11111111-1111-4111-8111-111111111111 --until waiting --save status`.
  In another, run
  `drive.ts r rpc conversation/submit '{"conversation": "11111111-1111-4111-8111-111111111111", "requestId": "s1", "author": "ada", "text": "write a note"}'`.
  The watch opens with the trees that are busy, none here, then prints the
  tree `working`, then `waiting` once the subagent asks.
- **Snapshot.** While it waits, run `drive.ts r watch-status`: its first line
  lists the tree as `waiting`. It returns after a second with no change.
- **Ended.** Run
  `drive.ts r rpc conversation/interrupt '{"conversation": "11111111-1111-4111-8111-111111111111"}'`
  while `drive.ts r watch-status 11111111-1111-4111-8111-111111111111 --until idle`
  runs. Interrupting stops the subagent too, and the last line is `idle`
  with `"ended":{"outcome":"interrupted","message":"aborted"}`. Between
  `waiting` and `idle` the tree may report `working` once: the subagent's
  call settles and its approval request goes in one commit, while both runs
  still have to commit their ends.
- **Ended, read later.** Then run `drive.ts r rpc conversation/list`: the
  conversation carries `"ended":{"outcome":"interrupted","message":"aborted"}`,
  with `said` when the model wrote a message.

## Contexts

- **Subagents.** A subagent waiting on a person shows its whole tree as waiting.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- start-with-id: starting a conversation with an id it already has answers with that conversation, and an all-digit id is refused by name
- start-with-id: a chosen id that names an object property, such as toString, opens its own conversation
- approval-restart, status-snapshot: a call waiting for approval across a restart, whose hook computes other arguments on the rerun, asks again with them
- status-follow, status-ended: watching status follows each run of a tree and says how it ended
- status-subagent, status-snapshot: a subagent waiting on a person shows as its whole tree waiting, to watchers then and later
- conversation-ended: conversation/list tells a client that was not watching how a conversation's last run ended, also after a restart

Screen, `packages/nisse/test/screen.test.ts`:

- start-with-id: a launcher opens nisse on an id it chose with a first prompt, and that id reopens the conversation

Stack, `packages/nisse/test/stack.test.ts`:

- crash-limit, conversation-ended: a run that keeps crashing the server stops after three tries instead of looping, and the conversation list says why
- start-with-id: a conversation opened on a client's id survives a restart, and a second start with it is answered

## Gotchas

- Replace `r` in the commands with your run id. `watch` and `watch-status`
  wait for their `--until`, so start the first of two in the background or a
  second shell, and run `drive.ts r serve` before either.

- A tree's status changes only when the commit changes it; a subagent that
  starts working inside a working tree reports nothing.
- An interrupted tree can report `working` after `waiting` and before
  `idle`. That is the committed state while its runs wind down, not a stale
  status.
- In `status/watch`, `ended` belongs to the root's own run. A subagent's run
  ending never carries it there.
