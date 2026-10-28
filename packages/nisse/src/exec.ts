import type { ConversationId, Delivery, Entry, SubmissionId } from "@nisse/protocol"
import { Effect, Stream } from "effect"
import { userName } from "./author.ts"
import { Client, follow } from "./client.ts"

interface Watch {
  placed: boolean
  live: string
  printed: string
  outcome: "answered" | "failed" | undefined
}

const write = (text: string) => process.stdout.write(text)

const show = (watch: Watch, text: string) => {
  if (text.startsWith(watch.printed)) write(text.slice(watch.printed.length))
  else if (watch.printed.startsWith(text)) return
  else write(`\n${text}`)
  watch.printed = text
}

const onEntries = (watch: Watch, submission: SubmissionId, entries: ReadonlyArray<Entry>) => {
  for (const entry of entries) {
    const body = entry.body
    if (watch.outcome && body._tag === "user") return
    if (body._tag === "user" && body.submission === submission) watch.placed = true
    else if (!watch.placed) continue
    else if (body._tag === "answer") {
      show(watch, body.text)
      if (watch.printed) write("\n")
      if (body.interrupted) process.stderr.write("interrupted\n")
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
    if (delivery._tag === "snapshot") watch.live = delivery.live
    else if (delivery.live) watch.live = delivery.live._tag === "append" ? watch.live + delivery.live.text : ""
    onEntries(watch, submission, delivery.entries)
    if (watch.placed && !watch.outcome) show(watch, watch.live)
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
  const watch: Watch = { placed: false, live: "", printed: "", outcome: undefined }
  yield* follow(client, conversation).pipe(
    Stream.tap(onDelivery(watch, submission)),
    Stream.takeUntil(() => watch.outcome !== undefined),
    Stream.runDrain,
  )
  return watch.outcome === "answered"
})
