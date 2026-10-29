# Claude

A conversation started with `--provider claude` is answered by Claude Code
through the Claude Agent SDK, with Claude Code's own tools and session. Nisse
shows Claude's calls under `NISSE`, asks a person before the calls Claude Code
would ask about, resumes Claude Code's session where nisse's transcript ends,
and after a crash tells Claude which calls were cut off. When Claude Code has
lost the session, or a conversation is switched to Claude from another
provider, nisse retells the conversation to a new Claude Code session. Claude
Code gets the conversation's model and effort, and a switch between Claude's
models goes on in the same session. Nisse asks Claude Code how it is signed in
and which models it offers without asking Claude anything. A Claude Code that
cannot sign in ends the run failed with Claude Code's own message.

## Sub-features

- `claude-answer` streams Claude's answer and commits it as a `message`.
- `claude-approval` turns a Claude Code permission prompt into
  `allow this call?`; `^Y` lets the call run, `^N` refuses it.
- `claude-read` shows a call Claude Code allows on its own, such as a `Read`,
  with its result and no `allow this call?`.
- `claude-exec-deny` makes `exec` refuse Claude's calls that would ask, unless
  `--auto`.
- `claude-auto` lets every call run in a conversation started with `--auto`.
- `claude-resume` continues Claude Code's session in each new run, also after
  the server restarted.
- `claude-session-gone` retells the conversation to a new Claude Code session
  when Claude Code no longer has the old one, and the run answers as usual.
- `claude-cut-off` records a call the server's crash cut off as interrupted,
  and Claude answers knowing it was.
- `claude-sign-in-error` ends the run failed with Claude Code's message, exit
  1 from `exec`.
- `claude-health` lists Claude as `ready` with its account and version, and
  its models, from Claude Code itself.
- `claude-system-prompt` keeps Claude Code's own system prompt and appends the
  conversation's start instructions to it; Claude Code's commands see
  `NISSE_ROOT_CONVERSATION`.
- `claude-model` hands Claude Code the conversation's model and effort; after
  a switch to another Claude model, the next run resumes the same session on
  the new model and effort.
- `claude-switch` retells a conversation switched to Claude to a new Claude
  Code session: the first prompt, then as many of the latest entries as fit in
  about 64,000 characters, with `(N entries left out here)` between them.
- `claude-sign-in` runs `claude auth login`, in [Sign-in](./sign-in.md).

## How to get to it (user POV)

- Run `nisse --provider claude`, or `nisse` with no `NISSE_MODEL_SCRIPT`.
- Run `nisse exec --provider claude '<prompt>'`, with `--auto` to allow calls,
  and `--model` and `--effort` to choose the model.
- Call `conversation/start` with `"provider": "claude"`.
- Switch a conversation to Claude, or to another Claude model, with `/model` or
  `conversation/select_model`.

## Driving it with drive.ts

Preconditions:

- Each journey is its own fresh run, `drive.ts r up --fake-claude <fixture>`
  with the fixture it names, and `drive.ts r down` after it. The fake plays
  one recorded Claude Code process per spawn across the whole run, so a run
  holds one conversation's journey.
- Every conversation names `--provider claude`. Type the prompts exactly as
  written: they are what the recording's user typed.
- What nisse sent Claude Code is in
  `/tmp/nisse-verify/r/evidence/fake-claude/log.ndjson`: one `argv` line per
  spawn (`"spawn": N`) or probe (`"probe": N`), then what it received,
  with `"answered": "can_use_tool"` on a permission answer.
- Take a conversation's id from `drive.ts r rpc conversation/list`; `exec`
  prints only the answer.

- **Ask and allow** (`bash_allowed`). Run
  `drive.ts r tui start --provider claude`, `drive.ts r tui wait READY`,
  ``drive.ts r tui type 'Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made'``,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'allow this call?'`,
  `drive.ts r tui screen asking`: `▸ Bash(touch made.txt)`,
  `allow this call?  ^Y  allow  ^N  deny` and `◆ WAITING`. Run
  `drive.ts r tui key C-y`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen allowed`: `✓ allowed by ada`,
  `(Bash completed with no output)` and `made`. The log holds
  `"behavior":"allow"`. `drive.ts r tui stop` ends with
  `resume with: nisse --conversation <id>`.
- **Ask and deny** (`bash_declined`). The same with
  ``'Run the bash command `touch declined.txt` with the Bash tool. If it is not allowed, reply with exactly: declined'``
  and `C-n`, then `drive.ts r tui wait READY` and
  `drive.ts r tui screen denied`: `✗ denied by ada`, the recorded result
  `owner declined`, then `declined`. The log holds `"behavior":"deny"` with
  `"message":"the person did not allow this call"`.
- **Read without asking** (`read`). Run
  `drive.ts r tui start --provider claude`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'Use the Read tool to read notes.txt, then reply with where the gnome lives, in three words.'`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'Under the floor.'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen read`:
  `▸ Read(<checkout>/notes.txt)` over the recorded lines
  `1  the gnome lives under the floor`, then `Under the floor.`, and no
  `allow this call?` was ever shown. The log has no `"answered": "can_use_tool"`
  line. `drive.ts r watch <id> --save read` holds `tool_call`, `tool_result`,
  `message` and `run_end` `answered`. In a fresh run,
  `drive.ts r nisse exec --provider claude 'Use the Read tool to read notes.txt, then reply with where the gnome lives, in three words.'`
  exits 0 with stderr `› Read(<checkout>/notes.txt)` and no denial, stdout
  `Under the floor.`
- **Exec denies** (`bash_declined`). Run
  ``drive.ts r nisse exec --provider claude 'Run the bash command `touch declined.txt` with the Bash tool. If it is not allowed, reply with exactly: declined'``:
  exit 0, stderr `› Bash(touch declined.txt)` and
  `denied Bash(touch declined.txt): exec cannot ask, pass --auto to allow calls`,
  stdout `declined`, and the log's answer is a `deny`.
- **Auto** (`bash_allowed`). Run
  ``drive.ts r nisse exec --provider claude --auto 'Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made'``:
  exit 0, stderr `› Bash(touch made.txt)` with no denial, stdout `made`, and
  the log's answer is an `allow` nobody pressed.
- **Resume** (`died_while_idle`). Run
  `drive.ts r nisse exec --provider claude 'Remember the word PLUM. Reply with exactly: noted'`:
  stdout `noted`. Run `drive.ts r rpc server/stop`, `drive.ts r serve`, and
  take the id from `drive.ts r rpc conversation/list`. Run
  `drive.ts r nisse exec --conversation <id> 'Which word did I ask you to remember? Reply with that word only.'`:
  exit 0, stdout `PLUM`. The log's `"spawn": 1` argv has
  `--resume=<spawn 0's --session-id>` and `--resume-session-at=...`: the new
  server resumed Claude Code's session. `drive.ts r watch <id> --save resumed`
  shows both runs' `user`, `message` and `run_end` entries.
- **Session gone** (`session_gone`). Run
  `drive.ts r nisse exec --provider claude 'Remember the word PLUM. Reply with exactly: noted'`:
  stdout `noted`. Then
  `drive.ts r nisse exec --conversation <id> 'Which word did I ask you to remember? Reply with that word only.'`:
  exit 0, stdout `PLUM`. In the log, `"spawn": 1` has
  `--resume=<spawn 0's --session-id>`, which the recording answers
  `No conversation found with session ID`; `"spawn": 2` has a new
  `--session-id` and received one user message of four texts:
  `This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.`,
  `Remember the word PLUM. Reply with exactly: noted`, `You answered: noted`,
  and the question. `drive.ts r watch <id> --save gone` shows two runs, each
  ending `answered`, and no failure. Stop there: the recording's third prompt,
  `Now reply with that word in lowercase.`, was sent to the same Claude Code
  process, and nisse now starts a process per run, so sending it stalls.
- **Cut off** (`resume_after_kill`). Run
  `drive.ts r tui start --provider claude --auto`, `drive.ts r tui wait READY`,
  type
  ``Run the bash command `echo started > started.fifo && python3 -c 'import time; time.sleep(120)'` with the Bash tool. If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok``
  and `Enter`, then `drive.ts r tui wait 'Bash(echo started'`,
  `drive.ts r kill-server`, `drive.ts r tui wait 'may or may not'`,
  `drive.ts r tui wait READY`, `drive.ts r tui screen cut-off`: under the
  call, `interrupted; it may or may not have taken effect`, then
  `resumed ok`. The TUI started the new server. The log's `"spawn": 1`
  resumes the session and received
  `Your Bash call <call> was cut off: interrupted; it may or may not have taken effect`.
  `drive.ts r watch <id> --save cut-off` holds one `tool_call`, its
  `tool_result` with that output and `"error": true`, a `message` and a
  `run_end` with `"outcome": "answered"`.
- **Health** (`models`, the default: a plain `drive.ts r up` plays it too).
  Run `drive.ts r serve`, then `drive.ts r rpc providers/list '{}'`: `claude`
  with `"signIn": ["terminal"]` and
  `"health": {"status": "ready", "version": "2.1.310", "account": "person@example.com · Claude Max", ...}`.
  `drive.ts r rpc models/list '{}'`: `claude` with no `defaultModel`, and
  `sonnet`, `fable`, `opus` and `haiku`, each with efforts `low` to `max`.
  The log shows only `"probe"` lines.
- **Model** (`text`). Run
  `drive.ts r nisse exec --provider claude --model haiku --effort low 'Reply with exactly: fixture text ok'`:
  exit 0, stdout `fixture text ok`, and the log's spawn argv holds
  `--model=haiku` and `--effort=low`.
- **Switch model** (`switch_model`). Run
  `drive.ts r nisse exec --provider claude --model haiku 'Reply with exactly: one'`:
  stdout `one`. Run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": "ada", "selection": {"provider": "claude", "model": "sonnet", "effort": "low"}}'`,
  then
  `drive.ts r nisse exec --conversation <id> 'What were your two previous replies? Reply with just them, separated by a comma.'`:
  stdout `one, two`. The log's `"spawn": 1` argv holds `--model=sonnet`,
  `--effort=low` and `--resume=<spawn 0's --session-id>`: the same session
  goes on with the new model. `drive.ts r watch <id> --save switched` shows a
  `model` entry with that selection between the two runs. This departs from
  the recording: its second prompt, `Reply with exactly: two`, went to the
  first process after an in-process `set_model`, and nisse now starts a
  process per run, so the step leaves that prompt out. The answer
  `one, two` is the recording's, not proof that Claude remembers.
- **Instructions** (`text`). Run
  `drive.ts r nisse exec --provider claude --instructions 'Answer in Swedish.' 'Reply with exactly: fixture text ok'`:
  the log's `initialize` holds `"appendSystemPrompt":"Answer in Swedish."` and
  no `systemPrompt`, and its argv line holds `"rootConversation"` set to the
  conversation's id.
- **Switch to Claude** (`handoff`). Run `drive.ts r serve` and
  `drive.ts r rpc conversation/start '{"cwd": "/tmp", "provider": "script"}'`.
  Submit three turns, each with
  `drive.ts r watch <id> --submit '<text>' --until run_end`:
  `Remember the word lantern.`, then a 70,000-character turn,
  `"$(head -c 70000 /dev/zero | tr '\0' x)"`, then `Nothing else for now.`
  Run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": "bo", "selection": {"provider": "claude", "model": "haiku"}}'`
  and
  `drive.ts r watch <id> --submit 'Which word did I ask you to remember? Reply with just the word.' --until run_end --save switched`:
  a `model` entry, then the `message` `lantern`. The log's `"spawn": 0` has
  a `--session-id` and received one user message of six texts:
  `This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.`,
  `Remember the word lantern.`, `(3 entries left out here)`,
  `Nothing else for now.`, `You answered: You said: Nothing else for now.`
  and the question. The long turn, its echo and the answer to the first turn
  are the three left out. Switch to `{"provider": "script"}`, submit `plum`,
  switch back to `claude` `haiku`, and submit
  `What was the last thing I said before this message? Reply with just that word.`
  with `--save switched-back`: the `message` `plum`, and `"spawn": 1` has a
  new `--session-id` and a retelling that adds `You answered: lantern`,
  `plum`, `You answered: You said: plum` and the question after the same
  six-text opening. The recording differs in its opening on purpose: it was
  made before today's retelling, and holds
  `You answered: You said: Remember the word lantern.` and
  `(One turn of the conversation is left out here.)` where nisse now sends
  `(3 entries left out here)`. The fake does not compare, so the log shows
  what nisse sends today.
- **Sign-in error** (`auth_failed`). Run
  `drive.ts r nisse exec --provider claude hello`: exit 1, empty stdout,
  stderr `Invalid API key · Please run /login`.

## Gotchas

- The fake does not run Claude Code's tools: no `made.txt` appears, and a
  call's result is the recorded one. Prove nisse's side by the screen, the
  commits and the log.
- The fake plays its recording whatever it is sent, and a spawn past the
  recording's last process waits forever: a second conversation in the same
  run stalls. Start a new run for each journey.
- Nisse starts one Claude Code process per run. Recordings that sent two
  prompts to one process (`switch_model`, the last prompt of
  `session_gone`) can't be replayed whole; the steps above say what they leave
  out.
- The `resume_after_kill` recording expected
  `...was cut off: interrupted: nisse stopped while this ran; it may or may not have taken effect`;
  nisse now sends `...was cut off: interrupted; it may or may not have taken effect`.
  The log shows today's wording, which is right.
- `tui wait` matches the prompt too: wait on text the prompt does not hold,
  such as `may or may not` or `READY`, not on the reply the prompt asks for.
- A conversation's directory is the checkout for the TUI and `exec`; the
  recording's `<workspace>` paths become it.
- A call Claude Code allows on its own, by its settings or because it only
  reads, runs without `allow this call?`.

## With a real account

Proves what Claude Code does today: its real tools, its session files, and the
model following the prompt. Follow the skill's
[Real accounts](../SKILL.md#real-accounts): one run,
`drive.ts r up --real-claude`, whose Claude Code sessions land in your own
Claude Code configuration (`$CLAUDE_CONFIG_DIR`, or `~/.claude`). First run
`drive.ts r serve` and `drive.ts r rpc providers/list '{}'`: `claude` is
`ready` with your account. Otherwise stop and report what it shows. Give every
`tui wait` `--timeout 120000` and every `watch --until` `--timeout 120000`.
Keep `evidence/`. No step needs a person. Your Claude Code settings decide
which calls ask: when one that a step expects to ask runs without
`allow this call?`, report the setting that allowed it rather than a failure.

- **Ask, allow, resume.** `drive.ts r tui start --provider claude`, send
  `Use the Bash tool to run exactly: touch /tmp/nisse-verify/r/touched  Then reply with one word: done`,
  wait for `allow this call?`, `C-y`, wait for `READY`,
  `drive.ts r tui screen allowed`: `✓ allowed by ada` and `done`, and
  `/tmp/nisse-verify/r/touched` exists. `drive.ts r tui stop`,
  `drive.ts r rpc server/stop`, then
  `drive.ts r nisse exec --conversation <id> 'Which path did you touch earlier in this conversation? Reply with the path only.'`:
  stdout `/tmp/nisse-verify/r/touched`.
- **Read without asking.** `drive.ts r nisse exec --provider claude 'Use the Read tool to read README.md, then reply with its first heading only.'`:
  stderr `› Read(<checkout>/README.md)` and no denial, stdout `Nisse`, the
  checkout's `README.md` heading.
- **Exec denies.** `drive.ts r nisse exec --provider claude 'Use the Bash tool to run exactly: touch /tmp/nisse-verify/r/denied  If it is not allowed, reply with one word: refused'`:
  the denial on stderr and no file. With `--auto` and `.../auto`, the file
  exists.
- **Cut off.** `drive.ts r tui start --provider claude --auto`, send
  `Use the Bash tool to run exactly: echo started > /tmp/nisse-verify/r/started && sleep 120  If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok`,
  wait for `Bash(echo started`, then run `test -e /tmp/nisse-verify/r/started`
  until it succeeds, so the call is running, then `drive.ts r kill-server`, `drive.ts r tui wait 'may or may not'`
  and `drive.ts r tui wait READY`: the call's result
  `interrupted; it may or may not have taken effect`, then `resumed ok`.
  `drive.ts r watch <id> --save cut-off` holds one Bash `tool_call`, not two.
- **Health and model.** `drive.ts r rpc providers/list '{}'`: `claude` `ready`
  with your account and the Claude Code version installed now.
  `drive.ts r rpc models/list '{}'` lists today's models.
  `drive.ts r nisse exec --provider claude --model haiku --effort low 'Reply with one word: ok'`:
  the newest session file under your Claude Code configuration's `projects/`
  holds `"model":"claude-haiku-...`.
- **Switch model.** `drive.ts r nisse exec --provider claude --model haiku 'Reply with exactly: one'`,
  then `drive.ts r nisse exec --conversation <id> 'Reply with exactly: two'`,
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": "ada", "selection": {"provider": "claude", "model": "sonnet", "effort": "low"}}'`,
  and
  `drive.ts r nisse exec --conversation <id> 'What were your two previous replies? Reply with just them, separated by a comma.'`:
  stdout `one, two`, and the session file's last answer names a
  `claude-sonnet-...` model.
- **Switch to Claude.** Drive the faked step above against the real Claude
  Code, without the long turn: start a `script` conversation, submit
  `Remember the word lantern.`, switch to `claude` `haiku`, and submit
  `Which word did I ask you to remember? Reply with just the word.`: the
  `message` is `lantern`.
- **Sign-in error.** In a second run, `drive.ts r2 up --real-claude`, run
  `ANTHROPIC_API_KEY=sk-ant-not-a-key drive.ts r2 nisse exec --provider claude hi`,
  which starts the server with that key: exit 1 and Claude Code's own message,
  today `Invalid API key · Fix external API key`. `drive.ts r2 down`.

Where Claude Code is signed in by its environment, as in a hosted session, it
stays `ready` after `nisse logout claude`, and `^L` has no Claude sign-in to
start.
