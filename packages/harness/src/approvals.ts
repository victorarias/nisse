// Approvals (D13): a tool call that changes things waits for a person's answer before it runs. The request lives in
// the conversation's `sigma.approvals` document, which the view carries, keyed by the call's tool task. The first
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
} from "@sigma/kernel"
import { Effect } from "effect"

/** Who answered a call: two strings the host chooses; the harness shows `name` and never reads `id`. */
export type Author = { readonly id: string; readonly name: string }

/** A person's answer to one call. */
export type ApprovalAnswer = { allow: boolean; author: Author; at: number }

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
  /** By the waiting task: a tool task's ID, or `<task>/<call>` for a call an agent running its own loop makes. */
  requests: Record<string, ApprovalRequest>
}

export const APPROVALS_KIND = "sigma.approvals"

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
export const APPROVAL_ENTRY_KIND = "sigma.approval"

export type ApprovalEntry = { approval: string; callId: string; tool: string; allow: boolean; author: Author }

/** Makes every call of the conversation run without asking; for the commit that creates it. */
export const approveAutomatically = (tx: Tx, conversationId: ConversationId): Effect.Effect<void, DocError> =>
  Effect.map(tx.doc(ApprovalsDoc, conversationId), (doc) => {
    doc.auto = true
  })

/**
 * Answers the request `approval` in `tx`: `accepted` when it was waiting, `answered` when another answer came first or
 * its call has settled since, and `unknown` when the conversation has no such call. A request is keyed by the task that
 * waits for it: a tool task's ID, or `<task>/<call>` for a call of an agent running its own loop, which asks through the
 * task that holds that agent's process. Reads a table, so it comes before the commit's first table write.
 */
export const answerApproval = (
  tx: Tx,
  conversationId: ConversationId,
  approval: string,
  answer: { readonly allow: boolean; readonly author: Author; readonly at: number },
): Effect.Effect<"accepted" | "answered" | "unknown", StorageError | DocError> =>
  Effect.gen(function* () {
    const doc = yield* tx.doc(ApprovalsDoc, conversationId)
    const request = Object.hasOwn(doc.requests, approval) ? doc.requests[approval] : undefined
    if (request === undefined) {
      // Settled since, when the waiting task is this conversation's.
      const waiting = /^([1-9][0-9]*)(?:\/.+)?$/.exec(approval)?.[1]
      const record = waiting === undefined ? undefined : yield* tx.task(idFromNumber<TaskId>(Number(waiting)))
      return record?.conversationId === conversationId ? "answered" : "unknown"
    }
    if (request.answer !== undefined) return "answered"
    const author = { id: answer.author.id, name: answer.author.name }
    request.answer = { allow: answer.allow, author, at: answer.at }
    const data: ApprovalEntry = {
      approval,
      callId: request.callId,
      tool: request.tool,
      allow: answer.allow,
      author,
    }
    yield* tx.appendEntry(conversationId, { kind: APPROVAL_ENTRY_KIND, data })
    return "accepted"
  })

/** Removes the request of a settling tool task, in the commit that settles it; `key` is the request's own key. */
export const removeApproval = (
  tx: Tx,
  conversationId: ConversationId,
  key: TaskId | string,
): Effect.Effect<void, DocError> =>
  Effect.map(tx.doc(ApprovalsDoc, conversationId), (doc) => {
    delete doc.requests[String(key)]
  })
