# @nisse/models

What the harness asks of a model: the message types entries store, the `Models`
seam, and the providers behind it.

## The seam

`Models` (`src/models.ts`) has pi-ai's call surface on Effect: `getModel`,
`getModelsOfType`, `getModelOfType`, `getAvailableOfType`, `streamSimple`,
`completeSimple`, `fetchDeferred`, `cancelDeferred`, `classify` and
`generateImages`. `fromProviders(providers, { identity })` builds one from
`Provider`s; a request goes to its model's provider.

- A method the provider does not implement fails with
  `Unsupported { method, provider }`. A model whose provider is not in this
  `Models` fails with `UnknownProvider { provider }`. These are the seam's only
  failures.
- A provider's own failure, such as an HTTP error, is the stream's final `error`
  event: an `AssistantMessage` with `stopReason: "error"`. The harness stores
  that message, and `isRetryableAssistantError` and `isContextOverflow` read it.
- Cancelling is interrupting. An interrupted stream emits nothing more, and the
  consumer keeps the partial it saw, so requests carry no `AbortSignal`.
- `streamSimple` normalizes the context into a transcript, merges the request's
  `identity` over the default one, and sets `durationMs` on the final message.

## Providers

- `scriptProvider(steps)` (`src/script.ts`) plays `NISSE_MODEL_SCRIPT`'s steps
  (`ScriptStep`): `text` word by word with `delayMs` before each word, a `tool`
  call, a `fail` error, and `agent` to give a subagent its own steps, matched to
  the request's `metadata.agent` (default `/root`). When the steps run out, it
  answers `You said: <the last user text>`, 30 ms per word, as today's script
  driver does. It has no deferred, classifier or image support.
- `fauxProvider(options)` (`@nisse/models/faux`) is pi-ai's faux provider on
  Effect, for tests: scripted responses one per request, a deferred response
  pending for `deferred.pendingFetches` fetches, cancellation, pacing by
  `tokensPerSecond`, and usage estimated from the prompt with a simulated prompt
  cache per `sessionId`.

ChatGPT joins them with `chatgpt-provider`.

## Copied code

From pi-ai (`packages/ai/src`) in earendil-works/pi at commit `7d073328e`, under
the MIT license in `LICENSE`:

| File                | From                                        | Left out                                          |
| ------------------- | ------------------------------------------- | ------------------------------------------------- |
| `types.ts`          | `types.ts`                                  | provider option and compat types, telemetry spans |
| `model-schema.ts`   | `providers/model-schema.ts`, as plain types | the catalog schemas                               |
| `estimate.ts`       | `utils/estimate.ts`                         |                                                   |
| `overflow.ts`       | `utils/overflow.ts`                         |                                                   |
| `retry.ts`          | `utils/retry.ts`                            | `retryAssistantCall`; the harness retries         |
| `streaming-json.ts` | `utils/streaming-json.ts`                   |                                                   |
| `json-parse.ts`     | `utils/json-parse.ts`                       | `parseStreamingJson` and `partial-json`           |
| `transcript.ts`     | `utils/transcript.ts`                       |                                                   |
| `text.ts`           | `utils/text.ts`                             |                                                   |
| `uuid.ts`           | `utils/uuid.ts`                             |                                                   |
| `identity.ts`       | `utils/identity.ts`                         | header formatting for other providers             |
| `diagnostics.ts`    | `utils/diagnostics.ts`                      |                                                   |
| `faux.ts`           | `providers/faux.ts`, ported to Effect       |                                                   |

`validation.ts` keeps pi-ai's `validateToolArguments` over `@nisse/schema`'s
`checkToolArguments`. `test/overflow.test.ts` and `test/retry.test.ts` are
pi-ai's tests for those files, on `bun:test`; `retry.test.ts` leaves out the
tests of `retryAssistantCall`.
