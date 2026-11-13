// Tree status (`status/watch`): a tree is a conversation people started and the subagents under it. A
// conversation works while `pi.live` holds a run and waits while `sigma.approvals` holds a request without an answer;
// a tree waits when any of its conversations waits, works when any works, and is idle otherwise. The tracker follows
// every commit on the Session line from the documents the publication carries, so each status is the committed one at
// that commit's seq; what a client reads of it is completed off the line.
import { ApprovalsDoc, type Harness, LiveDoc } from "@sigma/harness"
import {
  type CommitPublication,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryRecord,
  readOnLine,
} from "@sigma/kernel"
import { FellBehind, RUN_END_KIND, type TreeItem, type TreeStatus } from "@sigma/protocol"
import { Cause, Effect, Queue, Stream } from "effect"
import { endedAt, wireId } from "./conversations.ts"

type Status = TreeStatus["status"]

/** A tree's change as the line sees it; `end` is its root's run_end. */
type Raw = { readonly root: ConversationId; readonly seq: number; readonly status: Status; readonly end?: EntryRecord }

type Watcher = (raw: Raw) => boolean

const SCAN_PAGE = 256

const worst = (counts: { working: number; waiting: number } | undefined): Status =>
  counts === undefined ? "idle" : counts.waiting > 0 ? "waiting" : counts.working > 0 ? "working" : "idle"

const asking = (value: unknown) =>
  Object.values((value as { requests?: Record<string, { answer?: unknown }> } | undefined)?.requests ?? {}).some(
    (request) => request.answer === undefined,
  )

const running = (value: unknown) => (value as { run?: unknown } | undefined)?.run !== undefined

export interface TreeStatuses {
  /** Every tree that is not idle, then each change to a tree's status or its root's run ending. */
  readonly watch: (limit: number) => Stream.Stream<TreeItem, FellBehind>
}

/** Starts following tree status on `harness`'s Session line; it ends with the Session. */
export const followTreeStatus = (harness: Harness): Effect.Effect<TreeStatuses> =>
  Effect.gen(function* () {
    const roots = new Map<ConversationId, ConversationId>()
    /** Per conversation whether it works and waits, and per tree how many of its conversations do. */
    const states = new Map<ConversationId, { working: boolean; waiting: boolean }>()
    const counts = new Map<ConversationId, { working: number; waiting: number }>()
    /** What a watcher last heard of each tree that is not idle, with the seq it changed at. */
    const reported = new Map<ConversationId, { status: Status; seq: number }>()
    const watchers = new Set<Watcher>()
    let seq = 0

    const learn = (record: ConversationRecord) => {
      if (roots.has(record.id)) return
      const owner = record.owner?.conversationId
      roots.set(record.id, owner === undefined ? record.id : (roots.get(owner) ?? owner))
    }

    const set = (id: ConversationId, change: { working?: boolean; waiting?: boolean }) => {
      const root = roots.get(id) ?? id
      const before = states.get(id) ?? { working: false, waiting: false }
      const after = { ...before, ...change }
      states.set(id, after)
      const tree = counts.get(root) ?? { working: 0, waiting: 0 }
      tree.working += Number(after.working) - Number(before.working)
      tree.waiting += Number(after.waiting) - Number(before.waiting)
      if (tree.working === 0 && tree.waiting === 0) counts.delete(root)
      else counts.set(root, tree)
      return root
    }

    const advance = (publication: CommitPublication) => {
      seq = publication.seq
      for (const change of publication.changes) if (change.type === "conversation") learn(change.value)
      const touched = new Set<ConversationId>()
      const ends = new Map<ConversationId, EntryRecord>()
      for (const change of publication.changes) {
        if (change.type === "document" && change.conversationId !== undefined && change.record.key === undefined) {
          // A retired document holds nothing.
          const value = change.kind === "change" ? change.value : undefined
          if (change.record.kind === LiveDoc.definition.kind)
            touched.add(set(change.conversationId, { working: running(value) }))
          else if (change.record.kind === ApprovalsDoc.definition.kind)
            touched.add(set(change.conversationId, { waiting: asking(value) }))
        } else if (change.type === "entry" && change.value.kind === RUN_END_KIND) {
          const id = change.value.conversationId
          if ((roots.get(id) ?? id) === id) ends.set(id, change.value)
        }
      }
      for (const root of new Set([...touched, ...ends.keys()])) {
        const status = worst(counts.get(root))
        const end = ends.get(root)
        if (end === undefined && status === (reported.get(root)?.status ?? "idle")) continue
        if (status === "idle") reported.delete(root)
        else reported.set(root, { status, seq })
        const raw: Raw = end === undefined ? { root, seq, status } : { root, seq, status, end }
        for (const watcher of [...watchers]) if (!watcher(raw)) watchers.delete(watcher)
      }
    }

    // Read the committed state and attach in one step on the line, so no commit falls between them.
    yield* Effect.orDie(
      readOnLine(harness.session, (reads) =>
        Effect.gen(function* () {
          let cursor: Cursor | undefined
          do {
            const page = yield* reads.storage.scanConversations({}, SCAN_PAGE, cursor)
            for (const record of page.items) learn(record)
            cursor = page.next
          } while (cursor !== undefined)
          for (const id of roots.keys()) {
            const live = yield* reads.document(LiveDoc, id)
            const approvals = yield* reads.document(ApprovalsDoc, id)
            if (running(live?.value) || asking(approvals?.value))
              set(id, { working: running(live?.value), waiting: asking(approvals?.value) })
          }
          for (const [root, tree] of counts) reported.set(root, { status: worst(tree), seq: 0 })
          harness.session.observeCommits({ advance, end: () => {} })
        }),
      ),
    )

    const toItem = (raw: Raw): Effect.Effect<TreeStatus> =>
      Effect.gen(function* () {
        const conversation = yield* wireId(harness, raw.root)
        if (raw.end === undefined) return { _tag: "tree", conversation, seq: raw.seq, status: raw.status }
        const ended = yield* endedAt(harness, raw.root, raw.end)
        return { _tag: "tree", conversation, seq: raw.seq, status: raw.status, ended }
      })

    return {
      watch: (limit) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.bounded<Raw, FellBehind | Cause.Done>(limit)
            // Taken and attached in one synchronous step, between two commits.
            const busy = [...reported].map(([root, { status, seq: at }]) => ({ root, status, seq: at }))
            const at = seq
            const watcher: Watcher = (raw) => {
              if (Queue.offerUnsafe(queue, raw)) return true
              Effect.runSync(Queue.clear(queue))
              Queue.failCauseUnsafe(queue, Cause.fail(new FellBehind({ limit })))
              return false
            }
            watchers.add(watcher)
            yield* Effect.addFinalizer(() => Effect.sync(() => watchers.delete(watcher)))
            const trees = yield* Effect.forEach(busy, toItem)
            const first: TreeItem = { _tag: "trees", seq: at, trees }
            return Stream.concat(Stream.make(first), Stream.mapEffect(Stream.fromQueue(queue), toItem))
          }),
        ),
    }
  })
