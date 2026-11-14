# Prompt cache

A provider keeps the front of a recent request for a while. When the next
request starts with the same tokens, it reads them from its prompt cache
instead of processing them again. Cached input costs 10 to 20 times less than
other input (GPT-5.6 Sol: 0.1×, GPT-6.1 Sol: 0.05×, Claude: 0.1×) and comes
back sooner, so a long conversation that keeps its cache costs a fraction of
one that doesn't. Sigma keeps the front of each request unchanged so the
provider can reuse it. On ChatGPT, sigma sends the same instructions, tools
and cache key in every request of a conversation and adds new turns at the
end. On Claude, Claude Code builds the requests, and sigma keeps a
conversation's runs in one Claude Code process, or starts the next process
with what the last one had. A person sees the result in `/usage`, whose
`cached` column says how much input the provider read from its cache.

## Sub-features

- `cache-turns` sends each ChatGPT request of a conversation, within a run and
  across runs, with the same `instructions`, `tools` and `prompt_cache_key`
  as the one before, and an `input` that starts with all of the one before's.
- `cache-fresh-subagent` does the same among the requests of a subagent
  started with `fork_turns: "none"`, under a `prompt_cache_key` of its own.
- `cache-shown` shows cached input per model in `/usage`, as
  `<total> (<n> in, <n> cached, <n> out)`, with `<n> cache write` before `out`
  when the provider charged for writing to its cache; `usage/get` returns it
  as `cacheRead` and `cacheWrite` beside `input` and `output`.
- `cache-claude-turns` gives the runs of a Claude conversation one live Claude
  Code process, so Claude Code reads its own cache from one run to the next
  (`claude-live` in [Claude](./claude.md)).
- `cache-claude-resume` starts a Claude Code process reopened for the same
  conversation with the appended instructions, sigma's MCP tools in the same
  order, and the withheld tools of the one before.
- `cache-claude-fork` makes `conversation/fork` on Claude fork Claude Code's
  session (`--resume <parent's session> --fork-session`) with the parent's
  appended instructions, sigma tools and withheld tools.
- `cache-claude-subagent` keeps Claude Code's own fork subagents
  (`subagent_type: "fork"`), which share their parent's cache, available,
  and sigma hosts each as a conversation of its own whose `lineage` has
  `"agentType": "fork"`.

## How to get to it

### People

- Talk in one conversation in the TUI: each prompt after the first reads the
  conversation so far from the cache.
- Type `/usage` and press `⏎` to see the `cached` column; `esc` closes it.
- Ask a model to start a subagent, or fork with `/fork`, in
  [Subagents](./subagents.md) and [Conversations and forks](./conversations.md).

### Agents

- `conversation/submit` to one conversation, again and again.
- `usage/get` with `{"conversation": "<id>"}` or `{}`: `cacheRead` and
  `cacheWrite` per model.
- Watch a conversation: on ChatGPT each `pi.assistant` entry's message has the
  `usage` its own request reported, `cacheRead` among it. On Claude the
  entries carry none, and the `pi.usage` document holds what each run spent.
- `conversation/fork` and `spawn_agent`, as above.

## Driving it with drive.ts

Preconditions:

- Each journey is its own fresh run, `drive.ts r down` after it.
- `jq` is installed, for reading the fakes' logs.
- What sigma sent the fake ChatGPT is in
  `/tmp/sigma-verify/r/evidence/fake-openai.ndjson`, one request a line with
  its `body`; what it started each Claude Code process with is in
  `/tmp/sigma-verify/r/evidence/fake-claude/log.ndjson`.

- **Turns on ChatGPT** (`cache-turns`). `drive.ts r up --fake-openai tool_call,text_answer`,
  `drive.ts r sigma exec --provider openai --auto 'what does echo say?'`, take
  the id from `drive.ts r rpc conversation/list`, then
  `drive.ts r sigma exec --conversation <id> hello`: `Hello there`. Compare
  each request with the one before:

  ```sh
  jq -s -c '[.[] | .body] as $b | [range(1; $b|length) as $i | {request: ($i+1), key: ($b[$i].prompt_cache_key == $b[$i-1].prompt_cache_key), instructions: ($b[$i].instructions == $b[$i-1].instructions), tools: ($b[$i].tools == $b[$i-1].tools), front: ($b[$i].input[0:($b[$i-1].input|length)] == $b[$i-1].input)}]' /tmp/sigma-verify/r/evidence/fake-openai.ndjson
  ```

  Requests 2 and 3 read `true` for all four. Request 3 is marked `differs`
  because `text_answer` was recorded as a conversation's first request.

- **A fresh subagent** (`cache-fresh-subagent`). `drive.ts r up --fake-openai fresh_subagent_tool_call`,
  `drive.ts r sigma exec --provider openai --auto 'Ask a scout what echo prints.'`:
  stderr `› spawn_agent(scout)` and `› wait_agent`. The log holds four
  requests, all `as recorded`: the parent's, the scout's two, the parent's
  again. `jq -c '{request, key: .body.prompt_cache_key, inputs: (.body.input|length)}'`
  on it shows requests 2 and 3 under one key, not the parent's, request 2 with
  one input item, and request 4 back on the parent's key. Compare the scout's
  requests with each other, and the parent's:

  ```sh
  jq -s -c '[.[] | .body] as $b | [[1,2],[0,3]][] as [$x,$y] | {requests: [$x+1,$y+1], key: ($b[$y].prompt_cache_key == $b[$x].prompt_cache_key), instructions: ($b[$y].instructions == $b[$x].instructions), tools: ($b[$y].tools == $b[$x].tools), front: ($b[$y].input[0:($b[$x].input|length)] == $b[$x].input)}' /tmp/sigma-verify/r/evidence/fake-openai.ndjson
  ```

  Both lines read `true` for all four.

- **The cached column** (`cache-shown`). A script
  `[{"text": "answer one", "usage": {"input": 1200, "output": 300}}, {"text": "answer two", "usage": {"input": 2000, "output": 500, "cacheRead": 1200}}]`,
  `drive.ts r up --script s.json`, `drive.ts r tui start --conversation talk`,
  `drive.ts r tui wait READY`. Send `one`, wait for `1.5k tokens`, send `two`,
  wait for `5.2k tokens`, type `/usage` and `Enter`, `drive.ts r tui wait USAGE`,
  `drive.ts r tui screen usage-cached`:
  `script/script  5.2k (3.2k in, 1.2k cached, 800 out)` under both
  `this conversation` and `every conversation`.
  `drive.ts r rpc usage/get '{"conversation": "talk"}'`:
  `"input": 3200, "output": 800, "cacheRead": 1200, "cacheWrite": 0, "totalTokens": 5200`.
- **A reopened Claude process** (`cache-claude-resume`). `drive.ts r up --fake-claude died_while_idle`,
  `drive.ts r sigma exec --provider claude --instructions 'Report with attn when done.' 'Remember the word PLUM. Reply with exactly: noted'`:
  `noted`. `drive.ts r rpc server/stop`, `drive.ts r serve`, take the id, then
  `drive.ts r sigma exec --conversation <id> 'Which word did I ask you to remember? Reply with that word only.'`:
  `PLUM`. In the fake's log,
  `jq -c 'select(.initialize) | {spawn, append: .initialize.appendSystemPrompt, tools: [.initialize.sdkMcpServerManifests.sigma.toolsListResult.tools[]?.name]}'`
  shows spawns 0 and 1 with the same `append` and tools, and
  `jq -c 'select(.argv and .probe == null) | {spawn, start: [.argv[] | select(test("^--(resume|session-id|fork-session|disallowedTools)"))]}'`
  shows spawn 1 with `--resume=<spawn 0's --session-id>`.
- **A Claude fork** (`cache-claude-fork`). The same first `exec` in a fresh
  run. Take the id and its `sigma.run_end` entry's id from
  `drive.ts r watch <id> --save parent`, then
  `drive.ts r rpc conversation/fork '{"conversation": "<id>", "at": <run_end id>, "author": {"id": "ada", "name": "ada"}}'`:
  `{"conversation": "<fork>"}`. Run the second `exec` with
  `--conversation <fork>`: `PLUM`. The same `jq` shows spawn 1 with the same
  `append`, and `--resume=<spawn 0's session>`, `--fork-session` and a
  `--session-id` of its own.
- **A Claude fork subagent** (`cache-claude-subagent`). `drive.ts r up --fake-claude fork_subagent`,
  `drive.ts r sigma exec --provider claude --auto 'Use the Agent tool with subagent_type "fork" to have a forked subagent reply with exactly: forked. Then reply with exactly what it said.'`:
  stdout `Waiting on the forked agent's reply.`, stderr `› Agent`.
  `drive.ts r rpc conversation/list` holds a second conversation whose
  `lineage` is `{"parent": "<id>", "title": "Reply with exactly \"forked\"", "agentType": "fork", ...}`.
  It ends `interrupted`, as Gotchas says.

## Contexts

- **Provider.** ChatGPT is the provider sigma builds requests for, so sigma
  owns its cache. On Claude, Claude Code builds the requests, and sigma
  controls only what each process starts with and how long it lives.
- **Subagents.** A ChatGPT subagent has a cache key of its own. A Claude
  Code fork subagent shares its parent's cache in Claude Code.
- **Server restart.** A restarted server reopens Claude Code processes with
  `--resume`, which reads the cache only when the process starts as the one
  before did (`cache-claude-resume`).

## Tests

Provider, `packages/sigma/test/openai.test.ts`:

- cache-turns: each ChatGPT request of a conversation, within a run and across runs, repeats the one before it and adds to its end
- cache-fresh-subagent: a subagent started without its parent's history keeps its own requests' front, under a cache key of its own

Provider, `packages/sigma/test/claude.test.ts`:

- claude-live, cache-claude-turns: the next run reaches the Claude Code process that served the last one, told only its prompt, and what the process spent counts once
- cache-claude-resume: a Claude Code process reopened for a conversation starts with the instructions, sigma tools and withheld tools of the one before
- cache-claude-fork: a fork of a Claude conversation forks Claude Code's session, started with its parent's instructions, sigma tools and withheld tools
- cache-claude-subagent: Claude Code's fork subagent stays available, and sigma hosts it as a conversation of its own

Wire, `packages/sigma/test/wire.test.ts`:

- usage-rpc, usage-per-model, usage-total, cache-shown: a client reads the tokens each conversation spent, by model, cached input apart, and the home's total

Screen, `packages/sigma/test/screen.test.ts`:

- usage-rpc, usage-context-live, cache-shown: the status bar counts tokens and the context, and /usage lists them by model with cached input apart

## Gotchas

- The recordings report no usage, so the fakes prove only what sigma sends.
  Only a real account shows the cache being read.
- On ChatGPT, `input` is the part not read from the cache: a hit shows as a
  small `in` and a large `cached`. ChatGPT reports `cacheWrite` 0 even on
  requests that wrote to the cache.
- On Claude, answer entries carry no usage. Sigma counts what Claude Code's
  `result` reports for each run, in `pi.usage`, so `usage/get` per
  conversation after each run is the way to read Claude's cache.
- Claude Code's cache lasts 1 hour for the main conversation on a
  subscription and 5 minutes for subagents, forks and API keys.
  `claude-idle-compaction` in [Claude](./claude.md) acts on that lifetime.
- A conversation's instructions changed with `conversation/configure` do not
  reach a live Claude Code process. The next process starts with the new
  ones, and its first request reads only the tools from the cache.
- Claude Code 2.1.312 always runs a fork subagent in the background, and its
  parent usually ends its turn first. Sigma closes the process at the end of
  the parent's run, so the fork's conversation ends
  `interrupted: Claude Code ended before the subagent did`, and its usage is
  not counted (seed `claude-background-work-across-runs`).
- An extension tool whose input is an empty struct fails Claude runs today;
  give a test tool at least one field.

## With a real account

Proves that the provider reads the cache. Follow the skill's
[Real accounts](../SKILL.md#real-accounts), with its first check. No step
needs a person. Write the long first prompt once:

```sh
{ echo 'Remember these 600 labels; I will ask about them next. Reply with exactly: noted'; seq 1 600 | sed 's/.*/label & is amber-&-cedar/'; } > /tmp/sigma-verify/long.txt
```

It is about 12,000 tokens (12,042 on gpt-6-luna), past the 1,024 a provider
needs before it caches.

ChatGPT, in a run made with `drive.ts r up --openai-auth <your saved sign-in>`:

- **Turns.** `drive.ts r sigma exec --provider openai --model gpt-6-luna "$(cat /tmp/sigma-verify/long.txt)"`
  (any model `drive.ts r rpc models/list` lists for openai; the account may not
  serve sigma's default):
  `noted`. Take the id, then
  `drive.ts r watch <id> --submit 'Which label is number 412? Reply with it only.' --until run_end --timeout 120000 --save second`:
  the answer names `amber-412-cedar`. Read each answer's usage:
  `jq -c '.. | objects | select(.kind? == "pi.assistant") | .model[0].usage | {input, cacheRead, output}' /tmp/sigma-verify/r/evidence/second.ndjson`.
  The first answer's `input` is the whole first request, with `cacheRead`
  near 0. The second's `cacheRead` is nearly all of the first's `input`, in
  multiples of 128, and its `input` is a few hundred tokens. Measured on
  2026-11-14: `noted` with `input` 12,042 and `cacheRead` 0, then
  `amber-412-cedar` with `input` 162 and `cacheRead` 11,904.
  `drive.ts r rpc usage/get '{"conversation": "<id>"}'` sums both.

Claude, in a run made with `drive.ts r up --real-claude`; give each `rpc` and
`watch` `--timeout 120000`:

- **Turns.** `drive.ts r sigma exec --provider claude --model claude-haiku-5-5 "$(cat /tmp/sigma-verify/long.txt)"`:
  `noted`. Take the id, and
  `drive.ts r rpc usage/get '{"conversation": "<id>"}'`: the model's
  `cacheRead` (Claude Code's own system prompt, read from earlier sessions)
  and `cacheWrite` (the rest, now written). Then
  `drive.ts r sigma exec --conversation <id> 'Which label is number 412? Reply with it only.'`:
  `amber-412-cedar`, and `usage/get` again. The second run added a
  `cacheRead` of most of the first run's `cacheRead + cacheWrite`, and an
  `input` of a few tokens. It does not read all of it: Claude Code puts the
  first request's last cache breakpoint at the first content block of the
  prompt's message, so what follows that block is written again. Measured on
  2026-11-14: the first run read 12,932 and wrote 23,140; the second read
  31,547 and wrote 7,762, with `input` 2. Claude Code's transcript
  (`~/.claude/projects/<cwd slug>/<session>.jsonl`) has each request's
  `api-request` line with its `cacheControl` breakpoints.
- **A fork subagent.** In a new conversation,
  `drive.ts r sigma exec --provider claude --model claude-haiku-5-5 --auto 'Use the Agent tool with subagent_type "fork" to have a forked subagent reply with exactly: forked. Then reply with exactly what it said.'`
  starts a fork, as the recipe above shows. Its usage does not reach sigma
  (Gotchas). Read it from Claude Code: the `Agent` call's result in
  `drive.ts r watch <id>` names an `output_file`, the fork's own transcript.
  `jq -c 'select(.message.usage) | .message.usage | {cache_read_input_tokens, cache_creation_input_tokens}' <output_file>`:
  its requests read the parent's prefix from the cache. Its first request
  read 27,838 tokens on haiku in one run. In another it read 15,500 and wrote
  12,192, the same split as the parent's request that made the `Agent` call,
  and its second request read 27,692: the fork probably started before the parent's
  response finished, so before its cache entry existed.
