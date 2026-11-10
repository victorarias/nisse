// `PartialChanges` through its public API: a partial commit's tool-call arguments when the stream moves on between
// taking the changes and the commit that writes them, an order only the throttle's timing produces.
import { describe, expect, test } from "bun:test"
import { copyJson } from "@nisse/delta/json"
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@nisse/models"
import { type LiveState, PartialChanges, type PartialMessage } from "../src/index.ts"

const partial = (args: ToolCall["arguments"]): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id: "c0", name: "write", arguments: args }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: "pending",
    timestamp: 0,
  }) as unknown as AssistantMessage

const copy = (message: AssistantMessage) => copyJson(message, { omitUndefinedProperties: true }) as PartialMessage

const argumentsOf = (generation: NonNullable<LiveState["generation"]>) =>
  (generation.message?.content[0] as { arguments?: unknown } | undefined)?.arguments

describe("partial tool-call arguments", () => {
  test("view-partial-arguments: a call that ends between a partial's capture and its commit keeps the arguments streamed so far", () => {
    const changes = new PartialChanges()
    const events: AssistantMessageEvent[] = [
      { type: "toolcall_start", contentIndex: 0, partial: partial({}) },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"a.ts","text":"he',
        partial: partial({ path: "a.ts" }),
      },
    ]
    for (const event of events) changes.observe(event)
    const generation: NonNullable<LiveState["generation"]> = { attempt: 1 }

    // The first commit writes a new block whose call ended after its changes were taken.
    const first = copy(partial({ path: "a.ts", text: "he" }))
    const takenFirst = changes.take(first)
    changes.observe({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "c0", name: "write", arguments: { path: "a.ts", text: "hello" } },
      partial: partial({ path: "a.ts", text: "hello" }),
    })
    changes.commit(generation, first, takenFirst)
    expect(argumentsOf(generation)).toEqual({ path: "a.ts", text: "he" })
  })

  test("view-partial-arguments: a call already committed that ends before its next commit keeps the newer arguments", () => {
    const changes = new PartialChanges()
    changes.observe({ type: "toolcall_start", contentIndex: 0, partial: partial({}) })
    changes.observe({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a', partial: partial({ path: "a" }) })
    const generation: NonNullable<LiveState["generation"]> = { attempt: 1 }
    const first = copy(partial({ path: "a" }))
    changes.commit(generation, first, changes.take(first))
    expect(argumentsOf(generation)).toEqual({ path: "a" })

    changes.observe({ type: "toolcall_delta", contentIndex: 0, delta: '.ts"}', partial: partial({ path: "a.ts" }) })
    const second = copy(partial({ path: "a.ts" }))
    const takenSecond = changes.take(second)
    changes.observe({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "c0", name: "write", arguments: { path: "a.ts" } },
      partial: partial({ path: "a.ts" }),
    })
    changes.commit(generation, second, takenSecond)
    expect(argumentsOf(generation)).toEqual({ path: "a.ts" })
  })
})
