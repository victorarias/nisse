import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { checkToolArguments, type JsonSchema, projectParameters } from "../src/index.ts"

const fromEffect = (schema: Schema.Top & Schema.Constraint) =>
  projectParameters(Schema.toStandardJSONSchemaV1(schema as never)) as JsonSchema & object

const fromJson = {
  type: "object",
  properties: {
    count: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
    note: { type: "string" },
    text: { type: "string" },
  },
  required: ["count"],
} as const

const effect = Schema.Struct({
  count: Schema.Finite,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  note: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
})

const parameters: [string, JsonSchema & object][] = [
  ["JSON Schema", fromJson],
  ["Effect Schema", fromEffect(effect)],
]

describe.each(parameters)("%s parameters", (_, schema) => {
  test.each([
    ["a numeric string for a number", { count: "42" }, { count: 42 }],
    ["a single value for an array", { count: 1, tags: "one" }, { count: 1, tags: ["one"] }],
    ["null for an optional", { count: 1, note: null }, { count: 1 }],
    ["a number for a string", { count: 1, text: 1 }, { count: 1, text: "1" }],
    ["arguments already valid", { count: 1, text: "x" }, { count: 1, text: "x" }],
  ])("tool-argument-validation: a model sending %s still reaches the tool", (_case, args, value) => {
    expect(checkToolArguments("echo", schema, args)).toEqual({ ok: true, value })
  })

  test.each([
    ["an object for a string", { count: 1, text: { not: "a string" } }, "text"],
    ["a word for a number", { count: "many" }, "count"],
    ["a missing required argument", {}, "count"],
  ])("tool-argument-validation: a model sending %s gets an error it can read", (_case, args, path) => {
    const result = checkToolArguments("echo", schema, args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Validation failed for tool "echo"')
    expect(result.message).toContain(path)
  })
})

test("tool-argument-validation: a tool cannot tell a model it may send NaN", () => {
  expect(() => fromEffect(Schema.Struct({ nested: Schema.Struct({ n: Schema.Number }) }))).toThrow(
    /properties\/nested\/properties\/n.*NaN.*Schema\.Finite/,
  )
})

test('tool-argument-validation: a string parameter may still offer the word "NaN"', () => {
  const schema = fromEffect(
    Schema.Struct({ mode: Schema.Literals(["NaN", "normal"]), note: Schema.String.annotate({ default: "NaN" }) }),
  )
  expect(checkToolArguments("echo", schema, { mode: "NaN", note: "x" })).toEqual({
    ok: true,
    value: { mode: "NaN", note: "x" },
  })
})

test("tool-argument-validation: a coerced call leaves the transcript's arguments unchanged", () => {
  const args = { count: "42" }
  checkToolArguments("echo", fromJson, args)
  expect(args).toEqual({ count: "42" })
})
