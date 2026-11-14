// Tool result ordering of model context (spec 2.1, rule 7) for responses an agent running its own loop commits block by
// block, as Claude Code does: each block arrives as its own assistant message, and all of them share the response's id.
import { expect, test } from "bun:test"
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@sigma/models"
import { orderToolResults } from "../src/index.ts"

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** An assistant message calling `calls`, or saying `text`, as part of response `response`. */
const said = (response: string | undefined, part: { calls?: string[]; text?: string }): AssistantMessage => ({
  role: "assistant",
  content: [
    ...(part.text === undefined ? [] : [{ type: "text" as const, text: part.text }]),
    ...(part.calls ?? []).map((id) => ({ type: "toolCall" as const, id, name: "Read", arguments: {} })),
  ],
  api: "claude-code",
  provider: "claude",
  model: "haiku",
  ...(response === undefined ? {} : { responseId: response }),
  usage,
  stopReason: "toolUse",
  timestamp: 1,
})
const result = (id: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "Read",
  content: [{ type: "text", text: `read ${id}` }],
  isError: false,
  timestamp: 2,
})
const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 3 })

/** A message as a short label: `A(a,b)`, `A:text`, `R(a)`, `MISSING(a)`, `U:text`. */
const label = (message: Message): string => {
  if (message.role === "user") return `U:${message.content as string}`
  if (message.role === "toolResult") {
    const missing = (message.details as { reason?: string } | undefined)?.reason === "missing_result"
    return `${missing ? "MISSING" : "R"}(${message.toolCallId})`
  }
  if (message.role !== "assistant") return message.role
  const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
  return calls.length > 0 ? `A(${calls.join(",")})` : `A:${text}`
}

const cases: Array<[string, Message[], string[]]> = [
  [
    "parallel calls committed block by block, results after both",
    [said("m1", { calls: ["a"] }), said("m1", { calls: ["b"] }), result("a"), result("b")],
    ["A(a)", "A(b)", "R(a)", "R(b)"],
  ],
  [
    "a result that lands between the blocks of its response",
    [said("m1", { calls: ["a"] }), result("a"), said("m1", { calls: ["b"] }), result("b")],
    ["A(a)", "A(b)", "R(a)", "R(b)"],
  ],
  [
    "text then a call in one response",
    [said("m1", { text: "Reading." }), said("m1", { calls: ["a"] }), result("a"), said("m2", { text: "Done." })],
    ["A:Reading.", "A(a)", "R(a)", "A:Done."],
  ],
  [
    "a call of one response never takes a result after the next response",
    [said("m1", { calls: ["a"] }), said("m2", { calls: ["b"] }), result("a"), result("b")],
    ["A(a)", "MISSING(a)", "A(b)", "R(b)"],
  ],
  [
    "a steer between the response and its results moves after the results",
    [said("m1", { calls: ["a"] }), said("m1", { calls: ["b"] }), user("also this"), result("b"), result("a")],
    ["A(a)", "A(b)", "R(a)", "R(b)", "U:also this"],
  ],
  [
    "a response cut off before its second call's result",
    [said("m1", { calls: ["a"] }), said("m1", { calls: ["b"] }), result("a")],
    ["A(a)", "A(b)", "R(a)", "MISSING(b)"],
  ],
  [
    "messages without a response id stay one response each",
    [said(undefined, { calls: ["a"] }), said(undefined, { calls: ["b"] }), result("a"), result("b")],
    ["A(a)", "MISSING(a)", "A(b)", "R(b)"],
  ],
]

for (const [name, messages, expected] of cases) {
  test(`context-synthesized-results: ${name}`, () => {
    expect(orderToolResults(messages).map(label)).toEqual(expected)
  })
}
