import {
  LIVE_OUTPUT_TAIL,
  type ApprovalId,
  type CallId,
  type Conversation,
  type ConversationId,
  type Delivery,
  type Entry,
  type Queued,
  type Status,
} from "@nisse/protocol"

export interface PendingApproval {
  readonly approval: ApprovalId
  readonly call: CallId
}

export interface View {
  readonly id: ConversationId
  conversation: Conversation | undefined
  entries: Array<Entry>
  live: { text: string; output: Record<string, string> }
  queued: Array<Queued>
  status: Status
  workingSince: number | undefined
  results: Record<CallId, Entry>
  answers: Record<CallId, Entry>
  asked: Record<ApprovalId, CallId>
  pendingApprovals: Array<PendingApproval>
}

export const emptyView = (id: ConversationId): View => ({
  id,
  conversation: undefined,
  entries: [],
  live: { text: "", output: {} },
  queued: [],
  status: "idle",
  workingSince: undefined,
  results: {},
  answers: {},
  asked: {},
  pendingApprovals: [],
})

const setStatus = (view: View, status: Status, now: number) => {
  if (status === "idle") view.workingSince = undefined
  else if (view.status === "idle") view.workingSince = now
  view.status = status
}

const index = (view: View, entries: ReadonlyArray<Entry>) => {
  for (const entry of entries) {
    const body = entry.body
    if (body._tag === "tool_result") view.results[body.call] = entry
    else if (body._tag === "approval") {
      view.asked[body.approval] = body.call
      view.pendingApprovals.push({ approval: body.approval, call: body.call })
    } else if (body._tag === "approval_answer") {
      const call = view.asked[body.approval]
      if (call) view.answers[call] = entry
      view.pendingApprovals = view.pendingApprovals.filter((pending) => pending.approval !== body.approval)
    }
  }
}

export const apply = (view: View, delivery: Delivery, now: number) => {
  if (delivery._tag === "snapshot") {
    view.conversation = delivery.conversation
    view.entries = [...delivery.entries]
    view.results = {}
    view.answers = {}
    view.asked = {}
    view.pendingApprovals = []
    index(view, delivery.entries)
    view.live = { text: delivery.live.text, output: { ...delivery.live.output } }
    view.queued = [...delivery.queued]
    setStatus(view, delivery.status, now)
    return
  }
  if (delivery.entries.length > 0) {
    view.entries.push(...delivery.entries)
    index(view, delivery.entries)
    const placed = new Set(
      delivery.entries.flatMap((entry) => (entry.body._tag === "user" ? [entry.body.submission] : [])),
    )
    if (placed.size > 0) view.queued = view.queued.filter((queued) => !placed.has(queued.submission))
  }
  for (const change of delivery.live ?? []) {
    switch (change._tag) {
      case "text":
        view.live.text += change.append
        break
      case "text_end":
        view.live.text = ""
        break
      case "output":
        view.live.output[change.call] = ((view.live.output[change.call] ?? "") + change.append).slice(-LIVE_OUTPUT_TAIL)
        break
      case "output_end":
        delete view.live.output[change.call]
        break
      case "clear":
        view.live = { text: "", output: {} }
    }
  }
  if (delivery.enqueued) view.queued.push(delivery.enqueued)
  if (delivery.status) setStatus(view, delivery.status, now)
}
