#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
import { FakeOpenAi, matches } from "../../../packages/nisse/test/support/openai.ts"

const [port, log, refreshes, ...fixtures] = process.argv.slice(2)
if (!port || !log || !refreshes || fixtures.length === 0) {
  console.error("usage: fake-openai.ts <port> <log.ndjson> <refreshes> <fixture...>")
  process.exit(1)
}

const fake = new FakeOpenAi(Number(port))
const expected = fixtures.flatMap((fixture) => fake.play(fixture))
for (let refresh = 1; refresh <= Number(refreshes); refresh++) fake.issueTokens(`refresh-${refresh}`, 3600)
let answered = 0
fake.onResponse = (body) => {
  const want = expected[answered]
  const entry =
    want === undefined
      ? { request: answered + 1, verdict: "unscripted", body }
      : { request: answered + 1, verdict: matches(body, want) ? "as recorded" : "differs", body, expected: want }
  answered += 1
  appendFileSync(log, `${JSON.stringify(entry)}\n`)
  console.log(`request ${entry.request}: ${entry.verdict}`)
}
console.log(`fake ChatGPT on ${fake.base}, playing ${fixtures.join(", ")}: ${expected.length} requests`)
