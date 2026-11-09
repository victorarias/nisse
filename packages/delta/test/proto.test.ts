import { afterEach, describe, expect, test } from "bun:test"
import { apply, applyImmutable, type Op, track, UnsafePathError } from "../src/delta/index.ts"
import { copyJson, type JsonValue } from "../src/json.ts"

// JSON.parse makes an own member named __proto__. Assigning it instead of defining it would set a prototype, and a
// later write into it would land on whatever that prototype is.
const streamed = () => JSON.parse('{"path":"xy","__proto__":{"polluted":true}}') as { [key: string]: JsonValue }

type Doc = { args: { [key: string]: JsonValue } }

// Each route takes the streamed arguments, then a second chunk writing inside the __proto__ member.
const routes: [string, () => Doc][] = [
  [
    "copyJson",
    () => {
      const copy = copyJson({ args: streamed() }) as Doc
      ;(copy.args["__proto__"] as { [key: string]: JsonValue })["more"] = 1
      return copy
    },
  ],
  [
    "tracker",
    () => {
      const tracker = track<Doc>({ args: {} })
      let change = tracker.beginChange()
      change.state.args = streamed()
      tracker.adopt(change.prepare())
      change = tracker.beginChange()
      ;(change.state.args["__proto__"] as { [key: string]: JsonValue })["more"] = 1
      tracker.adopt(change.prepare())
      return tracker.value
    },
  ],
  [
    "apply on a replica",
    () => {
      const tracker = track<Doc>({ args: {} })
      const ops: Op[] = []
      let change = tracker.beginChange()
      change.state.args = streamed()
      let prepared = change.prepare()
      ops.push(...prepared.ops)
      tracker.adopt(prepared)
      change = tracker.beginChange()
      ;(change.state.args["__proto__"] as { [key: string]: JsonValue })["more"] = 1
      prepared = change.prepare()
      ops.push(...prepared.ops)
      tracker.adopt(prepared)
      return apply({ args: {} }, ops) as Doc
    },
  ],
  [
    "applyImmutable",
    () =>
      applyImmutable({ args: {} }, [
        ["s", ["args"], JSON.parse('{"path":"xy","__proto__":{"polluted":true,"more":1}}')] as Op,
      ]) as unknown as Doc,
  ],
]

afterEach(() => {
  delete (Object.prototype as { polluted?: unknown }).polluted
  delete (Object.prototype as { more?: unknown }).more
})

describe.each(routes)("%s", (_name, route) => {
  test("doc-ops: a __proto__ key in streamed JSON stays data and cannot reach Object.prototype", () => {
    const { args } = route()
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual({ polluted: true, more: 1 })
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    expect(({} as { more?: unknown }).more).toBeUndefined()
  })
})

test.each([
  ["set", ["s", ["__proto__", "polluted"], true]],
  ["delete", ["d", ["constructor", "prototype", "polluted"]]],
] as [string, Op][])("doc-ops: a %s op addressed through __proto__ is refused", (_name, op) => {
  expect(() => apply({}, [op])).toThrow(UnsafePathError)
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
})
