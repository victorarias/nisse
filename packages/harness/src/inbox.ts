// `pi.inbox` and input boundaries (spec 6): the queue of a conversation's submissions waiting for a boundary, and the
// placement of what a boundary selects. From pi-durable's `src/harness/inbox.ts` at 7d073328e (MIT, see LICENSE).
import type { Draft } from "@sigma/delta"
import { copyJson } from "@sigma/delta/json"
import {
  type ConversationId,
  defineDoc,
  type DocError,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type JsonObject,
  type ReadError,
  type StorageError,
  type SubmissionId,
  type Tx,
} from "@sigma/kernel"
import type { JsonRepresentation } from "@sigma/models"
import { Effect } from "effect"
import { stored, UserEntry } from "./entries.ts"
import type { Stored } from "./live.ts"
import type { InputEntry, QueueMode, Settings, UserInput } from "./types.ts"

/** A queued submission: user input for a run, with the entry it is placed as when not `pi.user`, or an entry write. */
export type InboxItem =
  | {
      id: SubmissionId
      mode: "steer" | "followUp"
      content: Stored<JsonRepresentation<UserInput>>
      entry?: Stored<InputEntry>
    }
  /** `entry` is an `EntryDraft`, stored as plain JSON. */
  | { id: SubmissionId; mode: "write"; entry: JsonObject }

/** Built-in queue of one conversation's submissions waiting for a boundary, in ID order. */
export type InboxState = { items: InboxItem[] }

export const InboxDoc = defineDoc<InboxState>({
  kind: "pi.inbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: (value) => value.items.length === 0,
})

/** The settings a boundary reads, on the Session line. */
export type QueueModes = Pick<Settings, "steeringMode" | "followUpMode">

/** What a boundary reads before the commit's first table write, and the newest head it has seen so far. */
export type Boundary = {
  readonly conversationId: ConversationId
  readonly inbox: Draft<InboxState>
  readonly steeringMode: QueueMode
  readonly followUpMode: QueueMode
  /** Start of the active range, the newest head marker's `head`; advanced by heads written in this commit. */
  head: EntryId | undefined
}

/**
 * Selected user items, in ID order, the first entry the boundary placed (a run it starts begins there,
 * `LiveRun.first`), and whether a `head: "self"` write (a reset) was placed.
 */
export type BoundaryResult = {
  readonly users: SubmissionId[]
  readonly first: EntryId | undefined
  readonly reset: boolean
}

/** Reads what a boundary needs; table reads precede the commit's first table write, so call it first. */
export const prepareBoundary = (
  tx: Tx,
  conversationId: ConversationId,
  modes: QueueModes,
): Effect.Effect<Boundary, ReadError | DocError> =>
  Effect.gen(function* () {
    const head = (yield* tx.latestHeadMarker(conversationId))?.head
    const inbox = yield* tx.doc(InboxDoc, conversationId)
    return { conversationId, inbox, steeringMode: modes.steeringMode, followUpMode: modes.followUpMode, head }
  })

/**
 * Places the queued items a boundary selects (spec 6): every write, the first or all steers, and at `final` the first
 * or all follow-ups. A selected reset turns a `postTools` boundary into `final`. Writes are placed first and user
 * items after them, each in ID order, so user items queued before a reset run in the new context. A write whose head
 * targets an entry before the active range, including a range started earlier in this commit, is stale. Selected and
 * stale items are removed positionally.
 */
export const applyBoundary = (
  tx: Tx,
  boundary: Boundary,
  at: "postTools" | "final",
  now: number,
): Effect.Effect<BoundaryResult, StorageError> =>
  Effect.gen(function* () {
    const { conversationId, inbox } = boundary
    const items = inbox.items
    const reset = hasQueuedReset(items as InboxItem[])
    const final = at === "final" || reset
    const pick = (mode: "steer" | "followUp", queueMode: QueueMode): number[] => {
      const indexes = items.flatMap((item, index) => (item.mode === mode ? [index] : []))
      return queueMode === "all" ? indexes : indexes.slice(0, 1)
    }
    const writes = items.flatMap((item, index) => (item.mode === "write" ? [index] : []))
    const users = [...pick("steer", boundary.steeringMode), ...(final ? pick("followUp", boundary.followUpMode) : [])]
    users.sort((a, b) => a - b)

    // `appendEntry()` copies the drafts' values; the items are removed only afterwards.
    let first: EntryId | undefined
    for (const index of writes) {
      const item = items[index] as Extract<InboxItem, { mode: "write" }>
      const draft = item.entry as unknown as EntryDraft
      if (isStale(boundary, draft)) {
        yield* tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" })
        continue
      }
      const entry = yield* tx.appendEntry(conversationId, draft)
      if (draft.head !== undefined) boundary.head = draft.head === "self" ? entry.id : draft.head
      yield* tx.placeSubmission(item.id, entry.id)
      first ??= entry.id
    }
    const placed: SubmissionId[] = []
    for (const index of users) {
      const item = items[index] as Extract<InboxItem, { mode: "steer" | "followUp" }>
      const entry = yield* appendInput(
        tx,
        conversationId,
        item.content as UserInput,
        item.entry as InputEntry | undefined,
        now,
      )
      yield* tx.placeSubmission(item.id, entry.id)
      placed.push(item.id)
      first ??= entry.id
    }
    const removed = [...writes, ...users].sort((a, b) => b - a)
    for (const index of removed) items.splice(index, 1)
    return { users: placed, first, reset }
  })

/** Appends the entry an input is placed as: `entry`'s kind and data, or `pi.user`, with the user message of `content`. */
export const appendInput = (
  tx: Tx,
  conversationId: ConversationId,
  content: UserInput,
  entry: InputEntry | undefined,
  now: number,
): Effect.Effect<EntryRecord, StorageError> => {
  const message = { role: "user", content, timestamp: now } as const
  if (entry === undefined) return tx.appendEntry(UserEntry, conversationId, { model: [stored(message)] })
  return tx.appendEntry(conversationId, { ...pickInputEntry(entry), model: [stored(message)] })
}

/** The kind and data of an input's entry as strict JSON, without other fields an untyped caller might pass. */
export function pickInputEntry({ kind, data }: InputEntry): Stored<InputEntry> {
  const picked = data === undefined ? { kind } : { kind, data }
  return copyJson(picked, { omitUndefinedProperties: true }) as Stored<InputEntry>
}

/**
 * Whether a write is display-only: it has no `model`, `head` or `edits` (present counts, even if empty), so it changes
 * nothing the model sees and needs no boundary.
 */
export function isDisplayOnly(entry: EntryDraft): boolean {
  return entry.model === undefined && entry.head === undefined && entry.edits === undefined
}

/** Whether a reset (`head: "self"` write) is queued; entries appended before it leave the active range when it lands. */
export function hasQueuedReset(items: readonly InboxItem[]): boolean {
  return items.some((item) => item.mode === "write" && item.entry.head === "self")
}

/** Whether a head write targets an entry before the active range, so placing it would bring back cut history. */
export function isStale(boundary: Boundary, entry: EntryDraft): boolean {
  return typeof entry.head === "number" && boundary.head !== undefined && entry.head < boundary.head
}

/** A queued input as it is withdrawn, handed to the host's `inputWithdrawn` in the commit that withdraws it. */
export type WithdrawnInput = {
  readonly conversationId: ConversationId
  /** The entry it would have been placed as, when not `pi.user`. */
  readonly entry: Stored<InputEntry> | undefined
}

/**
 * Runs in the commit that withdraws a queued input, after it is settled, so what it writes is stored with the
 * withdrawal. The commit has written already, so it reads no table. A failure fails that commit.
 */
export type InputWithdrawnHook = (tx: Tx, input: WithdrawnInput) => Effect.Effect<void, StorageError>

/** Settles a queued item `unanswered` with `reason`, removes it from `items`, and hands an input to `withdrawn`. */
const withdraw = (
  tx: Tx,
  conversationId: ConversationId,
  items: InboxItem[],
  index: number,
  reason: string,
  withdrawn: InputWithdrawnHook | undefined,
): Effect.Effect<void, StorageError> =>
  Effect.gen(function* () {
    const item = items[index]!
    yield* tx.settleSubmission(item.id, { status: "unanswered", reason })
    items.splice(index, 1)
    if (item.mode === "write" || withdrawn === undefined) return
    yield* withdrawn(tx, { conversationId, entry: item.entry })
  })

/** Withdraws queued submission `id`: it settles `unanswered` with `aborted` and leaves the inbox. */
export const withdrawQueued = (
  tx: Tx,
  conversationId: ConversationId,
  id: SubmissionId,
  withdrawn: InputWithdrawnHook | undefined,
): Effect.Effect<void, DocError | StorageError> =>
  Effect.gen(function* () {
    const items = (yield* tx.doc(InboxDoc, conversationId)).items as InboxItem[]
    const index = items.findIndex((item) => item.id === id)
    if (index >= 0) yield* withdraw(tx, conversationId, items, index, "aborted", withdrawn)
  })

/**
 * Withdraws every queued input of a conversation, as `Conversation.abort()` and abort cascades do: each settles
 * `unanswered` with `reason` and leaves the inbox; queued writes stay for later placement.
 */
export const withdrawQueuedInputs = (
  tx: Tx,
  conversationId: ConversationId,
  reason: string,
  withdrawn: InputWithdrawnHook | undefined,
): Effect.Effect<void, DocError | StorageError> =>
  Effect.gen(function* () {
    const items = (yield* tx.doc(InboxDoc, conversationId)).items as InboxItem[]
    // In queue order; a withdrawn item leaves `items`, so the next one takes its index.
    for (let index = 0; index < items.length; ) {
      if (items[index]!.mode === "write") index++
      else yield* withdraw(tx, conversationId, items, index, reason, withdrawn)
    }
  })
