import type { ConversationId, Delivery, Entry, SubmissionId } from "@nisse/protocol"
import { Effect, Stream } from "effect"
import { userName } from "./author.ts"
import { Client, follow } from "./client.ts"

interface Watch {
  placed: boolean
  printed: string
  outcome: "answered" | "failed" | undefined
}

const write = (text: string) => process.stdout.write(text)

const onEntries = (watch: Watch, submission: SubmissionId, entries: ReadonlyArray<Entry>) => {
  for (const entry of entries) {
    const body = entry.body
    if (watch.outcome && body._tag === "user") return
    if (body._tag === "user" && body.submission === submission) watch.placed = true
    else if (!watch.placed) continue
    else if (body._tag === "answer") {
      write(body.text.slice(watch.printed.length) + "\n")
      watch.outcome = body.interrupted ? "failed" : "answered"
    } else if (body._tag === "run_failed") {
      if (watch.outcome === undefined && watch.printed) write("\n")
      process.stderr.write(`${body.message}\n`)
      watch.outcome = "failed"
    }
  }
}

const onDelivery = (watch: Watch, submission: SubmissionId) => (delivery: Delivery) =>
  Effect.sync(() => {
    onEntries(watch, submission, delivery.entries)
    if (!watch.placed || watch.outcome) return
    const live =
      delivery._tag === "snapshot" ? delivery.live : delivery.live?._tag === "append" ? delivery.live.text : ""
    if (live) {
      write(live)
      watch.printed += live
    }
  })

export const exec = Effect.fnUntraced(function* (prompt: string, existing: string | undefined) {
  const client = yield* Client
  const conversation =
    (existing as ConversationId | undefined) ?? (yield* client["conversation/start"]({ cwd: process.cwd() })).id
  const { submission } = yield* client["conversation/submit"]({
    conversation,
    requestId: crypto.randomUUID(),
    author: userName(),
    text: prompt,
  })
  const watch: Watch = { placed: false, printed: "", outcome: undefined }
  yield* follow(client, conversation).pipe(
    Stream.tap(onDelivery(watch, submission)),
    Stream.takeUntil(() => watch.outcome !== undefined),
    Stream.runDrain,
  )
  return watch.outcome === "answered"
})
