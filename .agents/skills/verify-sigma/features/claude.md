# Claude

A conversation started with `--provider claude` is answered by Claude Code
through the Claude Agent SDK, with Claude Code's own tools and session. Sigma
shows Claude's calls under `SIGMA`, asks a person before the calls Claude Code
would ask about, keeps a conversation's Claude Code process for its next run
for 30 minutes, keeps it through a stop, resumes Claude Code's session where sigma's transcript ends
when it starts a new process, and after a crash tells Claude which calls were
cut off. When Claude Code has
lost the session, or a conversation is switched to Claude from another
provider, sigma retells the conversation to a new Claude Code session. Claude
Code gets the conversation's model and effort, and a switch between Claude's
models or efforts goes on in the same process and session. Sigma asks Claude
Code how it is signed in and which models it offers without asking Claude
anything. A Claude Code that
cannot sign in ends the run failed with Claude Code's own message. When
Claude Code compacts its own context, sigma keeps Claude's summary as a
compaction; `/clear` starts a new context in sigma's transcript too. A
conversation past 200,000 tokens that sits idle compacts two minutes before
its prompt cache would expire, so the person who comes back does not pay to
read the whole context again.

## Sub-features

- `claude-answer` streams Claude's answer and commits it as a `pi.assistant` entry.
- `claude-approval` turns a Claude Code permission prompt into
  `allow this call?`; `^Y` lets the call run, `^N` refuses it.
- `claude-read` shows a call Claude Code allows on its own, such as a `Read`,
  with its result and no `allow this call?`.
- `claude-exec-deny` makes `exec` refuse Claude's calls that would ask, unless
  `--auto`.
- `claude-auto` lets every call run in a conversation started with `--auto`.
- `claude-live` keeps a conversation's Claude Code process after its run and
  hands it the next run, told only what came after what it has seen. An edit,
  a reset, another provider's answer, a change of tools, or clearing the model
  or effort between runs closes it, and the next run starts a process at the
  position. So does a run that fails or leaves background work running.
- `claude-stop` interrupts Claude Code's turn when a run is stopped, records
  the cut-off calls as interrupted, and keeps the process live once Claude
  Code ended the turn. The next prompt goes to that process, told nothing
  about the cut-off calls, since its session holds the stop. A process that
  does not end its turn within 5 seconds is closed, and the next run resumes,
  told which calls were cut off.
- `claude-idle-release` closes a live process after 30 minutes without a run;
  the next run starts one that resumes the session. A process that waits to
  compact (`claude-idle-compaction`) stays past the 30 minutes.
- `claude-idle-compaction` compacts an idle conversation whose last request
  had a context of 200,000 tokens or more: two minutes before the prompt
  cache that request read or wrote expires, sigma compacts it as
  `conversation/compact` does, sending `/compact` as the conversation's input,
  by `sigma`, to the live process. The run commits
  Claude's summary as a compaction, then the process closes. A run that
  starts first moves the compaction to its own cache's expiry; a conversation
  that is busy then is not compacted. `claude_idle_compaction = false` in
  `config.toml` turns it off. Claude Code's own idle compaction is always off
  in sigma's sessions (`"idleCompaction": false`).
- `claude-resume` continues Claude Code's session in each run that starts a
  process: after an idle release, after the process exited, and after the
  server restarted.
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
  `SIGMA_ROOT_CONVERSATION`.
- `claude-model` hands Claude Code the conversation's model and effort. After
  a switch to another Claude model or effort, the next run switches the live
  process (`set_model`, then `apply_flag_settings` with `effortLevel`) before
  its prompt. Clearing the effort or the model starts a process that resumes
  the session, because Claude Code would clear them to its own default, not
  the person's settings.
- `claude-switch` retells a conversation switched to Claude to a new Claude
  Code session: the first prompt, then as many of the latest entries as fit in
  about 64,000 characters, with `(N entries left out here)` between them.
- `claude-sign-in` runs `claude auth login`, in [Sign-in](./sign-in.md).
- `claude-compact` keeps Claude Code's own compaction, from `/compact` or its
  own threshold, as a compaction entry holding Claude's summary. The TUI's
  `/compact [instructions]` and `conversation/compact` reach it by sending
  `/compact [instructions]` as the input of whoever asked, in
  [Compaction](./compaction.md). A later run
  whose position the compaction dropped gets a fresh session told the
  conversation, as `claude-session-gone` does.
- `claude-clear` keeps Claude Code's `/clear` as a reset: a new context in the
  transcript, and the next run starts a Claude Code session without the old
  one.
- `claude-environment` starts every Claude Code process, a run's, the probe's
  and `claude auth`'s, without the variables a host Claude Code session sets,
  so a server started inside Claude Code does not pass on that session's
  identity; a provider instance's own `env` still arrives.
- `claude-title` names a fresh Claude Code session after the conversation's
  title, so Claude Code asks no model for one.
- `claude-tool-search` turns Claude Code's tool search on for sigma's
  sessions when the person's Claude Code settings say `ENABLE_TOOL_SEARCH`
  `auto` or `auto:N` (N from 0 to 100), and leaves any other value alone.

## How to get to it

### People

- Run `sigma --provider claude`, or `sigma` with no `SIGMA_MODEL_SCRIPT` when no `default_model` or earlier model choice names another provider.
- Switch a conversation to Claude, or to another Claude model, with `/model`.

### Agents

- Run `sigma exec --provider claude '<prompt>'`, with `--auto` to allow calls, and `--model` and `--effort` to choose the model.
- Call `conversation/start` with `"provider": "claude"`.
- Switch a conversation to Claude, or to another Claude model, with `conversation/select_model`.

### Triggers

- A conversation idle until two minutes before its prompt cache expires,
  with a context of 200,000 tokens or more, compacts (`claude-idle-compaction`).
  The cache lasts 1 hour on a subscription sign-in and 5 minutes on an API key,
  as the last request's usage says.

## Driving it with drive.ts

Preconditions:

- Each journey is its own fresh run, `drive.ts r up --fake-claude <fixture>`
  with the fixture it names, and `drive.ts r down` after it. The fake plays
  one recorded Claude Code process per spawn across the whole run, so a run
  holds one conversation's journey.
- Every conversation names `--provider claude`. Type the prompts exactly as
  written: they are what the recording's user typed.
- What sigma sent Claude Code is in
  `/tmp/sigma-verify/r/evidence/fake-claude/log.ndjson`: one `argv` line per
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
  `resume with: sigma --conversation <id>`.
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
  line. `drive.ts r watch <id> --save read` holds `sigma.user`, a `pi.assistant`
  calling `Read`, its `pi.tool-result`, the answer `Under the floor.` and a
  `sigma.run_end` `answered`; `docs` holds `pi.usage` with the run's spend.
  A second `watch <id> --save reopen` shows the same entries. In a fresh run,
  `drive.ts r sigma exec --provider claude 'Use the Read tool to read notes.txt, then reply with where the gnome lives, in three words.'`
  exits 0 with stderr `› Read(<checkout>/notes.txt)` and no denial, stdout
  `Under the floor.`
- **Exec denies** (`bash_declined`). Run
  ``drive.ts r sigma exec --provider claude 'Run the bash command `touch declined.txt` with the Bash tool. If it is not allowed, reply with exactly: declined'``:
  exit 0, stderr `› Bash(touch declined.txt)` and
  `denied Bash(touch declined.txt): exec cannot ask, pass --auto to allow calls`,
  stdout `declined`, and the log's answer is a `deny`.
- **Auto** (`bash_allowed`). Run
  ``drive.ts r sigma exec --provider claude --auto 'Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made'``:
  exit 0, stderr `› Bash(touch made.txt)` with no denial, stdout `made`, and
  the log's answer is an `allow` nobody pressed.
- **Resume** (`died_while_idle`). Run
  `drive.ts r sigma exec --provider claude 'Remember the word PLUM. Reply with exactly: noted'`:
  stdout `noted`. Run `drive.ts r rpc server/stop`, which closes the live
  process (the log gains a `{"spawn":0,"exited":...}` line), `drive.ts r serve`, and
  take the id from `drive.ts r rpc conversation/list`. Run
  `drive.ts r sigma exec --conversation <id> 'Which word did I ask you to remember? Reply with that word only.'`:
  exit 0, stdout `PLUM`. The log's `"spawn": 1` argv has
  `--resume=<spawn 0's --session-id>` and `--resume-session-at=...`: the new
  server resumed Claude Code's session. `drive.ts r watch <id> --save resumed`
  shows both runs' `sigma.user`, `pi.assistant` and `sigma.run_end` entries.
- **Session gone, then live** (`session_gone`). Run
  `drive.ts r sigma exec --provider claude 'Remember the word PLUM. Reply with exactly: noted'`:
  stdout `noted`. The recording's session was lost after this answer: end
  its process with `kill -9 <pid>`, the `"pid"` on the log's `"spawn": 0`
  line, which a live process survives as a cold start. Then
  `drive.ts r sigma exec --conversation <id> 'Which word did I ask you to remember? Reply with that word only.'`:
  exit 0, stdout `PLUM`. In the log, `"spawn": 1` has
  `--resume=<spawn 0's --session-id>`, which the recording answers
  `No conversation found with session ID`; `"spawn": 2` has a new
  `--session-id` and received one user message of four texts:
  `This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.`,
  `Remember the word PLUM. Reply with exactly: noted`, `You answered: noted`,
  and the question. Then
  `drive.ts r sigma exec --conversation <id> 'Now reply with that word in lowercase.'`:
  stdout `plum`, no `"spawn": 3`, and `"spawn": 2` received one more user
  message holding only that prompt: the live process served the run.
  `drive.ts r watch <id> --save live` shows three runs, each ending
  `answered`, and `docs` `pi.usage` counts the third run's spend once.
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
  `drive.ts r watch <id> --save cut-off` holds one `pi.assistant` calling
  `Bash`, its `pi.tool-result` with that output and `"isError": true`, the
  answer and a `sigma.run_end` with `"outcome": "answered"`.
- **Health** (`models`, the default: a plain `drive.ts r up` plays it too).
  Run `drive.ts r serve`, then `drive.ts r rpc providers/list '{}'`: `claude`
  with `"signIn": ["terminal"]` and
  `"health": {"status": "ready", "version": "2.1.310", "account": "person@example.com · Claude Max", ...}`.
  `drive.ts r rpc models/list '{}'`: `claude` with no `defaultModel`, and
  `sonnet`, `fable`, `opus` and `haiku`, each with efforts `low` to `max`.
  The log shows only `"probe"` lines.
- **Model** (`text`). Run
  `drive.ts r sigma exec --provider claude --model haiku --effort low 'Reply with exactly: fixture text ok'`:
  exit 0, stdout `fixture text ok`, and the log's spawn argv holds
  `--model=haiku` and `--effort=low`.
- **Switch model** (`switch_model`). Run
  `drive.ts r sigma exec --provider claude --model haiku 'Reply with exactly: one'`:
  stdout `one`. Run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": {"id": "ada", "name": "ada"}, "selection": {"provider": "claude", "model": "sonnet", "effort": "low"}}'`,
  then `drive.ts r sigma exec --conversation <id> 'Reply with exactly: two'`:
  stdout `two`, and no `"spawn": 1`: `"spawn": 0` received
  `{"subtype":"set_model","model":"sonnet"}`, then
  `{"subtype":"apply_flag_settings","settings":{"effortLevel":"low"}}`, then
  the prompt. Clear the effort with
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": {"id": "ada", "name": "ada"}, "selection": {"provider": "claude", "model": "sonnet"}}'`,
  then
  `drive.ts r sigma exec --conversation <id> 'What were your two previous replies? Reply with just them, separated by a comma.'`:
  stdout `one, two`. The log's `"spawn": 1` argv holds `--model=sonnet`, no
  `--effort`, and `--resume=<spawn 0's --session-id>`: the same session goes
  on in a new process. `drive.ts r watch <id> --save switched` shows a
  `sigma.model` entry with each selection between the runs. The answer
  `one, two` is the recording's, not proof that Claude remembers.
- **Instructions** (`text`). Run
  `drive.ts r sigma exec --provider claude --instructions 'Answer in Swedish.' 'Reply with exactly: fixture text ok'`:
  the log's `initialize` holds `"appendSystemPrompt":"Answer in Swedish."` and
  no `systemPrompt`, and its argv line holds `"rootConversation"` set to the
  conversation's id.
- **Switch to Claude** (`handoff`). Run `drive.ts r serve` and
  `drive.ts r rpc conversation/start '{"author": {"id": "ada", "name": "ada"}, "cwd": "/tmp", "provider": "script"}'`.
  Submit three turns, each with
  `drive.ts r watch <id> --submit '<text>' --until run_end`:
  `Remember the word lantern.`, then a 70,000-character turn,
  `"$(head -c 70000 /dev/zero | tr '\0' x)"`, then `Nothing else for now.`
  Run
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": {"id": "bo", "name": "bo"}, "selection": {"provider": "claude", "model": "haiku"}}'`
  and
  `drive.ts r watch <id> --submit 'Which word did I ask you to remember? Reply with just the word.' --until run_end --save switched`:
  a `sigma.model` entry, then the answer `lantern`. The log's `"spawn": 0` has
  a `--session-id` and received one user message of six texts:
  `This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.`,
  `Remember the word lantern.`, `(3 entries left out here)`,
  `Nothing else for now.`, `You answered: You said: Nothing else for now.`
  and the question. The long turn, its echo and the answer to the first turn
  are the three left out. Switch to `{"provider": "script"}`, submit `plum`,
  switch back to `claude` `haiku`, and submit
  `What was the last thing I said before this message? Reply with just that word.`
  with `--save switched-back`: the answer `plum`, and `"spawn": 1` has a
  new `--session-id` and a retelling that adds `You answered: lantern`,
  `plum`, `You answered: You said: plum` and the question after the same
  six-text opening. The recording differs in its opening on purpose: it was
  made before today's retelling, and holds
  `You answered: You said: Remember the word lantern.` and
  `(One turn of the conversation is left out here.)` where sigma now sends
  `(3 entries left out here)`. The fake does not compare, so the log shows
  what sigma sends today.
- **Environment and title** (`text`). From a shell inside a Claude Code
  session (`echo $CLAUDECODE` prints `1`), run
  `drive.ts r sigma exec --provider claude 'Reply with exactly: fixture text ok'`:
  stdout `fixture text ok`. The log's spawn line's `env` holds
  `"CLAUDE_CODE_ENTRYPOINT":"sdk-ts"` and none of `CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_PID` or
  `AI_AGENT`, and its `initialize` holds
  `"title":"Reply with exactly: fixture text ok"`.
- **Tool search** (`text`). Write `{"env":{"ENABLE_TOOL_SEARCH":"auto"}}` to
  `settings.json` in an empty folder, then run
  `CLAUDE_CONFIG_DIR=<folder> drive.ts r sigma exec --provider claude 'Reply with exactly: fixture text ok'`:
  the log's spawn argv holds `--settings` followed by
  `{"env":{"ENABLE_TOOL_SEARCH":"true"},"idleCompaction":false}`. With
  `"false"` there, or no `env`, `--settings` is only `{"idleCompaction":false}`.
- **Stop keeps the process** (`stop_keeps_process`). Run
  `drive.ts r tui start --provider claude --auto`, `drive.ts r tui wait READY`,
  type
  ``Run the bash command `echo started > started.txt && python3 -c 'import time; time.sleep(120)'` with the Bash tool. Then reply with exactly: slept``
  and `Enter`, `drive.ts r tui wait 'Bash(echo started'`, then `Escape`,
  `drive.ts r tui wait 'may or may not'`, `drive.ts r tui wait READY`. Type
  `Did your last Bash call finish? Reply with exactly one word: finished or interrupted`
  and `Enter`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen stopped`: under the call,
  `interrupted; it may or may not have taken effect`, `◆ interrupted`, then
  the answer `interrupted`. The log has one `"spawn"` line, a received
  `"subtype":"interrupt"` request and no `"exited"` line, and the second user
  message holds only the question.
- **Idle compaction** (`idle_compaction_5m`). Its one run reports a context
  of 226,830 tokens written to the 5-minute cache, so sigma compacts about 3
  minutes after it. Run
  `drive.ts r sigma exec --provider claude 'Reply with exactly: one'`: stdout
  `one`. Take the id from `drive.ts r rpc conversation/list`, then
  `drive.ts r watch <id> --until pi.compaction --timeout 300000 --save idle-compaction`:
  within about 3 minutes of the answer, a `sigma.user` entry `/compact` with
  `"author": {"id": "sigma", "name": "sigma"}`, then a `pi.compaction` holding Claude's summary. The log's `"spawn": 0` argv holds
  `--settings {"idleCompaction":false}`, it received `/compact` as its second
  user message, and it then has an `"exited"` line: the process closed after
  the compaction, long before the 30 minutes.
- **Sign-in error** (`auth_failed`). Run
  `drive.ts r sigma exec --provider claude hello`: exit 1, empty stdout,
  stderr `Invalid API key · Please run /login`.

## Contexts

- **Subagents.** A Claude subagent is listed by `conversation/list` with its
  `lineage` (no `task`), and `conversation/submit` or
  `conversation/select_model` on it answers `TakesNoInput`.
- **Inside an agent.** Sigma leaves out the variables a host Claude Code
  session sets (`claude-environment`). Its `ANTHROPIC` and `CCR` variables
  still reach Claude Code, so start a real-account run without them.
- **Server restart.** A stop closes the live processes; the next run resumes Claude Code's session where Sigma's transcript ends.
- **No client.** A live process keeps the server up until it is released, 30 minutes after the conversation's last run, so `sigma exec` and attn, which hold no watch, still find it. One that waits to compact keeps it up until its compaction ends.

## Tests

Stack, `packages/sigma/test/stack.test.ts`:

- claude-exec-deny: sigma exec refuses Claude's calls that would ask
- claude-exec-deny, claude-auto: sigma exec --auto lets Claude's calls run without asking

Provider, `packages/sigma/test/claude.test.ts`:

- claude-answer, provider-claude: Claude's answer through Claude Code is committed as sigma's message
- claude-system-prompt: Claude Code keeps its own system prompt, adds the conversation's instructions, and its commands know the conversation
- claude-approval: a command Claude wants to run waits for a person, and Claude Code hears the answer
- claude-read: Claude reads files without asking and the read shows as a call and its result
- claude-resume, claude-live: a Claude Code process that exits while it waits for the next run is replaced by one that resumes where sigma's transcript ends
- claude-session-gone: when Claude Code lost the session, a fresh one is given the conversation so far
- claude-live: the next run reaches the Claude Code process that served the last one, told only its prompt, and what the process spent counts once
- claude-idle-release: a live Claude Code process closes after the idle period, and the next run resumes its session
- claude-idle-compaction: an idle Claude conversation past 200,000 tokens compacts once, two minutes before its prompt cache expires, then its process closes
- claude-idle-compaction: a conversation whose last request wrote the 5-minute cache compacts three minutes into its pause
- claude-idle-compaction, claude-idle-release: a short context, or claude_idle_compaction = false, closes after the idle period without compacting
- server-idle-exit, claude-idle-release: a live Claude Code process keeps the server up after its client leaves, until the process closes
- server-stop, claude-live: stopping the server closes its live Claude Code processes at once
- claude-sign-in-error: a signed-out Claude Code fails the run with its own words
- claude-model: the conversation's model and effort reach Claude Code
- claude-model, claude-live: a switch of model and effort reaches the live Claude Code process, and clearing the effort resumes the session in a new one
- claude-cut-off: a run cut off by a server stop resumes, and Claude Code is told which call was cut off
- claude-stop, claude-live: stopping a run mid-call interrupts Claude Code's turn, and the next prompt goes to the same process, told only that prompt
- claude-stop, claude-resume: a Claude Code process that does not end its turn after a stop is closed, and the next run resumes, told which call was cut off
- claude-resume: a run that answered before the server stopped is not run again
- claude-read: a skill Claude Code runs shows as its call and result, and Claude answers from it
- claude-sign-in: signing in to Claude runs Claude Code's own sign-in in a terminal with the provider's environment, then names the account
- compact-rpc, claude-compact: conversation/compact compacts a Claude conversation by sending Claude Code /compact with the instructions, and answers once it has
- claude-compact, claude-session-gone: a resume at a position Claude Code compacted away starts a fresh session told the conversation
- claude-clear: /clear starts a new context in the transcript, and the next run starts a Claude Code session without it
- claude-auto: in a conversation started without asking, a call Claude Code would ask about runs, allowed for it
- claude-health: Claude Code says once how it is signed in and which models it offers, without asking Claude anything
- claude-switch: switching to Claude from another provider retells the conversation to a new Claude Code session
- claude-switch: retelling a long conversation to Claude keeps its first prompt and the one being answered
- claude-environment: a server started inside a Claude Code session hands none of that session's variables to the Claude Code it starts, and the provider's own environment still arrives
- claude-title: a fresh Claude Code session is named after the conversation's first prompt, so Claude Code asks no model for a name
- claude-tool-search: tool search set to auto in the person's Claude Code settings is turned on for sigma's sessions, and any other value is left alone

Package, `packages/claude/test/claude.test.ts`:

- claude-clear: a reset queued while Claude works ends the run, and what was queued with it starts fresh
- claude-live, claude-resume: an edit to the context closes the live process and starts a fresh session told the edited conversation
- claude-live: a reset between runs closes the live process, and the next run starts a fresh session
- claude-read: parallel calls of one response are each committed with the result Claude Code returned
- claude-resume: a fork of a Claude conversation forks Claude Code's session at the fork's position
- claude-resume: what each run spent is added to the conversation's usage, once, when each run starts its own process
- claude-switch, claude-live: switching to Claude from another provider retells the conversation to a new Claude Code session

## Gotchas

- A new recording comes from a real Claude Code through
  `packages/sigma/test/support/record-claude`: give it to a server as the
  Claude executable with `RECORD_CLAUDE_TO=fixtures/claude/<name>.ndjson`.
  It leaves out the machine's own skills, commands and hooks, but what Claude
  writes may quote your settings or CLAUDE.md: read the file before
  committing it.
- The fake does not run Claude Code's tools: no `made.txt` appears, and a
  call's result is the recorded one. Prove sigma's side by the screen, the
  commits and the log.
- The fake plays its recording whatever it is sent, and a spawn past the
  recording's last process waits forever: a second conversation in the same
  run stalls. Start a new run for each journey.
- A conversation's next run goes to its live process, which plays on in the
  recording's same spawn. A recording whose runs each started a process
  (`died_while_idle`, `clear`, `compaction_resume`) needs that process gone
  first: `kill -9` its pid from the log, or `rpc server/stop` and `serve`.
  A prompt sent to a live process past its recording stalls.
- Every Claude run keeps the server up for 30 minutes after it: end a journey
  with `drive.ts r rpc server/stop`, or `down`.
- `idle_compaction` and `idle_compaction_5m` reach their long context through
  50,000 filler words of start instructions, cut from the recordings: the fake
  does not compare what sigma sends. Their compaction comes 58 and 3 minutes
  after the last run, by the time of the request.
- The `resume_after_kill` recording expected
  `...was cut off: interrupted: sigma stopped while this ran; it may or may not have taken effect`;
  sigma now sends `...was cut off: interrupted; it may or may not have taken effect`.
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
`drive.ts r serve` and `drive.ts r rpc providers/list '{}' --timeout 60000`:
`claude` is `ready` with a version and your account and plan (SKILL.md's
First check says why that matters). Otherwise stop and report what it shows. Give every
`tui wait` `--timeout 120000` and every `watch --until` `--timeout 120000`.
Keep `evidence/`. No step needs a person. The run leaves out your own Claude
Code settings (SKILL.md's Real accounts says why), so Claude Code's defaults
decide instead of them: a `touch` asks, a `Read` does not.

- **Ask, allow, resume.** `drive.ts r tui start --provider claude`, send
  `Use the Bash tool to run exactly: touch /tmp/sigma-verify/r/touched  Then reply with one word: done`,
  wait for `allow this call?`, `C-y`, wait for `READY`,
  `drive.ts r tui screen allowed`: `✓ allowed by ada` and `done`, and
  `/tmp/sigma-verify/r/touched` exists. `drive.ts r tui stop`,
  `drive.ts r rpc server/stop`, then
  `drive.ts r sigma exec --conversation <id> 'Which path did you touch earlier in this conversation? Reply with the path only.'`:
  stdout `/tmp/sigma-verify/r/touched`.
- **Read without asking.** `drive.ts r sigma exec --provider claude 'Use the Read tool to read README.md, then reply with its first heading only.'`:
  stderr `› Read(<checkout>/README.md)` and no denial, stdout `Sigma`, the
  checkout's `README.md` heading.
- **Exec denies.** `drive.ts r sigma exec --provider claude 'Use the Bash tool to run exactly: touch /tmp/sigma-verify/r/denied  If it is not allowed, reply with one word: refused'`:
  the denial on stderr and no file. With `--auto` and `.../auto`, the file
  exists.
- **Cut off.** `drive.ts r tui start --provider claude --auto`, send
  `Use the Bash tool to run exactly: echo started > /tmp/sigma-verify/r/started && sleep 120  If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok`,
  wait for `Bash(echo started`, then run `test -e /tmp/sigma-verify/r/started`
  until it succeeds, so the call is running, then `drive.ts r kill-server`, `drive.ts r tui wait 'may or may not'`
  and `drive.ts r tui wait READY`: the call's result
  `interrupted; it may or may not have taken effect`, then `resumed ok`.
  `drive.ts r watch <id> --save cut-off` holds one `Bash` call, not two.
- **Stop keeps the process.** `drive.ts r tui start --provider claude --model haiku --auto`, send
  `Use the Bash tool to run exactly: echo started > /tmp/sigma-verify/r/started && python3 -c 'import time; time.sleep(120)'  Then reply with exactly: slept`,
  wait for `Bash(echo started` and for `/tmp/sigma-verify/r/started`, and
  note the `claude` pid under the server (`pgrep -P <server pid> -l`).
  `Escape`, wait for `may or may not` and `READY`: the call's result
  `interrupted; it may or may not have taken effect` and `◆ interrupted`,
  the same `claude` pid, and no child under it. Send
  `Did your last Bash call finish? Reply with exactly one word: finished or interrupted`:
  `interrupted`, still the same pid. The session file under your Claude Code
  configuration's `projects/` holds Claude Code's own rejected result and
  `[Request interrupted by user for tool use]`, then the question alone, and
  the question's request reads the earlier requests' cache. Stopping a
  foreground subagent's Bash call and stopping Claude mid-text keep the pid
  the same way; the subagent's conversation ends `interrupted`, and after a
  text stop the session holds the cut-off text and
  `[Request interrupted by user]`.
- **Health and model.** `drive.ts r rpc providers/list '{}' --timeout 60000`:
  `claude` `ready` with the Claude Code version installed now.
  `drive.ts r rpc models/list '{}'` lists today's models.
  `drive.ts r sigma exec --provider claude --model haiku --effort low 'Reply with one word: ok'`:
  the newest session file under your Claude Code configuration's `projects/`
  holds `"model":"claude-haiku-...`.
- **Switch model.** `drive.ts r sigma exec --provider claude --model haiku 'Reply with exactly: one'`,
  then
  `drive.ts r rpc conversation/select_model '{"conversation": "<id>", "author": {"id": "ada", "name": "ada"}, "selection": {"provider": "claude", "model": "sonnet", "effort": "low"}}'`
  and `drive.ts r sigma exec --conversation <id> 'Reply with exactly: two'`:
  stdout `two`, and the session file (the newest under your Claude Code
  configuration's `projects/`) shows a `/model` command, `Set model to
sonnet (claude-sonnet-...)`, and the answer `two` from a
  `claude-sonnet-...` model, with no second session file. Select
  `{"provider": "claude", "model": "sonnet"}` and send
  `What were your two previous replies? Reply with just them, separated by a comma.`:
  stdout `one, two` from `claude-sonnet-...`, in the same session file.
  A switch to another model misses the prompt cache (the answer's
  `cache_miss_reason` is `model_changed`); an effort switch on one model, or
  `sonnet` to `sonnet[1m]`, reads it.
- **Switch to Claude.** Drive the faked step above against the real Claude
  Code, without the long turn: start a `script` conversation, submit
  `Remember the word lantern.`, switch to `claude` `haiku`, and submit
  `Which word did I ask you to remember? Reply with just the word.`: the
  answer is `lantern`.
- **Title.** `drive.ts r sigma exec --provider claude 'Reply with one word: ok'`:
  the newest session file under your Claude Code configuration's `projects/`
  holds a `custom-title` line with `"customTitle":"Reply with one word: ok"`
  and no `ai-title` line, which Claude Code writes after asking a model for a
  name.
- **Sign-in error.** In a second run, `drive.ts r2 up --real-claude`, run
  `ANTHROPIC_API_KEY=sk-ant-not-a-key drive.ts r2 sigma exec --provider claude hi`,
  which starts the server with that key: exit 1 and Claude Code's own message,
  today `Invalid API key · Fix external API key`. `drive.ts r2 down`.

Where Claude Code is signed in by its environment, as in a hosted session, it
stays `ready` after `sigma logout claude`, and `^L` has no Claude sign-in to
start.
