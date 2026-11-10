import { describe, expect, test } from "bun:test"
import { fauxAssistantMessage } from "../src/faux.ts"
import { isRetryableAssistantError, retryDelayMs } from "../src/retry.ts"

const openAIExplicitRetryMessage =
  "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message."
const bedrockExplicitRetryMessage =
  '{"message":"The system encountered an unexpected error during processing. Try your request again."}'
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)"
const bunFetchSocketClosedMessage =
  "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event"
const wrappedDnsLookupError =
  "The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)"
const azurePeakLoadError =
  "The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput."

describe("provider retry classification", () => {
  test("models-retryable: matches explicit provider retry guidance", () => {
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
      ),
    ).toBe(true)
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
      ),
    ).toBe(true)
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
      ),
    ).toBe(true)
  })

  test("models-retryable: matches Bun fetch socket drop wording", () => {
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
      ),
    ).toBe(true)
  })

  test("models-retryable: matches upstream request buffer exhaustion wording", () => {
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Error: exceeded request buffer limit while retrying upstream",
        }),
      ),
    ).toBe(true)
  })

  test.each([
    wrappedDnsLookupError,
    "connect ENOTFOUND api.example.com",
    "EAI_AGAIN api.example.com",
    "getaddrinfo failed for api.example.com",
  ])("models-retryable: matches DNS transport failure wording: %s", (errorMessage) => {
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true)
  })

  test.each([
    "The pending stream has been canceled",
    "The pending stream has been canceled (caused by: socket closed)",
  ])("models-retryable: matches HTTP/2 pending stream cancellation: %s", (errorMessage) => {
    // Regression for #10379.
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true)
  })

  test.each([
    // Regression for #10965 (provider unknown, no status code in the message).
    "The service is temporarily unavailable. Please retry later.",
    // Bedrock ServiceUnavailableException as formatted by formatBedrockError.
    "Service unavailable: The service is temporarily unavailable.",
  ])("models-retryable: matches service unavailable wording: %s", (errorMessage) => {
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true)
  })

  test.each([
    // Regression for #10996: node-fetch errors from the google-vertex OAuth token refresh.
    "request to https://oauth2.googleapis.com/token failed, reason:",
    "request to https://oauth2.googleapis.com/token failed, reason: connect ECONNREFUSED 127.0.0.1:9",
  ])("models-retryable: matches node-fetch request failure wording: %s", (errorMessage) => {
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true)
  })

  test.each([
    // Regression for #10920: gateway upstream failures sent as `response.failed` error codes.
    "unknown: Unable to forward upstream stream",
    "upstream_error: Upstream request failed",
    "upstream_stream_read_error: Upstream response stream was interrupted",
    "Upstream HTTP/2 stream failed",
  ])("models-retryable: matches gateway upstream failure wording: %s", (errorMessage) => {
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true)
  })

  test("models-retryable: matches gateway wording for a stream cut short mid-reply", () => {
    // Regression for #11879.
    const errorMessage = "Claude Code's stream from Anthropic was cut short after the reply had begun"
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true)
  })

  test("models-retryable: matches OpenAI Responses streams that end before terminal events", () => {
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
      ),
    ).toBe(true)
  })

  test("models-retryable: matches Azure peak-load capacity errors", () => {
    // Regression for #9669.
    expect(
      isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: azurePeakLoadError })),
    ).toBe(true)
  })

  test("models-retryable: keeps provider limit errors non-retryable", () => {
    expect(
      isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" })),
    ).toBe(false)
  })

  test("models-retryable: keeps the ChatGPT subscription usage limit non-retryable", () => {
    const errorMessage =
      'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached."}'
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false)
  })

  test("models-retryable: keeps the ChatGPT Business workspace usage limit non-retryable", () => {
    const errorMessage =
      'OpenAI API error (429): {"code":"subscription_sharing_workplace_individual_usage_limit_exceeded","message":"Usage limit reached."}'
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false)
  })

  test.each([
    "subscription_sharing_usage_unavailable: Usage cannot be checked.",
    "subscription_sharing_user_unavailable: User cannot be loaded.",
  ])("models-retryable: retries temporary ChatGPT subscription errors: %s", (errorMessage) => {
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true)
  })

  test("models-retryable: classifies assistant error messages", () => {
    expect(
      isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
    ).toBe(true)
    // Regression for #9627.
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "520 status code (no body)" }),
      ),
    ).toBe(true)
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
      ),
    ).toBe(true)
    expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false)
  })

  test.each([
    // Regression for #11057: status codes inside ids or other numbers are not status codes.
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CU503xyz"}',
    "400 image exceeds 5 MB maximum: 5316784 bytes > 5242880 bytes",
  ])("models-retryable: does not match status codes inside ids or longer numbers: %s", (errorMessage) => {
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false)
  })
})

describe("retryDelayMs", () => {
  test("models-retryable: caps agent retry delay", () => {
    // Regression for #8826.
    expect(retryDelayMs({ baseDelayMs: 2000 }, 6)).toBe(60000)
    expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 5000 }, 5)).toBe(5000)
    expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 0 }, 5)).toBe(0)
  })
})
