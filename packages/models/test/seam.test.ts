import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  fromProviders,
  isRetryableAssistantError,
  scriptProvider,
  SCRIPT_MODEL,
  type AssistantMessageEvent,
  type ClassifierModel,
  type Context,
  type Models,
} from "../src/index.ts"
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "../src/faux.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const events = (models: Models, context: Context, options = {}) =>
  run(Stream.runCollect(models.streamSimple(SCRIPT_MODEL, context, options)))
const said = (text: string): Context => ({ messages: [{ role: "user", content: text, timestamp: 0 }] })
const types = (list: readonly AssistantMessageEvent[]) => list.map((event) => event.type)
const deltas = (list: readonly AssistantMessageEvent[]) =>
  list.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []))

describe("the script provider", () => {
  test("models-script: a step's text streams word by word and ends the answer", async () => {
    const models = fromProviders([scriptProvider([{ text: "Hello there, friend." }])])
    const list = await events(models, said("hi"))
    expect(types(list)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_delta", "text_end", "done"])
    expect(deltas(list)).toEqual(["Hello ", "there, ", "friend."])
    const done = list.at(-1)!
    expect(done.type === "done" && done.message).toMatchObject({
      provider: "script",
      model: "script",
      stopReason: "stop",
      content: [{ type: "text", text: "Hello there, friend." }],
    })
    expect(done.type === "done" && done.message.durationMs).toBeNumber()
  })

  test("models-script: a tool step calls the tool and a fail step ends the request in error", async () => {
    const models = fromProviders([
      scriptProvider([
        { text: "Looking.", tool: { name: "read", input: { path: "a.txt" } } },
        { fail: "rate limited" },
      ]),
    ])
    const call = await run(models.completeSimple(SCRIPT_MODEL, said("go")))
    expect(call.stopReason).toBe("toolUse")
    expect(call.content).toMatchObject([
      { type: "text", text: "Looking." },
      { type: "toolCall", name: "read", arguments: { path: "a.txt" } },
    ])
    const failed = await events(models, said("again"))
    expect(failed.at(-1)).toMatchObject({ type: "error", reason: "error", error: { errorMessage: "rate limited" } })
  })

  test("models-script: with no step left it echoes the last user text, 30 ms per word", async () => {
    const models = fromProviders([scriptProvider([])])
    const answer = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(models.completeSimple(SCRIPT_MODEL, said("are you there")))
        yield* TestClock.adjust("149 millis")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 millis")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(answer.content).toEqual([{ type: "text", text: "You said: are you there" }])
  })

  test("models-script: each agent takes its own steps, named by the request's metadata", async () => {
    const models = fromProviders([scriptProvider([{ text: "child", agent: "/root/helper" }, { text: "root" }])])
    const text = async (agent?: string) => {
      const message = await run(
        models.completeSimple(SCRIPT_MODEL, said("x"), agent === undefined ? {} : { metadata: { agent } }),
      )
      return message.content
    }
    expect(await text()).toEqual([{ type: "text", text: "root" }])
    expect(await text("/root/helper")).toEqual([{ type: "text", text: "child" }])
  })
})

describe("the faux provider", () => {
  test("models-faux: scripted responses stream thinking, text and tool calls, one per request", async () => {
    const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } })
    const models = fromProviders([faux.provider])
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("hmm"), fauxText("abcdefgh"), fauxToolCall("echo", { a: 1 }, { id: "c1" })], {
        stopReason: "toolUse",
      }),
    ])
    // `partial` is shared between events, so the arguments each delta showed are copied as it arrives.
    const shown: unknown[] = []
    const list = await run(
      Stream.runCollect(
        Stream.tap(models.streamSimple(faux.getModel(), said("hi")), (event) =>
          Effect.sync(() => {
            if (event.type === "toolcall_delta") shown.push(structuredClone(event.partial.content[2]))
          }),
        ),
      ),
    )
    expect(types(list)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ])
    expect(shown).toEqual([
      { type: "toolCall", id: "c1", name: "echo", arguments: {} },
      { type: "toolCall", id: "c1", name: "echo", arguments: { a: 1 } },
    ])
    expect(faux.state.callCount).toBe(1)
    const none = await run(models.completeSimple(faux.getModel(), said("more")))
    expect(none).toMatchObject({ stopReason: "error", errorMessage: "No more faux responses queued" })
  })

  test("models-faux: a deferred response stays pending for the set fetches, then answers; a cancelled one fails", async () => {
    const faux = fauxProvider({ deferred: { pendingFetches: 1, pollAfterMs: 5000 } })
    const models = fromProviders([faux.provider])
    const model = faux.getModel()
    faux.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("never")])
    const first = await run(models.completeSimple(model, said("hi"), { deferred: true }))
    expect(first.stopReason).toBe("deferred")
    expect(first.deferred).toMatchObject({ provider: "faux", modelId: model.id, pollAfterMs: 5000 })
    const handle = first.deferred!
    expect((await run(models.fetchDeferred(model, handle))).stopReason).toBe("deferred")
    const ready = await run(models.fetchDeferred(model, handle))
    expect(ready).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "ready" }] })
    expect(faux.state.deferredFetchCount).toBe(2)

    const second = await run(models.completeSimple(model, said("hi"), { deferred: true }))
    await run(models.cancelDeferred(model, second.deferred!))
    expect(faux.state.cancelledDeferred).toEqual([second.deferred!])
    const cancelled = await run(models.fetchDeferred(model, second.deferred!))
    expect(cancelled).toMatchObject({ stopReason: "error" })
    expect(cancelled.errorMessage).toContain("was cancelled")
  })

  test("models-faux: a retryable provider error arrives as the final message, and the next request answers", async () => {
    const faux = fauxProvider()
    const models = fromProviders([faux.provider])
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage("fine"),
    ])
    const failed = await run(models.completeSimple(faux.getModel(), said("hi")))
    expect(failed.stopReason).toBe("error")
    expect(isRetryableAssistantError(failed)).toBe(true)
    const retried = await run(models.completeSimple(faux.getModel(), said("hi")))
    expect(retried.content).toEqual([{ type: "text", text: "fine" }])
  })

  test("models-faux: a response factory that throws ends the request with its error as the final message", async () => {
    const faux = fauxProvider()
    const models = fromProviders([faux.provider])
    faux.setResponses([
      () => {
        throw new Error("503 service unavailable")
      },
    ])
    const failed = await run(models.completeSimple(faux.getModel(), said("hi")))
    expect(failed).toMatchObject({ stopReason: "error", errorMessage: "503 service unavailable" })
    expect(isRetryableAssistantError(failed)).toBe(true)
  })

  test("models-faux: usage counts the prompt, and a session's repeated prefix is read from the cache", async () => {
    const faux = fauxProvider()
    const models = fromProviders([faux.provider])
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")])
    const first = await run(models.completeSimple(faux.getModel(), said("a long enough prompt"), { sessionId: "s" }))
    expect(first.usage).toMatchObject({ input: 0, cacheRead: 0 })
    expect(first.usage.cacheWrite).toBeGreaterThan(0)
    const second = await run(
      models.completeSimple(
        faux.getModel(),
        { messages: [...said("a long enough prompt").messages, first, ...said("next").messages] },
        { sessionId: "s" },
      ),
    )
    expect(second.usage.cacheRead).toBe(first.usage.cacheWrite)
  })
})

describe("unsupported methods", () => {
  test("models-unsupported: a method the provider lacks fails naming the method and the provider", async () => {
    const models = fromProviders([scriptProvider([])])
    const handle = { provider: "script", modelId: "script", api: "script", id: "h" }
    const fetched = await run(Effect.flip(models.fetchDeferred(SCRIPT_MODEL, handle)))
    expect(fetched).toMatchObject({ _tag: "Unsupported", method: "fetchDeferred", provider: "script" })
    expect(fetched.message).toBe("provider script does not support fetchDeferred")
    const judge: ClassifierModel<string> = {
      ...SCRIPT_MODEL,
      type: "classifier",
      contextWindow: 1000,
    }
    const classified = await run(Effect.flip(models.classify(judge, { state: {}, questions: {} })))
    expect(classified).toMatchObject({ _tag: "Unsupported", method: "classify", provider: "script" })
  })

  test("models-unsupported: a model whose provider is not in the models fails naming the provider", async () => {
    const models = fromProviders([scriptProvider([])])
    const error = await run(Effect.flip(models.completeSimple({ ...SCRIPT_MODEL, provider: "gone" }, said("hi"))))
    expect(error).toMatchObject({ _tag: "UnknownProvider", provider: "gone" })
    expect(models.getModel("gone", "script")).toBeUndefined()
    expect(models.getModel("script", "script")).toBe(SCRIPT_MODEL)
  })
})
