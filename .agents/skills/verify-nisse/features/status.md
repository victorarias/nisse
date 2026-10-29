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
  on it in `conversation/list`, on a start with an existing id and in a
  subscription's snapshot; a conversation that never ran has none.
- `start-with-id` starts a conversation with a chosen id, and answers a second
  start with that id with the first conversation.

## How to get to it (user POV)

- Call `status/watch`, a stream.
- Call `conversation/start` with `id`.
- Call `conversation/list`.

## Driving it with drive.ts

Preconditions:

- A fresh run, here `r`, with `--script` steps that spawn a subagent which writes a file (put your run id where the path says `<run>`):
  `[{"tool": {"name": "spawn_agent", "input": {"task_name": "writer", "message": "go"}}}, {"tool": {"name": "wait_agent", "input": {"timeout_ms": 600000}}}, {"agent": "/root/writer", "tool": {"name": "Write", "input": {"file_path": "/tmp/nisse-verify/<run>/note.txt", "content": "hi"}}}]`.

- **Chosen id.** Run
  `drive.ts r rpc conversation/start '{"id": "11111111-1111-4111-8111-111111111111", "cwd": "/tmp"}'`,
  then the same call with `"cwd": "/elsewhere"`. Both answer with the same
  conversation, whose `cwd` is `/tmp`.
- **Follow.** In one shell run
  `drive.ts r watch-status 11111111-1111-4111-8111-111111111111 --until waiting --save status`.
  In another, run
  `drive.ts r watch 11111111-1111-4111-8111-111111111111 --submit "write a note" --until subagent`.
  The first opens with `{"_tag":"trees","seq":0,"trees":[]}`, then prints
  the tree `working`, then `waiting` once the subagent asks. The second ends
  after the parent calls `wait_agent`.
- **Snapshot.** While it waits, run `drive.ts r watch-status`: its first line
  lists the tree as `waiting`. Stop it with `^C`, or add `--until waiting`.
- **Ended.** Run
  `drive.ts r rpc conversation/interrupt '{"conversation": "11111111-1111-4111-8111-111111111111"}'`
  while `drive.ts r watch-status 11111111-1111-4111-8111-111111111111 --until idle`
  runs. One line, still `waiting`, carries `"ended":{"outcome":"interrupted"}`,
  the last is `idle`, and none in between is `working`.
- **Ended, read later.** Then run `drive.ts r rpc conversation/list`: the
  conversation carries `"ended":{"outcome":"interrupted"}`, with `said` when
  the model wrote a message.

## Gotchas

- Replace `r` in the commands with your run id. `watch` and `watch-status`
  wait for their `--until`, so start the first of two in the background or a
  second shell, and run `drive.ts r serve` before either.

- A tree's status changes only when the commit changes it; a subagent that
  starts working inside a working tree reports nothing.
- In `status/watch`, `ended` belongs to the root's own run. A subagent's run
  ending never carries it there.
