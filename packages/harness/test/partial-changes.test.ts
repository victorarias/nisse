// `PartialChanges` through its public API: what a partial commit writes when the stream moves on between taking the
// changes and the commit that writes them, or when the copied partial is ahead of the events seen, orders only the
// throttle's timing and a provider writing its partial ahead of its events produce.
import { describe, expect, test } from "bun:test"
import { copyJson } from "@sigma/delta/json"
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@sigma/models"
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

describe("partial commits", () => {
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

  test("view-live: a partial copied ahead of the text events seen commits the copied text, never the deltas twice", () => {
    const text = (value: string): AssistantMessage =>
      ({ ...partial({}), content: [{ type: "text", text: value }] }) as unknown as AssistantMessage
    const textOf = (generation: NonNullable<LiveState["generation"]>) =>
      (generation.message?.content[0] as { text?: string } | undefined)?.text
    const changes = new PartialChanges()
    const generation: NonNullable<LiveState["generation"]> = { attempt: 1 }
    // The provider already wrote "rd" when the event for "wo" is handled.
    changes.observe({ type: "text_delta", contentIndex: 0, delta: "wo", partial: text("word") })
    const first = copy(text("word"))
    changes.commit(generation, first, changes.take(first))
    expect(textOf(generation)).toBe("word")
    // The events for "rd" and "_x" arrive while the provider is at "_xyz": the copy is ahead by exactly their length.
    changes.observe({ type: "text_delta", contentIndex: 0, delta: "rd", partial: text("word_xyz") })
    changes.observe({ type: "text_delta", contentIndex: 0, delta: "_x", partial: text("word_xyz") })
    const second = copy(text("word_xyz"))
    changes.commit(generation, second, changes.take(second))
    expect(textOf(generation)).toBe("word_xyz")
  })
})
