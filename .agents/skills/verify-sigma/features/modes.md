# Modes and patterns

Whole-app patterns: print, JSON, plan mode, a reviewer and per-conversation sandboxes.

## Sub-features

- `mode-print` [kernel] Print mode (example 17): Run one prompt, print the answer
- `mode-json` [kernel] JSON mode (example 18): Scripts read events
- `exec-json` The client path for JSON mode (example 18): Scripts read events
- `mode-plan` [kernel] Plan mode (example 26): Model plans with write tools withheld, then a person leaves plan mode to carry it out
- `mode-reviewer` [kernel] Reviewer extension (example 27): A second agent on its own model reviews the work
- `mode-sandbox` [kernel] Sandbox per conversation (example 28): Isolate work
- `models-script` [kernel] The `script` provider answers through the Models seam (`packages/models`) from `SIGMA_MODEL_SCRIPT`'s steps: text word by word, a tool call, a failure, one step list per agent, and `You said: <last user text>` once the steps run out.
- `models-faux` [kernel] The faux model answers through the Models seam: scripted responses one per request, a deferred response pending for a set number of fetches and then ready, cancel, a retryable error as the final message, and usage with a simulated prompt cache.
- `models-overflow` [kernel] A provider error is read as a context overflow by pi-ai's patterns for each provider, so a run compacts instead of failing.
- `models-retryable` [kernel] A provider error is read as transient or final by pi-ai's patterns, and the retry delay doubles up to its cap.
- `models-unsupported` [kernel] A Models method a provider lacks fails with `Unsupported` naming the method and the provider; a model whose provider is missing fails with `UnknownProvider`.

## How to get to it

### People

None yet.

### Agents

- Print mode: run `sigma exec '<prompt>'`.
- JSON mode: run `sigma exec --json '<prompt>'`: one JSON line per item of the conversation's `conversation/watch`,
  the view first, then each commit's changes, until the prompt's run ends.

## Driving it with drive.ts

- **Print.** In a fresh run made with `drive.ts r up`, run `drive.ts r sigma exec 'hello there'`: exit 0,
  stdout `You said: hello there`.
- **JSON.** Run `drive.ts r sigma exec --json 'hello json'`: exit 0, and stdout holds one JSON object per line, the
  first `{"_tag": "view", ...}` with no entries, then `{"_tag": "change", "ops": [...]}` lines: one sets
  `pi.live.run`, then the `sigma.user` entry, the `pi.assistant` answer and the `sigma.run_end` arrive as splices of
  `entries`, and the last line deletes `pi.live.run`.

## Sources

Feature ledger area Y: README Examples; examples 05-harness, 13-chat, 15-real-model, 17-print, 18-json, 25-coding-agent, 26-plan-mode, 27-reviewer, 28-sandbox-per-conversation, 30-reload-and-restart, 32-tests-after-edits.

## Tests

Stack, `packages/sigma/test/stack.test.ts`:

- mode-print, answer-exec, server-on-demand: sigma exec starts a server, prints the answer and exits 0
- mode-print, answer-exec-fail: sigma exec exits 1 and says why when the run fails
- mode-json, exec-json: sigma exec --json prints the view, then each commit's changes, until the run ends

Provider, `packages/sigma/test/openai.test.ts`:

- compaction-overflow, models-overflow: ChatGPT's context-window error compacts the conversation, and the request goes again

Package, `packages/models/test/overflow.test.ts`:

- models-overflow: limits HTTP-status matching to failed responses
- models-overflow: detects explicit Ollama prompt-too-long errors
- models-overflow: detects z.ai prompt-too-long errors
- models-overflow: detects z.ai CN endpoint prompt-exceeds-max-length errors
- models-overflow: detects Together AI context length errors
- models-overflow: detects LiteLLM-wrapped OpenAI maximum context length errors
- models-overflow: detects LiteLLM pre-call ContextWindowExceededError
- models-overflow: detects OpenAI-compatible parenthesized maximum context length errors
- models-overflow: detects OpenRouter Poolside maximum allowed input length errors
- models-overflow: detects DS4 configured context size errors
- models-overflow: does not treat generic non-overflow Ollama errors as overflow
- models-overflow: only treats bodyless 400 errors as overflow for Cerebras
- models-overflow: does not treat Bedrock throttling 'Too many tokens' as overflow
- models-overflow: does not treat Bedrock service unavailable as overflow
- models-overflow: does not treat generic rate limit errors as overflow
- models-overflow: does not treat HTTP 429 style errors as overflow
- models-overflow: detects Xiaomi-style overflow (length stop with zero output and filled context)
- models-overflow: treats a length stop below the desired output limit as recoverable
- models-overflow: does not recover a length stop that reached the desired output limit
- models-overflow: treats zero-output length stops as recoverable without context metadata
- models-overflow: does not treat normal length stops with output as context overflow
- models-overflow: does not treat zero-output length stops far below context as context overflow

Package, `packages/models/test/retry.test.ts`:

- models-retryable: matches explicit provider retry guidance
- models-retryable: matches Bun fetch socket drop wording
- models-retryable: matches upstream request buffer exhaustion wording
- models-retryable: matches gateway wording for a stream cut short mid-reply
- models-retryable: matches OpenAI Responses streams that end before terminal events
- models-retryable: matches Azure peak-load capacity errors
- models-retryable: keeps provider limit errors non-retryable
- models-retryable: keeps the ChatGPT subscription usage limit non-retryable
- models-retryable: keeps the ChatGPT Business workspace usage limit non-retryable
- models-retryable: classifies assistant error messages
- models-retryable: caps agent retry delay

Package, `packages/models/test/seam.test.ts`:

- models-script: a step's text streams word by word and ends the answer
- models-script: a tool step calls the tool and a fail step ends the request in error
- models-script: with no step left it echoes the last user text, 30 ms per word
- models-script: each agent takes its own steps, named by the request's metadata
- models-faux: scripted responses stream thinking, text and tool calls, one per request
- models-faux: a deferred response stays pending for the set fetches, then answers; a cancelled one fails
- models-faux: a retryable provider error arrives as the final message, and the next request answers
- models-faux: a response factory that throws ends the request with its error as the final message
- models-faux: a factory that waits is told through its signal when the request is interrupted
- models-faux: usage counts the prompt, and a session's repeated prefix is read from the cache
- models-unsupported: a method the provider lacks fails naming the method and the provider
- models-unsupported: a model whose provider is not in the models fails naming the provider

Package, `packages/harness/test/modes.test.ts`:

- mode-plan: plan mode offers only reading and submitting a plan, refuses a write, stores the plan, and leaving it gives every tool back
- mode-reviewer: a reviewer conversation runs its own model, extensions, read-only tools and checkout beside the main agent, and its loop asks again until the review is done
- mode-sandbox: each conversation's tools work in the sandbox its document names, looked up on every call, and a conversation without one gets no environment

## Gotchas

None recorded yet.
