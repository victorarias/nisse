import { describe, expect, it } from "bun:test"
import { appendText, applyImmutable, type Draft, type Op, type StringKeys, track } from "../src/delta/index.ts"

// #9265: streaming writers appended to growing strings by assignment, and the tracker's prefix check copied the whole
// string on every change.

type Block = { type: "text"; text: string; signature?: string; tags: string[] }
type Doc = { title: string; content: Block[]; meta: { note: string } }

function doc(): Doc {
  return { title: "t", content: [{ type: "text", text: "hello", tags: ["a"] }], meta: { note: "n" } }
}

/** Run `mutate` in one change, adopt it, and return its ops; checks that replaying the ops gives the new value. */
function commit<T extends object>(tracker: ReturnType<typeof track<T>>, mutate: (draft: Draft<T>) => void): Op[] {
  const base = tracker.value
  const change = tracker.beginChange()
  mutate(change.state)
  const prepared = change.prepare()
  expect(applyImmutable(base, prepared.ops)).toEqual(prepared.value)
  tracker.adopt(prepared)
  return [...prepared.ops]
}

describe("appendText", () => {
  it("doc-ops: records an append op and the appended value", () => {
    const tracker = track(doc())
    const before = tracker.value
    expect(commit(tracker, (draft) => appendText(draft.content[0]!, "text", " world"))).toEqual([
      ["a", ["content", 0, "text"], " world"],
    ])
    expect(tracker.value.content[0]!.text).toBe("hello world")
    expect(before.content[0]!.text).toBe("hello")
    expect(commit(tracker, (draft) => appendText(draft, "title", "!"))).toEqual([["a", ["title"], "!"]])
    expect(commit(tracker, (draft) => appendText(draft.meta, "note", "ote"))).toEqual([["a", ["meta", "note"], "ote"]])
    expect(tracker.value).toEqual({
      title: "t!",
      content: [{ type: "text", text: "hello world", tags: ["a"] }],
      meta: { note: "note" },
    })
  })

  it("doc-ops: joins several appends to one key in one change into one op, next to other changes", () => {
    const tracker = track(doc())
    const ops = commit(tracker, (draft) => {
      appendText(draft.content[0]!, "text", " a")
      draft.title = "new"
      appendText(draft.content[0]!, "text", " b")
      appendText(draft.content[0]!, "text", "")
      appendText(draft.content[0]!, "text", " c")
    })
    expect(ops).toContainEqual(["a", ["content", 0, "text"], " a b c"])
    expect(ops).toContainEqual(["s", ["title"], "new"])
    expect(ops).toHaveLength(2)
    expect(tracker.value.content[0]!.text).toBe("hello a b c")
  })

  it("doc-ops: falls back to the string comparison when the same key is also assigned or deleted", () => {
    const tracker = track(doc())
    expect(
      commit(tracker, (draft) => {
        appendText(draft.content[0]!, "text", " x")
        draft.content[0]!.text += " y"
      }),
    ).toEqual([["a", ["content", 0, "text"], " x y"]])
    expect(
      commit(tracker, (draft) => {
        appendText(draft.content[0]!, "text", " z")
        draft.content[0]!.text = "replaced"
      }),
    ).toEqual([["s", ["content", 0, "text"], "replaced"]])
    expect(
      commit(tracker, (draft) => {
        draft.title = "assigned"
        appendText(draft, "title", " then appended")
      }),
    ).toEqual([["s", ["title"], "assigned then appended"]])
    expect(
      commit(tracker, (draft) => {
        appendText(draft.meta, "note", "x")
        delete (draft.meta as { note?: string }).note
      }),
    ).toEqual([["d", ["meta", "note"]]])
  })

  it("doc-ops: appends inside a block the same change inserted or replaced", () => {
    const tracker = track(doc())
    commit(tracker, (draft) => {
      draft.content.push({ type: "text", text: "new", tags: [] })
      appendText(draft.content[1]!, "text", " block")
      draft.content[0] = { type: "text", text: "other", tags: [] }
      appendText(draft.content[0]!, "text", " one")
    })
    expect(tracker.value.content.map((block) => block.text)).toEqual(["other one", "new block"])
  })

  it("doc-ops: rejects what a JavaScript caller can get wrong", () => {
    const tracker = track(doc())
    const append = appendText as (draft: unknown, key: string, text: string) => void
    expect(() => append({ text: "plain object" }, "text", "x")).toThrow("appendText() needs a draft")
    const change = tracker.beginChange()
    expect(() => append(change.state, "content", "x")).toThrow('appendText() needs a string at "content"')
    expect(() => append(change.state, "missing", "x")).toThrow('appendText() needs a string at "missing"')
    expect(() => append(change.state.content, "0", "x")).toThrow('appendText() needs a string at "0"')
    const block = change.state.content[0]!
    change.prepare()
    expect(() => appendText(block, "text", "x")).toThrow("Cannot use a settled overlay")
    const aborted = tracker.beginChange()
    const state = aborted.state
    aborted.abort()
    expect(() => appendText(state, "title", "x")).toThrow("Cannot use a settled overlay")
  })

  it("doc-ops: accepts only keys whose type is exactly string", () => {
    type Keys = StringKeys<Block>
    const keys: Keys[] = ["text"]
    expect(keys).toEqual(["text"])
    const tracker = track(doc())
    const change = tracker.beginChange()
    const block = change.state.content[0]!
    // @ts-expect-error a string literal type
    expect(() => appendText(block, "type", "x")).not.toThrow()
    // @ts-expect-error an optional string
    expect(() => appendText(block, "signature", "x")).toThrow()
    // @ts-expect-error an array
    expect(() => appendText(block, "tags", "x")).toThrow()
    // @ts-expect-error array keys
    expect(() => appendText(change.state.content, 0, "x")).toThrow()
    change.abort()
  })
})
