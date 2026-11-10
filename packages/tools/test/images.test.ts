// Images people attach and images `read` returns, as the model receives them.
import { afterEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Message } from "@nisse/models"
import { fauxAssistantMessage, fauxToolCall } from "@nisse/models/faux"
import { Effect } from "effect"
import { createReadTool } from "../src/index.ts"
import { openChat, removeDirectories, run } from "./support.ts"

afterEach(removeDirectories)

// A 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const images = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === "user" || message.role === "toolResult"
      ? typeof message.content === "string"
        ? []
        : message.content.flatMap((block) => (block.type === "image" ? [`${message.role}:${block.mimeType}`] : []))
      : [],
  )

test("image-input, image-tool-result: an attached image and an image read from a file reach the model as images", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createReadTool()],
        responses: [
          fauxAssistantMessage(fauxToolCall("read", { path: "dot.png" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("a dot"),
        ],
      })
      writeFileSync(join(chat.workspace, "dot.png"), Buffer.from(PNG, "base64"))
      yield* chat.ask([
        { type: "text", text: "compare with dot.png" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ])
      expect(chat.requests.map(images)).toEqual([["user:image/png"], ["user:image/png", "toolResult:image/png"]])
      const [result] = yield* chat.toolResults()
      expect(result!.content[0]).toEqual({ type: "image", data: PNG, mimeType: "image/png" })
    }),
  ))
