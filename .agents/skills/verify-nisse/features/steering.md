# Steering

A person redirects Nisse mid-run without stopping it. While Nisse works, `Tab`
switches the prompt from queueing to steering; a steering prompt shows as
`steering · <text>` and reaches the model at its next step, inside the same
run, instead of waiting for the run to end.

## Sub-features

- `steer-toggle` switches the prompt panel between `QUEUE · tab` and
  `STEER · tab` with `Tab` while Nisse works.
- `steer-show` shows a waiting steer as `steering · <text>`, to every client.
- `steer-place` places the steer after the step that was running and goes on
  in the same run.
- `steer-wire` steers with `conversation/submit` and `"steer": true`.
- `steer-claude` hands a steer to Claude Code as its next message in the same
  run, after each call's result, and again for a second steer.
- `steer-openai` places a steer after the last of a step's calls, before the
  model's next answer.

## How to get to it (user POV)

- Press `Tab` in the TUI while it shows `WORKING`, type, and press Enter.
- Call `conversation/submit` with `"steer": true` while a run works.
- The same on a ChatGPT or Claude conversation, while it works or waits for
  you to answer a call.

## Driving it with drive.ts

Preconditions:

- A run whose script is
  `[{"text": "slow one two three four five six seven eight", "delayMs": 500, "tool": {"name": "Read", "input": {"file_path": "/etc/hostname"}}}, {"text": "steered reply"}]`.

- **Steer.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type first`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'QUEUE · tab'`, `drive.ts r tui key Tab`,
  `drive.ts r tui wait 'STEER · tab'`, `drive.ts r tui type 'go left'`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'steering · go left'`,
  `drive.ts r tui screen steering`. `WORKING`, the slow text streaming,
  `steering · go left`, and the `STEER · tab` panel.
- **Placed.** Run `drive.ts r tui wait --timeout 20000 'steered reply'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen steered`. Under `NISSE`
  the slow text and `▸ Read(/etc/hostname)`, then `ADA` over `go left`, then
  `NISSE` over `steered reply`.
- **Committed.** Run `drive.ts r rpc conversation/list` for the `<id>` and
  `drive.ts r watch <id> --save steered`. The snapshot's entries run `user`
  `first`, `message`, `tool_call`, `tool_result`, `user` `go left`,
  `message` `steered reply`, and one `run_end`: one run, not two.
- **Wire.** In a fresh run with the same script, run `drive.ts r serve`, start
  a conversation with `rpc conversation/start '{"cwd": "/tmp"}'`, and run
  `drive.ts r watch <id> --submit first --until run_end --timeout 20000 --save wire &`.
  Once a commit's `live` holds a `text` change, run
  `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "steer-1", "author": "bo", "text": "go left", "steer": true}'`.
  The watch shows an `enqueued` commit with `"steer": true` and author `bo`,
  then the same entries as above (the steer's `user` entry is authored by
  `bo`), ending in one `run_end`.

- **Claude.** In a fresh run made with `drive.ts r up --fake-claude steer`,
  run `drive.ts r tui start --provider claude`, `drive.ts r tui wait READY`,
  type
  ``Run the bash command `touch steered.txt` with the Bash tool, then reply with exactly: done``
  and `Enter`, and `drive.ts r tui wait 'allow this call?'`. Press `Tab`,
  `drive.ts r tui wait 'STEER · tab'`, type
  `Also end your reply with the word BANANA.` and `Enter`, then
  `drive.ts r tui wait 'steering · Also'` and `drive.ts r tui screen steering`:
  `▸ Bash(touch steered.txt)` asking, `steering · Also end your reply with the word BANANA.`
  and `WAITING`. Press `C-y` and wait for `READY`. The screen shows
  `✓ allowed by ada`, `ADA` over the steer, then `NISSE` over `done` and
  `done BANANA`. `drive.ts r watch <id> --save steered` has one `run_end`,
  the steer's `user` entry after the `tool_result`, and `ended` saying
  `answered` with `said` `done BANANA`. In `evidence/fake-claude/log.ndjson`
  the steer is a second `user` frame sent to `"spawn": 0`, the process of the
  first prompt, with `"priority":"next"`; the first prompt's frame has none,
  and there is no `"spawn": 1`.
- **Claude, two steers** (`two_steers`). In a fresh run made with
  `--fake-claude two_steers`, start the TUI as above and type
  ``Run the bash command `touch one.txt` with the Bash tool, then, as a separate call, run `touch two.txt` with the Bash tool, then reply with exactly: done``.
  At `allow this call?` for `touch one.txt`, press `Tab`, type
  `Also end your reply with the word BANANA.` and `Enter`, wait for
  `steering · Also`, and press `C-y`. Wait for `Bash(touch two.txt)` and
  `allow this call?`: the panel is still `STEER · tab`, so type
  `And start your reply with the word CHERRY.` and `Enter`, wait for
  `steering · And`, and press `C-y`. Wait for `READY` and run
  `drive.ts r tui screen two-steers`: each steer's `ADA` entry follows the
  result of the call that was running when it was sent, then `NISSE` answers
  `done` and `BANANA`, then `CHERRY`, `done` and `BANANA`. `watch <id>` has one
  `run_end` and both steers' `user` entries before the answer. The log has both
  steers as `"priority":"next"` frames to `"spawn": 0`. The recording ends
  with a third prompt, `Reply with exactly: still here`, that Claude Code
  answered in the same process; Nisse starts a new Claude Code for every run,
  so typing it stalls and fails this step today. Stop after the answer, and
  press `Escape` if you typed it.
- **Claude, between parallel calls** (`steer_mid_message`). In a fresh run made
  with `--fake-claude steer_mid_message`, write this extension as is to
  `/tmp/nisse-verify/r/home/extensions/guard.ts` (`mkdir -p` the folder
  first), before the TUI starts the server. It refuses a read of `a.txt` and
  holds a read of `b.txt` for ten seconds, which leaves time to steer between
  the two results:

  ```ts
  import { Extension, Tool } from "@nisse/extension"
  import { Effect } from "effect"

  export default Extension.define((ctx) =>
    ctx.tool.hook("execute.before", (call) =>
      Effect.gen(function* () {
        const path = String((call.input as { file_path?: string }).file_path)
        if (path.endsWith("a.txt")) return yield* Tool.refuse("a.txt is off limits")
        if (path.endsWith("b.txt")) yield* Effect.sleep("10 seconds")
      }),
    ),
  )
  ```

  Start the TUI as above and type
  `In a single message, call the Read tool twice in parallel: once on a.txt and once on b.txt. Then reply with both contents, separated by a comma.`.
  Wait for `guard refused this call`, press `Tab`, type
  `Also end your reply with the word BANANA.` and `Enter`, and wait
  `--timeout 25000` for `b.txt holds banana. BANANA`. The screen shows
  `▸ Read(.../a.txt)` with `guard refused this call: a.txt is off limits`,
  `▸ Read(.../b.txt)` with `banana`, the steer's `ADA` entry, then `NISSE`
  answering `a.txt was off limits; b.txt holds banana.` and
  `b.txt holds banana. BANANA`. The log holds the steer as one `"priority":"next"`
  frame to `"spawn": 0`, and `watch <id>` has one
  `run_end`. The recording's hook answer says `guard: a.txt is off limits`
  where the log says `guard refused this call: a.txt is off limits`.
  Type the steer inside the ten seconds. A steer typed once `banana` shows
  has no call result left to travel with (see Gotchas): the recording waits
  for it, and the run stalls at `WORKING` with `steering · Also` showing.

- **OpenAI** (`steer_after_parallel_calls`). In a fresh run made with
  `drive.ts r up --fake-openai steer_after_parallel_calls`, run
  `drive.ts r tui start --provider openai`, wait for `READY`, type
  `echo one and two` and `Enter`, and wait for `allow this call?` on
  `▸ Bash(echo one)`. Press `Tab`, type `and three`, `Enter`, wait for
  `steering · and three`, and press `C-y`. Wait for `Bash(echo two)` and
  `allow this call?`: the steer is still `steering · and three`. Press `C-y`
  and wait for `READY`. The screen shows both calls allowed with `one` and
  `two`, `ADA` over `and three`, and `NISSE` over `One, two, and three.`.
  `watch <id>` has `user` `echo one and two`, both calls, `approval`,
  `approval_answer` and `tool_result` entries, `user` `and three`, the
  `message` and one `run_end`. Both entries of
  `evidence/fake-openai.ndjson` are `as recorded`: the second request holds
  both calls' outputs and then `and three`, and the first holds no steer.

## Gotchas

- A steer is placed when the model takes its next step, after the running
  call: the script's next step, or ChatGPT's next request. A run that ends
  before then runs the steer next, like a queued prompt.
- Replace `r` in the commands with your run id.
- On Claude, today, a steer reaches Claude Code only with a call result that
  arrives after it is sent. A steer sent after the run's last result waits in
  `steering · <text>` until the run ends, and then runs next like a queued
  prompt; pressing `Escape` on the stalled `steer_mid_message` run shows it
  start a run of its own. What a real Claude Code does meanwhile is checked
  in With a real account.
- The Claude and OpenAI steps hold the run at an approval or a hook so that
  the steer lands inside the run; the fakes wait for a steer the recording
  has, whatever the timing, so a steer sent late stalls the run.
- `Tab` does nothing while Nisse is ready; the panel then reads `PROMPT`.

## With a real account

What the recordings do not show is a real model acting on a steer. Follow
SKILL.md's "Real accounts" first, and run the first check before any step.

- **Claude.** Start with `drive.ts r up --real-claude`. Run
  `drive.ts r tui start --provider claude`, wait for `READY`, and type
  ``Run the bash command `touch /tmp/nisse-verify/r/steered.txt` with the Bash tool, then reply with exactly: done``.
  At `allow this call?` press `Tab`, type
  `Also end your reply with the word BANANA.` and `Enter`, then press `C-y`.
  Wait `--timeout 120000` for `READY`. The final `message` ends with
  `BANANA`, the steer's `user` entry sits between the `tool_result` and the
  `message` in `drive.ts r watch <id> --save real-claude-steer`, and the
  conversation has one `run_end`. `ls /tmp/nisse-verify/r/steered.txt` shows
  the file. Needs no person once Claude Code is signed in.
- **Claude, a steer after the last result.** In the same run, after
  `drive.ts r tui stop`, run `drive.ts r tui start --provider claude --auto`,
  wait for `READY`, and type
  ``Run `echo hi` with the Bash tool, then write a 300-word story about a gnome.``
  and `Enter`. Once `▸ Bash(echo hi)` shows `hi` and the status is still
  `WORKING`, press `Tab`, type `Now reply with exactly: BANANA` and `Enter`,
  and wait `--timeout 120000` for `READY`. Today's behaviour, which this
  checks: the story ends the first run, the steer's `user` entry follows that
  run's `run_end`, and a second run answers `BANANA`; `drive.ts r watch <id> --save real-claude-late-steer` shows two `run_end`s. Report what the screen and
  the watch show if they differ: a steer folded into the story, a steer that
  never runs, or a run that does not end.
- **ChatGPT.** Start with `drive.ts r up --openai-auth <file>`. Run
  `drive.ts r tui start --provider openai`, wait for `READY`, and type
  ``Run `echo one` and then `echo two` with the Bash tool, one call at a time, then say what they printed.``.
  At the first `allow this call?` press `Tab`, type
  `Also end your answer with the word BANANA.` and `Enter`, then press `C-y`
  at each call that follows. Wait `--timeout 120000` for `READY`. The final
  `message` ends with `BANANA`, and `watch` shows one `run_end` with the
  steer's `user` entry after the first `tool_result` and before the
  `message`. Needs no person once the sign-in is kept.
