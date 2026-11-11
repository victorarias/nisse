// The ChatGPT provider's grammar tools, through the `Models` seam: a promise no wire test reaches until a kernel tool
// has a grammar. ChatGPT is played by a server that answers with a recorded code-mode exchange.
import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fromProviders, type Context, type Tool, type ToolCall } from "@nisse/models"
import { chatGptInstance } from "@nisse/models/chatgpt"

const FIXTURE = join(import.meta.dir, "../../../fixtures/openai/code_mode_script.ndjson")

/** The recording's first request and the events that answered it. */
const recorded = () => {
  const lines = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
  const second = lines.findIndex((line, i) => line.type === "expect_outbound" && i > 1)
  return {
    events: lines.slice(0, second).flatMap((line) => (line.type === "emit_inbound" ? [line.frame] : [])),
    next: lines[second].frame,
  }
}

const EXEC: Tool = {
  name: "exec",
  description: "Runs JavaScript.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[\\s\\S]+/" } },
}

test("openai-grammar-tools: a grammar tool is offered as a custom tool, its raw input arrives as its one argument and goes back raw", async () => {
  const { events, next } = recorded()
  const bodies: Array<any> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      bodies.push(await request.json())
      const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
      return new Response(sse, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const home = mkdtempSync("/tmp/nisse-models-")
  try {
    const authPath = join(home, "auth.json")
    writeFileSync(
      authPath,
      JSON.stringify({
        access_token: "a.b.c",
        refresh_token: "r",
        expires_at_ms: Date.now() + 3_600_000,
        account_id: "x",
      }),
    )
    const base = `http://127.0.0.1:${server.port}`
    const instance = await Effect.runPromise(
      Effect.scoped(
        chatGptInstance("openai", {
          authPath,
          modelsPath: join(home, "models.json"),
          authBase: base,
          baseUrl: base,
          callbackPort: 0,
          instructions: "",
        }),
      ),
    )
    const models = fromProviders([instance.provider!])
    const model = models.getModel("openai", "gpt-6.1-sol")!
    const context: Context = {
      tools: [EXEC],
      messages: [{ role: "user", content: "what does echo say?", timestamp: 0 }],
    }
    const answer = await Effect.runPromise(models.completeSimple(model, context))

    expect(bodies[0].tools).toEqual([
      {
        type: "custom",
        name: "exec",
        description: "Runs JavaScript.",
        format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
      },
    ])
    const script = next.input[1].input as string
    const call = answer.content.find((block): block is ToolCall => block.type === "toolCall")
    expect(answer.stopReason).toBe("toolUse")
    expect(call).toMatchObject({ id: "call_1", name: "exec", arguments: { code: script } })

    // The call and its result go back as the recording's next request has them.
    await Effect.runPromise(
      Stream.runDrain(
        models.streamSimple(model, {
          ...context,
          messages: [
            ...context.messages,
            answer,
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "exec",
              content: [{ type: "text", text: "hi\n" }],
              isError: false,
              timestamp: 0,
            },
          ],
        }),
      ),
    )
    expect(bodies[1].input).toEqual([
      next.input[0],
      next.input[1],
      { type: "custom_tool_call_output", call_id: "call_1", output: "hi\n" },
    ])
  } finally {
    await server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
})
