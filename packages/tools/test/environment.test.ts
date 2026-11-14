// What a command learns about the conversation that runs it.
import { afterEach, expect, test } from "bun:test"
import { type TaskServices } from "@sigma/harness"
import { defineTask } from "@sigma/kernel"
import { fauxAssistantMessage, fauxToolCall } from "@sigma/models/faux"
import { Effect } from "effect"
import { createBashTool, rootConversationEnv } from "../src/index.ts"
import { openChat, removeDirectories, resultText, run } from "./support.ts"

afterEach(removeDirectories)

/** A task that holds the conversations it owns until the Harness closes. */
const Owner = defineTask<null, { readonly phase: "hold" }, null, TaskServices>({
  name: "test.owner",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: { hold: () => Effect.never },
  abort: (_task, runtime) =>
    runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "aborted" } })),
})

const echoRoot = () =>
  fauxAssistantMessage(fauxToolCall("bash", { command: 'printf "root=%s" "$SIGMA_ROOT_CONVERSATION"' }), {
    stopReason: "toolUse",
  })

test("tool-root-env-kernel: bash runs with SIGMA_ROOT_CONVERSATION set to the conversation people started, also in one a task of it owns", () =>
  run(
    Effect.gen(function* () {
      const chat = yield* openChat({
        tools: [createBashTool({ prepare: rootConversationEnv })],
        tasks: [Owner],
        responses: [echoRoot(), fauxAssistantMessage("done"), echoRoot(), fauxAssistantMessage("done")],
      })
      yield* chat.ask("where am I")
      // The owner keeps the root busy, so the root asks first.
      const taskId = yield* chat.root.commit((tx) =>
        tx.createTask(Owner, null, { ownership: { kind: "conversation" } }),
      )
      const child = yield* chat.harness.createConversation({ ownership: { kind: "task", taskId } })
      yield* chat.ask("and here", child)
      const expected = `root=${chat.root.id}`
      expect((yield* chat.toolResults(child)).map(resultText)).toEqual([expected])
      expect((yield* chat.toolResults()).map(resultText)).toEqual([expected])
      expect(child.id).not.toBe(chat.root.id)
    }),
  ))
