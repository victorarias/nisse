import type { ConversationId, Delivery, Entry, LiveChange, SubmissionId } from "@nisse/protocol"
import { Effect, Stream } from "effect"
import { userName } from "./author.ts"
import { Client, followTree, startConversation, type StartOptions } from "./client.ts"
import { describeCall } from "./tui/calls.ts"

interface Watch {
  placed: boolean
  live: string
  printed: string
  outcome: "answered" | "failed" | undefined
  denials: Array<{ readonly conversation: ConversationId; readonly approval: Approval }>
}

type Approval = Extract<Entry["body"], { _tag: "approval" }>

const write = (text: string) => process.stdout.write(text)
const note = (text: string) => process.stderr.write(`${text}\n`)

const show = (watch: Watch, text: string) => {
  if (text.startsWith(watch.printed)) write(text.slice(watch.printed.length))
  else if (watch.printed.startsWith(text)) return
  else write(`\n${text}`)
  watch.printed = text
}

const endMessage = (watch: Watch) => {
  if (watch.printed) write("\n")
  watch.printed = ""
}

const onEntries = (
  watch: Watch,
  conversation: ConversationId,
  submission: SubmissionId,
  entries: ReadonlyArray<Entry>,
) => {
  for (const entry of entries) {
    const body = entry.body
    if (watch.outcome && body._tag === "user") return
    if (body._tag === "user" && body.submission === submission) watch.placed = true
    if (!watch.placed) continue
    switch (body._tag) {
      case "message":
        show(watch, body.text)
        endMessage(watch)
        break
      case "tool_call":
        endMessage(watch)
        note(`› ${describeCall(body.tool, body.input)}`)
        break
      case "approval":
        watch.denials.push({ conversation, approval: body })
        break
      case "toast":
        endMessage(watch)
        note(`◆ ${body.extension}: ${body.text}`)
        break
      case "run_end":
        endMessage(watch)
        if (body.outcome !== "answered") note(body.message ?? body.outcome)
        watch.outcome = body.outcome === "answered" ? "answered" : "failed"
    }
  }
}

const applyLive = (watch: Watch, changes: ReadonlyArray<LiveChange>) => {
  for (const change of changes) {
    if (change._tag === "text") watch.live += change.append
    else if (change._tag === "text_end" || change._tag === "clear") watch.live = ""
  }
}

const onDelivery = (watch: Watch, conversation: ConversationId, submission: SubmissionId) => (delivery: Delivery) =>
  Effect.sync(() => {
    if (delivery._tag === "snapshot") watch.live = delivery.live.text
    onEntries(watch, conversation, submission, delivery.entries)
    if (delivery._tag === "commit" && delivery.live) applyLive(watch, delivery.live)
    if (watch.placed && !watch.outcome) show(watch, watch.live)
  })

export const exec = Effect.fnUntraced(function* (prompt: string, id: string | undefined, options: StartOptions) {
  const client = yield* Client
  const conversation = yield* startConversation(client, id, options)
  const { submission } = yield* client["conversation/submit"]({
    conversation,
    requestId: crypto.randomUUID(),
    author: userName(),
    text: prompt,
  })
  const watch: Watch = { placed: false, live: "", printed: "", outcome: undefined, denials: [] }
  const refuse = (asked: ConversationId, approval: Approval) =>
    Effect.tap(
      client["approval/resolve"]({
        conversation: asked,
        approval: approval.approval,
        author: userName(),
        allow: false,
      }),
      ({ accepted }) =>
        Effect.sync(() => {
          if (accepted) {
            note(`denied ${describeCall(approval.tool, approval.input)}: exec cannot ask, pass --auto to allow calls`)
          }
        }),
    )
  const onSubagent = (subagent: ConversationId, delivery: Delivery) =>
    Effect.sync(() => {
      for (const { body } of delivery.entries) {
        if (body._tag === "approval") watch.denials.push({ conversation: subagent, approval: body })
      }
    })
  const deny = Effect.suspend(() =>
    Effect.forEach(watch.denials.splice(0), (denial) => refuse(denial.conversation, denial.approval)),
  )
  yield* followTree(client, conversation).pipe(
    Stream.tap(({ conversation: from, delivery }) =>
      from === conversation ? onDelivery(watch, conversation, submission)(delivery) : onSubagent(from, delivery),
    ),
    Stream.tap(() => deny),
    Stream.takeUntil(() => watch.outcome !== undefined),
    Stream.runDrain,
  )
  return watch.outcome === "answered"
})
