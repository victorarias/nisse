// Nisse's tool environment variables: what a command learns about the conversation that runs it.
import type { ToolExecutionApi } from "@nisse/harness"
import type { ConversationId } from "@nisse/kernel"
import { Effect } from "effect"
import type { BashExecution } from "./bash.ts"

/**
 * The conversation people started that `api`'s call runs under: its own, or, for a conversation a task owns (a
 * subagent), the root of its owner's conversation. A commit that only reads, so nothing is stored.
 */
export const rootConversation = (api: Pick<ToolExecutionApi, "conversationId" | "commit">) =>
  api.commit((tx) =>
    Effect.gen(function* () {
      let id: ConversationId = api.conversationId
      for (;;) {
        const owner = (yield* tx.conversation(id))?.owner
        if (owner === undefined) return id
        id = owner.conversationId
      }
    }),
  )

/** A `bash` `prepare` that sets `NISSE_ROOT_CONVERSATION` to the id of the conversation people started. */
export const rootConversationEnv = (execution: BashExecution, api: ToolExecutionApi) =>
  Effect.map(rootConversation(api), (root) => {
    execution.env.NISSE_ROOT_CONVERSATION = String(root)
  })
