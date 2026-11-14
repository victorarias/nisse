// The conversation view (spec 9.3): one mount per conversation, a window over its transcript and its built-in
// documents, built on the Session line by its first observer and dropped with its last. Each mount advances from the
// Session's commits at their publication and hands every observer the next revision of its own window.
import { applyImmutable, type NonEmptyPath, type Op, type Path } from "@sigma/delta"
import {
  type AnyDocToken,
  type CommitPublication,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type DocumentId,
  type DocumentObservation,
  type DocumentObserver,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type JsonObject,
  type JsonValue,
  type LineReads,
  type ReadError,
  type ReadFailure,
  readOnLine,
  type Session,
  type StorageReads,
} from "@sigma/kernel"
import { Effect } from "effect"
import { AgentDoc } from "./agent.ts"
import { ApprovalsDoc } from "./approvals.ts"
import { ProviderDoc } from "./documents.ts"
import { advanceFollower, closedError, closeEnd, endFollower, type Follower, guarded } from "./followers.ts"
import { InboxDoc } from "./inbox.ts"
import { LiveDoc } from "./live.ts"
import { UsageDoc } from "./usage.ts"

/** Structural view of one conversation: a window over its transcript and its built-in documents. */
export type ConversationView = {
  readonly conversation: ConversationRecord
  /**
   * A window over the transcript, its fork-aware history (`Conversation.entries()`), in entry ID order. Head markers
   * such as compaction summaries sit where they were written.
   */
  readonly entries: readonly EntryRecord[]
  /** ID of the entry just before the window; absent when the window starts the transcript. */
  readonly before?: EntryId
  /**
   * `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider`, `pi.usage`, `sigma.approvals` and the host's `viewDocs`, keyed by
   * kind; absent documents are absent.
   */
  readonly docs: Readonly<Record<string, JsonObject>>
}

/**
 * Which entries a view's window holds: the newest `min`, then appends, and past `max` its oldest leave in one splice
 * down to `min`. With `from`, the first value starts at `from` when at most `max` entries are at or after it.
 */
export type ConversationWindow = {
  /** Where the first value's window starts, inclusive, such as `ConversationTranscript.resume`. */
  readonly from?: EntryId
  /** Default 50; an integer, at least 1. */
  readonly min?: number
  /** Default `2 * min`; an integer, at least `min`. */
  readonly max?: number
}

const DEFAULT_WINDOW_MIN = 50
const SCAN_PAGE_SIZE = 256

const MOUNTED: readonly AnyDocToken[] = [AgentDoc, LiveDoc, InboxDoc, ProviderDoc, UsageDoc, ApprovalsDoc]

/** One observer of a mount and its window: the bounds and the revision it was last given. */
type Windowed = {
  readonly min: number
  readonly max: number
  value: ConversationView
  readonly follower: Follower<ConversationView>
}

/** One conversation's mount: its documents, shared by every observer, and the observers, each with its own window. */
type Mount = {
  readonly conversation: ConversationRecord
  docs: Readonly<Record<string, JsonObject>>
  /** Mounted incarnation and definition version per kind; another incarnation or version is set whole. */
  readonly incarnations: Map<string, { readonly id: DocumentId; readonly version: number }>
  readonly observers: Set<Windowed>
}

type WindowBounds = { readonly from: EntryId | undefined; readonly min: number; readonly max: number }

/** The view mounts of a Harness: at most one per conversation. */
export class ConversationViews {
  readonly #session: Session
  readonly #mounted: readonly AnyDocToken[]
  readonly #kinds: ReadonlySet<string>
  readonly #mounts = new Map<ConversationId, Mount>()
  #closed = false

  /** `docs`: the host's conversation documents the view carries beside the built-in ones. */
  constructor(session: Session, docs: readonly AnyDocToken[] = []) {
    this.#session = session
    this.#mounted = [...MOUNTED, ...docs]
    this.#kinds = new Set(this.#mounted.map((token) => token.definition.kind))
    session.observeCommits({
      advance: (publication) => {
        for (const [id, mount] of this.#mounts) advance(id, mount, publication, this.#kinds)
      },
      end: () => {},
    })
    session.subscribeClose(() => {
      this.#closed = true
      const end = closeEnd(session)
      for (const mount of this.#mounts.values())
        for (const windowed of [...mount.observers]) endFollower(windowed.follower, end)
      this.#mounts.clear()
    })
  }

  /**
   * Attaches `observer` to the view of `id`, atomically on the Session line: it starts from the returned value and sees
   * every later publication. Its `advance` runs on the line, so it must only capture.
   */
  observe(
    id: ConversationId,
    observer: DocumentObserver<ConversationView>,
    window?: ConversationWindow,
  ): Effect.Effect<DocumentObservation<ConversationView>, ReadFailure> {
    return Effect.suspend(() => {
      const bounds = resolveWindow(window)
      return readOnLine(
        this.#session,
        (reads) => this.#attach(reads, id, bounds, observer),
        (attached) => attached.detach(),
      )
    })
  }

  #attach(
    reads: LineReads,
    id: ConversationId,
    bounds: WindowBounds,
    observer: DocumentObserver<ConversationView>,
  ): Effect.Effect<DocumentObservation<ConversationView>, ReadFailure> {
    return Effect.gen({ self: this }, function* () {
      const mount = this.#mounts.get(id) ?? (yield* build(reads, id, this.#mounted))
      const { entries, before } = yield* loadWindow(reads.storage, id, bounds)
      // The close may begin while the mount hydrates; register nothing then.
      if (this.#closed) return yield* Effect.fail(closedError(this.#session))
      const value = view(mount.conversation, entries, before, mount.docs)
      const windowed: Windowed = {
        min: bounds.min,
        max: bounds.max,
        value,
        follower: guarded(observer, () => {
          mount.observers.delete(windowed)
          if (mount.observers.size === 0 && this.#mounts.get(id) === mount) this.#mounts.delete(id)
        }),
      }
      this.#mounts.set(id, mount)
      mount.observers.add(windowed)
      return { value, detach: windowed.follower.detach }
    })
  }
}

/** `window` with its defaults; bounds that are not integers, or `max` below `min`, are a `RangeError`. */
function resolveWindow(window: ConversationWindow | undefined): WindowBounds {
  const min = window?.min ?? DEFAULT_WINDOW_MIN
  if (!Number.isSafeInteger(min) || min < 1) throw new RangeError(`Window min must be an integer >= 1, got ${min}`)
  const max = window?.max ?? 2 * min
  if (!Number.isSafeInteger(max) || max < min) {
    throw new RangeError(`Window max must be an integer >= min (${min}), got ${max}`)
  }
  const from = window?.from
  if (from !== undefined && !Number.isSafeInteger(from)) {
    throw new RangeError(`Window from must be an entry ID, got ${from}`)
  }
  return { from, min, max }
}

/** Hydrates a mount on the line: the conversation and its built-in documents. */
function build(reads: LineReads, id: ConversationId, mounted: readonly AnyDocToken[]): Effect.Effect<Mount, ReadError> {
  return Effect.gen(function* () {
    const conversation = yield* reads.storage.conversation(id)
    if (conversation === undefined) return yield* Effect.die(new Error(`Conversation ${id} does not exist`))
    const docs: Record<string, JsonObject> = {}
    const incarnations = new Map<string, { id: DocumentId; version: number }>()
    for (const token of mounted) {
      const loaded = yield* (
        reads.document as (token: AnyDocToken, id: ConversationId) => ReturnType<LineReads["document"]>
      )(token, id)
      if (loaded === undefined) continue
      docs[token.definition.kind] = loaded.value as JsonObject
      incarnations.set(token.definition.kind, { id: loaded.record.id, version: loaded.version })
    }
    return { conversation, docs, incarnations, observers: new Set<Windowed>() }
  })
}

/** A view revision; `before` is a key only when set. */
function view(
  conversation: ConversationRecord,
  entries: readonly EntryRecord[],
  before: EntryId | undefined,
  docs: Readonly<Record<string, JsonObject>>,
): ConversationView {
  return before === undefined ? { conversation, entries, docs } : { conversation, entries, before, docs }
}

/**
 * A new observer's window, read on the line with bounded scans: the entries from `from` when at most `max` are at or
 * after it, otherwise the newest `min`, and the entry before them.
 */
function loadWindow(
  storage: StorageReads,
  conversationId: ConversationId,
  bounds: WindowBounds,
): Effect.Effect<{ readonly entries: readonly EntryRecord[]; readonly before: EntryId | undefined }, ReadError> {
  return Effect.gen(function* () {
    const { from, min, max } = bounds
    if (from !== undefined) {
      const since = yield* scanUpTo(storage, { conversationId, minEntryId: from, order: "ascending" }, max + 1)
      if (since.length <= max) {
        const query = { conversationId, maxEntryId: (from - 1) as EntryId }
        const previous = (yield* storage.scanEntries(query, 1, undefined)).items[0]
        return { entries: since, before: previous?.id }
      }
    }
    const newest = yield* scanUpTo(storage, { conversationId }, min + 1)
    const before = newest.length > min ? newest.pop()!.id : undefined
    return { entries: newest.reverse(), before }
  })
}

/** Up to `limit` entries of `query`, following cursors past short pages. */
function scanUpTo(storage: StorageReads, query: EntryQuery, limit: number): Effect.Effect<EntryRecord[], ReadError> {
  return Effect.gen(function* () {
    const entries: EntryRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = yield* storage.scanEntries(query, Math.min(SCAN_PAGE_SIZE, limit - entries.length), cursor)
      entries.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined && entries.length < limit)
    return entries
  })
}

/**
 * Derives the mount's operations from one publication and hands each observer the next revision of its window. The
 * documents are applied once and shared; each window takes the appended entries and, past its `max`, drops its oldest
 * down to its `min` in one splice.
 */
function advance(id: ConversationId, mount: Mount, publication: CommitPublication, kinds: ReadonlySet<string>): void {
  const docOps: Op[] = []
  const appended: EntryRecord[] = []
  for (const change of publication.changes) {
    if (change.type === "entry") {
      if (change.value.conversationId === id) appended.push(change.value)
      continue
    }
    if (change.type !== "document" || change.conversationId !== id) continue
    const kind = change.record.kind
    if (!kinds.has(kind) || change.record.key !== undefined) continue
    const path: NonEmptyPath = ["docs", kind]
    const mounted = mount.incarnations.get(kind)
    if (change.kind === "retire") {
      if (mounted?.id !== change.record.id) continue
      mount.incarnations.delete(kind)
      docOps.push(["d", path])
    } else if (mounted?.id === change.record.id && mounted.version === change.version) {
      for (const op of change.ops) docOps.push(prefixed(op, path))
    } else {
      mount.incarnations.set(kind, { id: change.record.id, version: change.version })
      docOps.push(["s", path, change.value as JsonValue])
    }
  }
  if (docOps.length === 0 && appended.length === 0) return
  // A publication's change order is unspecified; the window holds entries in ID order.
  appended.sort((a, b) => a.id - b.id)
  if (docOps.length > 0) mount.docs = applyImmutable({ docs: mount.docs }, docOps).docs
  const inserted = appended as unknown as JsonValue[]
  for (const windowed of [...mount.observers]) {
    let entries = windowed.value.entries
    let before = windowed.value.before
    let ops: Op[] = docOps
    if (appended.length > 0) {
      ops = [...docOps, ["p", ["entries"], entries.length, 0, inserted]]
      entries = entries.concat(appended)
      if (entries.length > windowed.max) {
        const drop = entries.length - windowed.min
        before = entries[drop - 1]!.id
        entries = entries.slice(drop)
        ops.push(["p", ["entries"], 0, drop, []], ["s", ["before"], before])
      }
    }
    windowed.value = view(mount.conversation, entries, before, mount.docs)
    advanceFollower(windowed.follower, { value: windowed.value, ops, retired: false })
  }
}

/** `op` moved under `prefix`; a root replacement becomes a set of the prefix. */
function prefixed(op: Op, prefix: NonEmptyPath): Op {
  const at = (path: Path): NonEmptyPath => [...prefix, ...path] as unknown as NonEmptyPath
  switch (op[0]) {
    case "r":
      return ["s", prefix, op[1]]
    case "p":
      return ["p", at(op[1]), op[2], op[3], op[4]]
    case "m":
      return ["m", at(op[1]), op[2]]
    case "s":
      return ["s", at(op[1]), op[2]]
    case "d":
      return ["d", at(op[1])]
    case "a":
      return ["a", at(op[1]), op[2]]
    case "t":
      return ["t", at(op[1]), op[2]]
  }
}
