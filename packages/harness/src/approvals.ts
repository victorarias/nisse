// Approvals (D13): a tool call that changes things waits for a person's answer before it runs. The request lives in
// the conversation's `nisse.approvals` document, which the view carries, keyed by the call's tool task. The first
// answer counts: the commit that answers finds the request unanswered or refuses. The request leaves the document in
// the commit that settles its tool task, so a request is listed exactly while its call is live.
import {
  type ConversationId,
  defineDoc,
  type DocError,
  idFromNumber,
  type JsonObject,
  type StorageError,
  type TaskId,
  type Tx,
} from "@nisse/kernel"
import { Effect } from "effect"

/** A person's answer to one call. */
export type ApprovalAnswer = { allow: boolean; author: string; at: number }

/** One call waiting for, or holding, its answer. */
export type ApprovalRequest = {
  callId: string
  tool: string
  arguments: JsonObject
  /** When the call asked. */
  at: number
  /** Present once answered; the call reads it and runs or settles denied. */
  answer?: ApprovalAnswer
}

export type ApprovalsState = {
  /** Every call runs without asking. */
  auto?: true
  /** By the call's tool task ID. */
  requests: Record<string, ApprovalRequest>
}

export const APPROVALS_KIND = "nisse.approvals"

export const ApprovalsDoc = defineDoc<ApprovalsState>({
  kind: APPROVALS_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A request belongs to its tool task, which a fork does not copy.
  fork: "initial",
  initial: () => ({ requests: {} }),
  checkpointWhen: () => true,
})

/** The entry an answer appends, so the transcript says who allowed or denied the call. */
export const APPROVAL_ENTRY_KIND = "nisse.approval"

export type ApprovalEntry = { approval: string; callId: string; tool: string; allow: boolean; author: string }

/** Makes every call of the conversation run without asking; for the commit that creates it. */
export const approveAutomatically = (tx: Tx, conversationId: ConversationId): Effect.Effect<void, DocError> =>
  Effect.map(tx.doc(ApprovalsDoc, conversationId), (doc) => {
    doc.auto = true
  })

/**
 * Answers the request `approval` (its tool task ID) in `tx`: `accepted` when it was waiting, `answered` when another
 * answer came first or its call has settled since, and `unknown` when the conversation has no such call. Reads a table,
 * so it comes before the commit's first table write.
 */
export const answerApproval = (
  tx: Tx,
  conversationId: ConversationId,
  approval: string,
  answer: { readonly allow: boolean; readonly author: string; readonly at: number },
): Effect.Effect<"accepted" | "answered" | "unknown", StorageError | DocError> =>
  Effect.gen(function* () {
    const taskId = /^[1-9][0-9]*$/.test(approval) ? idFromNumber<TaskId>(Number(approval)) : undefined
    const record = taskId === undefined ? undefined : yield* tx.task(taskId)
    if (record?.kind !== "pi.tool" || record.conversationId !== conversationId) return "unknown"
    const doc = yield* tx.doc(ApprovalsDoc, conversationId)
    const request = doc.requests[approval]
    if (request === undefined || request.answer !== undefined) return "answered"
    request.answer = { allow: answer.allow, author: answer.author, at: answer.at }
    const data: ApprovalEntry = {
      approval,
      callId: request.callId,
      tool: request.tool,
      allow: answer.allow,
      author: answer.author,
    }
    yield* tx.appendEntry(conversationId, { kind: APPROVAL_ENTRY_KIND, data })
    return "accepted"
  })

/** Removes the request of a settling tool task, in the commit that settles it. */
export const removeApproval = (tx: Tx, conversationId: ConversationId, taskId: TaskId): Effect.Effect<void, DocError> =>
  Effect.map(tx.doc(ApprovalsDoc, conversationId), (doc) => {
    delete doc.requests[String(taskId)]
  })
