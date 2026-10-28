import type { Conversation, ConversationId, Delivery, Entry, Queued, Status } from "@nisse/protocol"

export interface View {
  readonly id: ConversationId
  conversation: Conversation | undefined
  entries: Array<Entry>
  live: string
  queued: Array<Queued>
  status: Status
  workingSince: number | undefined
}

export const emptyView = (id: ConversationId): View => ({
  id,
  conversation: undefined,
  entries: [],
  live: "",
  queued: [],
  status: "idle",
  workingSince: undefined,
})

const setStatus = (view: View, status: Status, now: number) => {
  if (status === "working" && view.status !== "working") view.workingSince = now
  if (status === "idle") view.workingSince = undefined
  view.status = status
}

export const apply = (view: View, delivery: Delivery, now: number) => {
  if (delivery._tag === "snapshot") {
    view.conversation = delivery.conversation
    view.entries = [...delivery.entries]
    view.live = delivery.live
    view.queued = [...delivery.queued]
    setStatus(view, delivery.status, now)
    return
  }
  if (delivery.entries.length > 0) {
    view.entries.push(...delivery.entries)
    const placed = new Set(
      delivery.entries.flatMap((entry) => (entry.body._tag === "user" ? [entry.body.submission] : [])),
    )
    if (placed.size > 0) view.queued = view.queued.filter((queued) => !placed.has(queued.submission))
  }
  if (delivery.live) view.live = delivery.live._tag === "append" ? view.live + delivery.live.text : ""
  if (delivery.enqueued) view.queued.push(delivery.enqueued)
  if (delivery.status) setStatus(view, delivery.status, now)
}
