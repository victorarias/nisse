// A conversation's context derived from its entries by the rules of spec 2.1: the active range from the newest head
// marker, edits, positional system messages, tool result order, synthesized results and the leading baseline.
import type {
  ContextEdit,
  ConversationId,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  ReadFailure,
  Session,
} from "@nisse/kernel"
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@nisse/models"
import { Effect } from "effect"
import { SystemEntry } from "./entries.ts"
import type { ContextView } from "./types.ts"

const SCAN_PAGE_SIZE = 256
const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["aborted", "error", "deferred"])
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed."

/** The head marker and newest visible entry that fix one committed context range. */
type ContextBounds = {
  readonly head: (EntryRecord & { readonly head: EntryId }) | undefined
  readonly tail: EntryId
}

/**
 * The committed context of a conversation, or of its context cut off at the visible entry `at`. The bounds are read in
 * one step on the Session line; entries at or below the tail never change, so the range is then read page by page
 * beside the line, and commits go on meanwhile.
 */
export const readContext = (
  session: Session,
  conversationId: ConversationId,
  at?: EntryId,
): Effect.Effect<ContextView, ReadFailure> =>
  Effect.gen(function* () {
    const bounds = yield* session.read((storage) =>
      Effect.gen(function* () {
        let tail: EntryId | undefined
        if (at === undefined) {
          const newest = yield* storage.scanEntries({ conversationId, order: "descending" }, 1, undefined)
          tail = newest.items[0]?.id
          if (tail === undefined) return undefined
        } else {
          if ((yield* storage.entry(conversationId, at)) === undefined) {
            return yield* Effect.die(new Error(`Entry ${at} is not visible from conversation ${conversationId}`))
          }
          tail = at
        }
        return { head: yield* storage.findLatestHeadMarker(conversationId, tail), tail }
      }),
    )
    if (bounds === undefined) return { head: undefined, entries: [], contributions: [], messages: [] }
    const head = bounds.head
    const range: Omit<EntryQuery, "conversationId"> =
      head === undefined ? { maxEntryId: bounds.tail } : { minEntryId: head.head, maxEntryId: bounds.tail }
    const entries: EntryRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = yield* session.readOffLine((storage) =>
        storage.scanEntries({ conversationId, ...range }, SCAN_PAGE_SIZE, cursor),
      )
      entries.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return deriveContext(bounds, entries.reverse())
  })

/**
 * Derives the context view from the visible entries of `bounds`, oldest first. Per target the newest edit in the range
 * wins; context entries are the head marker followed by the range's non-head entries.
 */
function deriveContext(bounds: ContextBounds, entries: readonly EntryRecord[]): ContextView {
  const edits = new Map<EntryId, ContextEdit>()
  // Edits of every entry in the range count, older head markers included.
  for (const entry of entries) for (const edit of entry.edits ?? []) edits.set(edit.target, edit)
  const head = bounds.head
  const active = head === undefined ? entries : [head, ...entries.filter((entry) => entry.head === undefined)]
  const contributions = active.map((entry) => contribute(entry, edits.get(entry.id)))
  const messages = leadWithSystem(orderToolResults(contributions.flat()), findBaseline(head, active))
  return { head, entries: active, contributions, messages }
}

/** A baseline's system message, `null` when the range cannot have one, `undefined` when it has none. */
type Baseline = Message | null | undefined

/**
 * The baseline among `entries`: the system message of the first `pi.system` entry after the head marker, or of the
 * transcript without one, when generation wrote it with every section and tool in effect. After a head marker it
 * always does. Without one it does unless an earlier entry carries a system message, even one an edit omits later.
 */
function findBaseline(head: ContextBounds["head"], entries: readonly EntryRecord[]): Baseline {
  for (const entry of entries) {
    if (head !== undefined && entry.id <= head.id) continue
    if (SystemEntry.is(entry)) return messagesOf(entry).find((message) => message.role === "system") ?? null
    if (head === undefined && carriesSystemMessage(entry)) return null
  }
  return undefined
}

function carriesSystemMessage(entry: EntryRecord): boolean {
  const isSystem = (message: { readonly role?: unknown }) => message.role === "system"
  return (
    (entry.model?.some(isSystem) ?? false) ||
    (entry.edits?.some((edit) => edit.action === "replace" && edit.messages.some(isSystem)) ?? false)
  )
}

/**
 * Moves the first system message to the front when only user messages precede it, or when it is the baseline's. Only
 * the first moves, so replaying system messages in order gives the same sections and tools.
 */
function leadWithSystem(messages: Message[], baseline: Baseline): Message[] {
  const index = messages.findIndex((message) => message.role === "system")
  if (index <= 0) return messages
  const system = messages[index]!
  if (system !== baseline && messages.slice(0, index).some((message) => message.role !== "user")) return messages
  return [system, ...messages.slice(0, index), ...messages.slice(index + 1)]
}

const messagesOf = (entry: EntryRecord): readonly Message[] => (entry.model ?? []) as unknown as readonly Message[]

/** One active entry's model messages after its edit and the excluded stop reasons, before tool result ordering. */
function contribute(entry: EntryRecord, edit: ContextEdit | undefined): readonly Message[] {
  if (edit?.action === "omit") return []
  const contributed = edit?.action === "replace" ? (edit.messages as unknown as readonly Message[]) : messagesOf(entry)
  return contributed.filter((message) => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason))
}

/**
 * Places each assistant's tool results directly after it, in call order. Results are taken from the messages before the
 * next assistant message; a missing result is synthesized and unmatched results are dropped.
 */
export function orderToolResults(messages: readonly Message[]): Message[] {
  const ordered: Message[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === "toolResult") continue
    ordered.push(message)
    if (message.role !== "assistant") continue
    const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall")
    if (calls.length === 0) continue
    const results = new Map<string, number>()
    for (let next = index + 1; next < messages.length && messages[next]!.role !== "assistant"; next++) {
      const candidate = messages[next]!
      if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) results.set(candidate.toolCallId, next)
    }
    for (const call of calls) {
      const resultIndex = results.get(call.id)
      ordered.push(resultIndex === undefined ? missingResult(call, message.timestamp) : messages[resultIndex]!)
    }
  }
  return ordered
}

function missingResult(call: ToolCall, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: MISSING_RESULT_TEXT }],
    isError: true,
    details: { reason: "missing_result" },
    timestamp,
  }
}
