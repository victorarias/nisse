// A conversation's context derived from its entries by the rules of spec 2.1: the active range from the newest head
// marker, edits, positional system messages, tool result order, synthesized results and the leading baseline. Task
// reads keep their range per conversation, so a later read scans only newer entries.
import type {
  CommitPublication,
  ContextEdit,
  ConversationId,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  ReadFailure,
  Session,
  TaskId,
} from "@nisse/kernel"
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@nisse/models"
import { Clock, Effect, Fiber } from "effect"
import { SystemEntry } from "./entries.ts"
import type { ContextView } from "./types.ts"

const SCAN_PAGE_SIZE = 256
const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["aborted", "error", "deferred"])
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed."
/**
 * Conversations whose newest entry ID is known from commits: IDs only, so many. pi-durable's bound; past it the least
 * recently written conversation is forgotten, and its next read probes Storage for one row.
 */
const LATEST_CAPACITY = 4096

/** The head marker and newest visible entry that fix one committed context range. */
type ContextBounds = {
  readonly head: (EntryRecord & { readonly head: EntryId }) | undefined
  readonly tail: EntryId
}

/**
 * The visible entries of one read, from the head marker's head (or transcript start) through `bounds.tail`, oldest
 * first, and the view derived from them. Entries at or below the tail never change, so a later read with the same head
 * marker extends both.
 */
type ContextRange = {
  readonly bounds: ContextBounds
  readonly entries: readonly EntryRecord[]
  readonly view: ContextView
  /** Targets of the edits in `entries`. */
  readonly edited: ReadonlySet<EntryId>
  /**
   * `view.messages` from the contributed messages before the last assistant message. Tool results are ordered within
   * the messages up to the next assistant message, so later entries cannot change these.
   */
  readonly settled: readonly Message[]
  /** Contributed messages from the last assistant message on, before tool result ordering. */
  readonly open: readonly Message[]
  readonly baseline: Baseline
  /** Whether the range reached the conversation's newest entry, so later commits' entries extend it. */
  readonly current: boolean
}

/** A kept range; `idleSince` is the clock time its conversation was seen idle, `undefined` while busy. */
type Kept = {
  range: ContextRange
  idleSince: number | undefined
  /** Waits for the conversation to go idle, then for the retention to pass. */
  fiber: Fiber.Fiber<void, unknown> | undefined
}

/** The task that reads: its ID, its conversation, and the signal its invocation's end aborts. */
export type ContextReader = {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
  readonly signal: AbortSignal
}

export type ContextReadsOptions = {
  readonly now: () => number
  /** `settings.contextRetentionMs`, read at each use. */
  readonly retentionMs: () => number
  readonly waitForIdle: (conversationId: ConversationId) => Effect.Effect<void, unknown>
  /** The Harness's clock, for the retention timer. */
  readonly clock: Clock.Clock
}

/**
 * The context reads of one Harness. A task's read keeps its range per conversation, and every commit's entries extend
 * the kept ranges of their conversation, so a later read by any task scans nothing it already has. A range is kept while
 * its conversation is busy and for `contextRetentionMs` once idle; it is derived, never stored, and dropped at close.
 */
export class ContextReads {
  readonly #session: Session
  readonly #options: ContextReadsOptions
  /** Newest entry ID per conversation from the Session's commits, `null` for none; the newest is the last key. */
  readonly #latest = new Map<ConversationId, EntryId | null>()
  readonly #kept = new Map<ConversationId, Kept>()
  /**
   * Tasks with reads in flight, and whether a commit ended the task since: its invocation can outlive that commit
   * until its handler returns, and a read finished then must not be kept.
   */
  readonly #readers = new Map<TaskId, { reads: number; ended: boolean }>()
  #closed = false

  constructor(session: Session, options: ContextReadsOptions) {
    this.#session = session
    this.#options = options
    session.observeCommits({ advance: (publication) => this.#advance(publication), end: () => this.#close() })
    session.subscribeClose(() => this.#close())
  }

  /** `readContext`, with the newest entry known from commits. Keeps nothing. */
  read(conversationId: ConversationId, at?: EntryId): Effect.Effect<ContextView, ReadFailure> {
    return Effect.gen({ self: this }, function* () {
      return yield* deriveContext(this.#session, conversationId, yield* this.#bounds(conversationId, at, false))
    })
  }

  /**
   * `read` for a task: reuses the conversation's kept range, scanning only entries after its tail under the same head
   * marker, and keeps the result unless the reader's invocation ended first.
   */
  readFor(
    reader: ContextReader,
    conversationId: ConversationId,
    at?: EntryId,
  ): Effect.Effect<ContextView, ReadFailure> {
    const read = Effect.gen({ self: this }, function* () {
      const previous = this.#unexpired(conversationId)?.range
      const visible = at !== undefined && previous !== undefined && rangeEntry(previous, at) !== undefined
      const bounds = yield* this.#bounds(conversationId, at, visible)
      if (bounds === undefined) return emptyView()
      freezeJson(bounds.head)
      const current = at === undefined
      let range: ContextRange
      if (previous === undefined || previous.bounds.head?.id !== bounds.head?.id) {
        const entries = yield* scanRange(this.#session, conversationId, rangeQuery(bounds))
        range = deriveRange(bounds, freezeJson(entries), current)
      } else if (bounds.tail === previous.bounds.tail) {
        range = previous
      } else if (bounds.tail < previous.bounds.tail) {
        range = deriveRange(
          bounds,
          previous.entries.filter((entry) => entry.id <= bounds.tail),
          false,
        )
      } else {
        const minEntryId = (previous.bounds.tail + 1) as EntryId
        const added = yield* scanRange(this.#session, conversationId, { minEntryId, maxEntryId: bounds.tail })
        range = extendRange(previous, bounds, freezeJson(added), current)
      }
      // Entries committed while the scan ran beside the line are not in it: current only if none was.
      if (range.current && this.#latest.get(conversationId) !== range.bounds.tail) range = { ...range, current: false }
      this.#keep(reader, conversationId, range)
      const { view } = range
      return {
        ...view,
        entries: [...view.entries],
        contributions: [...view.contributions],
        messages: [...view.messages],
      }
    })
    return Effect.suspend(() => {
      const known = this.#readers.get(reader.taskId)
      if (known === undefined) this.#readers.set(reader.taskId, { reads: 1, ended: false })
      else known.reads++
      return Effect.ensuring(
        read,
        Effect.sync(() => {
          const counted = this.#readers.get(reader.taskId)!
          if (--counted.reads === 0) this.#readers.delete(reader.taskId)
        }),
      )
    })
  }

  /** The bounds; the newest entry is known from commits, so this rarely reads Storage for it. */
  #bounds(
    conversationId: ConversationId,
    at: EntryId | undefined,
    visible: boolean,
  ): Effect.Effect<ContextBounds | undefined, ReadFailure> {
    return readBounds(this.#session, conversationId, at, visible, {
      get: () => this.#latest.get(conversationId),
      // On the line nothing unpublished appends to it: the probe holds until the next commit's entry.
      set: (latest) => this.#remember(conversationId, latest),
    })
  }

  /**
   * Keeps `range` unless the reader's invocation ended, the Harness is closing, or a newer range is kept. A read of its
   * own conversation makes that busy; a read of an idle one keeps its idle period and expiry.
   */
  #keep(reader: ContextReader, conversationId: ConversationId, range: ContextRange): void {
    if (this.#closed || reader.signal.aborted || this.#readers.get(reader.taskId)?.ended === true) return
    const kept = this.#kept.get(conversationId)
    if (kept === undefined) {
      const created: Kept = { range, idleSince: undefined, fiber: undefined }
      this.#kept.set(conversationId, created)
      this.#watch(conversationId, created)
      return
    }
    if (kept.range.bounds.tail > range.bounds.tail) return
    kept.range = range
    if (reader.conversationId === conversationId && kept.idleSince !== undefined) {
      kept.idleSince = undefined
      this.#watch(conversationId, kept)
    }
  }

  /** The kept range, dropped first when its idle period passed the retention. */
  #unexpired(conversationId: ConversationId): Kept | undefined {
    const kept = this.#kept.get(conversationId)
    if (kept === undefined || !this.#expired(kept)) return kept
    this.#drop(conversationId)
    return undefined
  }

  /** Whether an idle range passed the retention of now; with none, every idle range has. */
  #expired(kept: Kept): boolean {
    if (kept.idleSince === undefined) return false
    const retention = this.#retention()
    return retention <= 0 || this.#options.now() - kept.idleSince >= retention
  }

  /**
   * Waits for the conversation to go idle, then starts its idle period: with no retention the range is dropped,
   * otherwise it is dropped once the retention passes. A later busy period starts a new watch.
   */
  #watch(conversationId: ConversationId, kept: Kept): void {
    if (kept.fiber !== undefined) Effect.runFork(Fiber.interrupt(kept.fiber))
    const owns = () => this.#kept.get(conversationId) === kept
    const watch = Effect.gen({ self: this }, function* () {
      yield* Effect.ignore(this.#options.waitForIdle(conversationId))
      if (!owns()) return
      kept.idleSince ??= this.#options.now()
      while (owns()) {
        const retention = this.#retention()
        const left = kept.idleSince + retention - this.#options.now()
        if (retention <= 0 || left <= 0) {
          this.#drop(conversationId)
          return
        }
        yield* Effect.sleep(left)
      }
    })
    kept.fiber = Effect.runFork(Effect.provideService(watch, Clock.Clock, this.#options.clock))
  }

  /** On the line, at each stored commit: remember the newest entries and extend the kept ranges they belong to. */
  #advance(publication: CommitPublication): void {
    let appended: Map<ConversationId, EntryRecord[]> | undefined
    for (const change of publication.changes) {
      if (change.type === "conversation") {
        // A new conversation sees no entries; a fork sees its parent's through the fork point.
        if (change.value.parent === undefined) this.#remember(change.value.id, null)
      } else if (change.type === "entry") {
        const entry = change.value
        this.#remember(entry.conversationId, entry.id)
        if (!this.#kept.has(entry.conversationId)) continue
        appended ??= new Map()
        const entries = appended.get(entry.conversationId)
        if (entries === undefined) appended.set(entry.conversationId, [entry])
        else entries.push(entry)
      } else if (change.type === "task") {
        // Live foreground work in an idle conversation makes it busy, unless its idle period already passed.
        const record = change.value
        const status = record.state.status
        if (status === "terminal" || status === "completing") {
          const reading = this.#readers.get(record.id)
          if (reading !== undefined) reading.ended = true
        }
        const kept = this.#kept.get(record.conversationId)
        if (kept?.idleSince === undefined || record.background || status === "terminal") continue
        if (this.#expired(kept)) {
          this.#drop(record.conversationId)
          continue
        }
        kept.idleSince = undefined
        // Not from the line: the watch starts in a microtask.
        queueMicrotask(() => {
          if (this.#kept.get(record.conversationId) === kept && kept.idleSince === undefined) {
            this.#watch(record.conversationId, kept)
          }
        })
      }
    }
    if (appended === undefined) return
    for (const [conversationId, entries] of appended) {
      const kept = this.#unexpired(conversationId)
      if (kept === undefined) continue
      const range = advanceRange(kept.range, entries)
      if (range === undefined) this.#drop(conversationId)
      else kept.range = range
    }
  }

  #remember(conversationId: ConversationId, latest: EntryId | null): void {
    this.#latest.delete(conversationId)
    this.#latest.set(conversationId, latest)
    if (this.#latest.size > LATEST_CAPACITY) this.#latest.delete(this.#latest.keys().next().value!)
  }

  /** `settings.contextRetentionMs`, or 0 when the host's settings throw: kept ranges are only a cache. */
  #retention(): number {
    try {
      return this.#options.retentionMs()
    } catch {
      return 0
    }
  }

  #drop(conversationId: ConversationId): void {
    const kept = this.#kept.get(conversationId)
    if (kept === undefined) return
    this.#kept.delete(conversationId)
    if (kept.fiber !== undefined) Effect.runFork(Fiber.interrupt(kept.fiber))
  }

  #close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const conversationId of [...this.#kept.keys()]) this.#drop(conversationId)
    this.#latest.clear()
  }
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
  Effect.flatMap(readBounds(session, conversationId, at, false, undefined), (bounds) =>
    deriveContext(session, conversationId, bounds),
  )

const deriveContext = (
  session: Session,
  conversationId: ConversationId,
  bounds: ContextBounds | undefined,
): Effect.Effect<ContextView, ReadFailure> =>
  bounds === undefined
    ? Effect.succeed(emptyView())
    : Effect.map(
        scanRange(session, conversationId, rangeQuery(bounds)),
        (entries) => deriveRange(bounds, entries, false).view,
      )

/**
 * Reads the bounds in one step on the line: the newest entry (from `latest` when it knows it) or the visible cutoff
 * `at`, then the newest head marker at or before it. `visible` skips the check that `at` is visible.
 */
const readBounds = (
  session: Session,
  conversationId: ConversationId,
  at: EntryId | undefined,
  visible: boolean,
  latest: { get(): EntryId | null | undefined; set(latest: EntryId | null): void } | undefined,
): Effect.Effect<ContextBounds | undefined, ReadFailure> =>
  session.read((storage) =>
    Effect.gen(function* () {
      let tail: EntryId | undefined
      if (at === undefined) {
        const known = latest?.get()
        if (known === undefined) {
          const newest = yield* storage.scanEntries({ conversationId, order: "descending" }, 1, undefined)
          tail = newest.items[0]?.id
          latest?.set(tail ?? null)
        } else {
          tail = known ?? undefined
        }
        if (tail === undefined) return undefined
      } else {
        if (!visible && (yield* storage.entry(conversationId, at)) === undefined) {
          return yield* Effect.die(new Error(`Entry ${at} is not visible from conversation ${conversationId}`))
        }
        tail = at
      }
      return { head: yield* storage.findLatestHeadMarker(conversationId, tail), tail }
    }),
  )

function emptyView(): ContextView {
  return { head: undefined, entries: [], contributions: [], messages: [] }
}

/** The visible range of `bounds`: from the head marker's head, or transcript start, through the tail. */
function rangeQuery(bounds: ContextBounds): Omit<EntryQuery, "conversationId"> {
  const head = bounds.head
  return head === undefined ? { maxEntryId: bounds.tail } : { minEntryId: head.head, maxEntryId: bounds.tail }
}

/** Visible entries within `range`, oldest first, read page by page beside the line: none of them changes. */
const scanRange = (
  session: Session,
  conversationId: ConversationId,
  range: Omit<EntryQuery, "conversationId">,
): Effect.Effect<EntryRecord[], ReadFailure> =>
  Effect.gen(function* () {
    const entries: EntryRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = yield* session.readOffLine((storage) =>
        storage.scanEntries({ conversationId, ...range }, SCAN_PAGE_SIZE, cursor),
      )
      entries.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return entries.reverse()
  })

/** Entry `id` of `range`, by binary search over its ID order. */
function rangeEntry(range: ContextRange, id: EntryId): EntryRecord | undefined {
  const entries = range.entries
  let low = 0
  let high = entries.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const entry = entries[middle]!
    if (entry.id === id) return entry
    if (entry.id < id) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

/**
 * `range` with the entries one commit appended to its conversation, in ID order, without reading Storage: a
 * conversation's own new entries are its newest, and a new head marker's head never lies before the range's start. A
 * range that is not current stays as it is; `undefined` drops it.
 */
function advanceRange(range: ContextRange, appended: readonly EntryRecord[]): ContextRange | undefined {
  if (!range.current || appended.length === 0) return range
  const added = freezeJson([...appended].sort((a, b) => a.id - b.id))
  let head = range.bounds.head
  for (const entry of added) if (entry.head !== undefined) head = entry as typeof head
  const bounds = { head, tail: added.at(-1)!.id }
  if (head?.id === range.bounds.head?.id) return extendRange(range, bounds, added, true)
  const start = head!.head
  // Heads only move forward: compaction keeps a later entry, a reset starts at itself, an older head is stale.
  if (range.bounds.head !== undefined && start < range.bounds.head.head) return undefined
  return deriveRange(
    bounds,
    [...range.entries, ...added].filter((entry) => entry.id >= start),
    true,
  )
}

/**
 * Derives the range of `bounds` from its visible entries, oldest first. Per target the newest edit in the range wins;
 * context entries are the head marker followed by the range's non-head entries.
 */
function deriveRange(bounds: ContextBounds, entries: readonly EntryRecord[], current: boolean): ContextRange {
  const edits = new Map<EntryId, ContextEdit>()
  // Edits of every entry in the range count, older head markers included.
  for (const entry of entries) for (const edit of entry.edits ?? []) edits.set(edit.target, edit)
  const head = bounds.head
  const active = head === undefined ? entries : [head, ...entries.filter((entry) => entry.head === undefined)]
  const contributions = active.map((entry) => contribute(entry, edits.get(entry.id)))
  const { settled, open } = settle([], contributions.flat())
  const baseline = findBaseline(head, active)
  const messages = leadWithSystem([...settled, ...orderToolResults(open)], baseline)
  const view = { head, entries: active, contributions, messages }
  return { bounds, entries, view, edited: new Set(edits.keys()), settled, open, baseline, current }
}

/**
 * `previous` extended by the entries `added` after its tail under the same head marker: only their contributions and
 * the open messages are derived. An added edit can change an earlier entry, so it derives the whole range again.
 */
function extendRange(
  previous: ContextRange,
  bounds: ContextBounds,
  added: readonly EntryRecord[],
  current: boolean,
): ContextRange {
  const entries = [...previous.entries, ...added]
  if (added.some((entry) => entry.edits !== undefined || entry.head !== undefined || previous.edited.has(entry.id))) {
    return deriveRange(bounds, entries, current)
  }
  const contributions = added.map((entry) => contribute(entry, undefined))
  const { settled, open } = settle(previous.settled, [...previous.open, ...contributions.flat()])
  const baseline = previous.baseline !== undefined ? previous.baseline : findBaseline(bounds.head, added)
  const view = {
    head: bounds.head,
    entries: [...previous.view.entries, ...added],
    contributions: [...previous.view.contributions, ...contributions],
    messages: leadWithSystem([...settled, ...orderToolResults(open)], baseline),
  }
  return { bounds, entries, view, edited: previous.edited, settled, open, baseline, current }
}

/**
 * Moves the ordered messages before the last response of `open` to `settled`. `orderToolResults()` of a sequence equals
 * the concatenation over its parts when each later part starts with a response's first assistant message.
 */
function settle(
  settled: readonly Message[],
  open: readonly Message[],
): { readonly settled: readonly Message[]; readonly open: readonly Message[] } {
  const last = responseStart(
    open,
    open.findLastIndex((message) => message.role === "assistant"),
  )
  if (last <= 0) return { settled, open }
  return { settled: [...settled, ...orderToolResults(open.slice(0, last))], open: open.slice(last) }
}

/**
 * The index of the first assistant message of the response the assistant message at `index` belongs to. An agent that
 * runs its own loop, such as Claude Code, commits one response block by block: consecutive assistant messages with one
 * `responseId`, which tool results may separate, are one response.
 */
function responseStart(messages: readonly Message[], index: number): number {
  const message = messages[index]
  if (message?.role !== "assistant" || message.responseId === undefined) return index
  let start = index
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const candidate = messages[earlier]!
    if (candidate.role === "toolResult") continue
    if (candidate.role !== "assistant" || candidate.responseId !== message.responseId) break
    start = earlier
  }
  return start
}

/** Objects `freezeJson()` froze with everything in them; `Object.isFrozen()` holds for shallow freezes too. */
const deeplyFrozen = new WeakSet<object>()

/** Freezes a JSON value and everything in it: kept entries outlive the read that scanned them. */
function freezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || deeplyFrozen.has(value)) return value
  for (const child of Object.values(value)) freezeJson(child)
  Object.freeze(value)
  deeplyFrozen.add(value)
  return value
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
  if (edit?.action === "omit") return Object.freeze([])
  const contributed = edit?.action === "replace" ? (edit.messages as unknown as readonly Message[]) : messagesOf(entry)
  return Object.freeze(
    contributed.filter((message) => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason)),
  )
}

/**
 * Places each response's tool results directly after it, in call order. A response is one assistant message, or several
 * consecutive ones with one `responseId` (see `responseStart`), placed together. Results are taken from the messages
 * before the next response; a missing result is synthesized and unmatched results are dropped.
 */
export function orderToolResults(messages: readonly Message[]): Message[] {
  const ordered: Message[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === "toolResult") continue
    ordered.push(message)
    if (message.role !== "assistant") continue
    // The response's further messages: the same `responseId`, with only tool results between them.
    let end = index + 1
    const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall")
    for (let next = index + 1; message.responseId !== undefined && next < messages.length; next++) {
      const candidate = messages[next]!
      if (candidate.role === "toolResult") continue
      if (candidate.role !== "assistant" || candidate.responseId !== message.responseId) break
      ordered.push(candidate)
      calls.push(...candidate.content.filter((content): content is ToolCall => content.type === "toolCall"))
      end = next + 1
    }
    const results = new Map<string, number>()
    for (let next = index + 1; next < messages.length; next++) {
      const candidate = messages[next]!
      if (next >= end && candidate.role === "assistant") break
      if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) results.set(candidate.toolCallId, next)
    }
    for (const call of calls) {
      const resultIndex = results.get(call.id)
      ordered.push(resultIndex === undefined ? missingResult(call, message.timestamp) : messages[resultIndex]!)
    }
    // Go on after the response's last assistant message; its tool results were placed already.
    index = end - 1
  }
  return ordered
}

function missingResult(call: ToolCall, timestamp: number): ToolResultMessage {
  return freezeJson({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: MISSING_RESULT_TEXT }],
    isError: true,
    details: { reason: "missing_result" },
    timestamp,
  })
}
