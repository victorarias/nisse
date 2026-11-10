// The task graph view (spec 9.4): every live task of the Session as one value, for UIs and debugging. One mount, built
// on the Session line by its first observer and dropped with its last, advanced from each stored commit at its
// publication. `blocked` is derived at read time from the committed records and the registry (D16), and derived again
// on the line when the registry changes or a migration fails.
import { applyImmutable, type Op } from "@nisse/delta"
import {
  type BlockedReason,
  type BlockedSubject,
  blockedSubject,
  type CommitPublication,
  type ConversationId,
  type Cursor,
  type DocumentObservation,
  type DocumentObserver,
  type JoinPolicy,
  type JsonValue,
  type Page,
  type ReadError,
  type ReadFailure,
  readOnLine,
  type Session,
  type StorageReads,
  type TaskId,
  type TaskOutcome,
  type TaskRecord,
  type TaskScheduler,
} from "@nisse/kernel"
import { Effect } from "effect"
import { advanceFollower, closedError, closeEnd, endFollower, type Follower, guarded } from "./followers.ts"

/** A live task's durable status without its checkpoint and outcome payloads. */
export type TaskGraphState =
  | { readonly status: "pending" | "running"; readonly phase: string }
  | { readonly status: "waiting"; readonly phase: string; readonly on: readonly TaskId[]; readonly policy: JoinPolicy }
  /** Asleep until the Harness clock reaches `until`. */
  | { readonly status: "sleeping"; readonly phase: string; readonly until: number }
  /** Outcome held until its ordinary owned work drains. */
  | { readonly status: "completing"; readonly outcome: TaskOutcome<JsonValue>["status"] }

export type TaskGraphNode = {
  readonly id: TaskId
  readonly kind: string
  readonly conversationId: ConversationId
  /** Owner task; absent for a conversation-owned task. */
  readonly owner?: TaskId
  readonly background: boolean
  readonly abortRequested: boolean
  readonly state: TaskGraphState
  /** Why it cannot run here, when it cannot. Follows registry changes. */
  readonly blocked?: BlockedReason
  /** Conversations this task owns, in ID order. */
  readonly conversations: readonly ConversationId[]
}

/** Every live task of the Session. */
export type TaskGraph = {
  /** Every live task, keyed by its decimal ID. */
  readonly tasks: Readonly<Record<string, TaskGraphNode>>
}

type Mount = {
  value: TaskGraph
  readonly observers: Set<Follower<TaskGraph>>
  /** What the blocked reason reads of each live task, so it can be derived again without the payloads. */
  readonly subjects: Map<string, BlockedSubject>
}

const LIVE_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const
const SCAN_PAGE_SIZE = 256

/** The Harness's task graph mount. */
export class TaskGraphView {
  readonly #session: Session
  readonly #scheduler: TaskScheduler
  #mount: Mount | undefined
  #closed = false

  constructor(session: Session, scheduler: TaskScheduler) {
    this.#session = session
    this.#scheduler = scheduler
    session.observeCommits({
      advance: (publication) => {
        if (this.#mount !== undefined) advance(this.#mount, publication, (subject) => scheduler.blockedReason(subject))
      },
      end: () => {},
    })
    scheduler.subscribeBlocked(() => this.#refreshBlocked())
    session.subscribeClose(() => {
      this.#closed = true
      const end = closeEnd(session)
      for (const follower of [...(this.#mount?.observers ?? [])]) endFollower(follower, end)
      this.#mount = undefined
    })
  }

  /**
   * Attaches `observer` to the graph, atomically on the Session line: it starts from the returned value and sees every
   * later change. Its `advance` runs on the line, so it must only capture.
   */
  observe(observer: DocumentObserver<TaskGraph>): Effect.Effect<DocumentObservation<TaskGraph>, ReadFailure> {
    return readOnLine(
      this.#session,
      ({ storage }) =>
        Effect.gen({ self: this }, function* () {
          const mount = this.#mount ?? (yield* this.#build(storage))
          if (this.#closed) return yield* Effect.fail(closedError(this.#session))
          const follower: Follower<TaskGraph> = guarded(observer, () => {
            mount.observers.delete(follower)
            if (mount.observers.size === 0 && this.#mount === mount) this.#mount = undefined
          })
          this.#mount = mount
          mount.observers.add(follower)
          return { value: mount.value, detach: follower.detach }
        }),
      (attached) => attached.detach(),
    )
  }

  /** On the line: derives every node's blocked reason again and publishes the ones that changed. */
  #refreshBlocked(): void {
    if (this.#mount === undefined || this.#closed) return
    Effect.runFork(
      Effect.ignore(
        readOnLine(this.#session, () =>
          Effect.sync(() => {
            const mount = this.#mount
            if (mount === undefined) return
            const ops: Op[] = []
            for (const [key, subject] of mount.subjects) {
              const blocked = this.#scheduler.blockedReason(subject)
              if (blocked === mount.value.tasks[key]?.blocked) continue
              ops.push(
                blocked === undefined ? ["d", ["tasks", key, "blocked"]] : ["s", ["tasks", key, "blocked"], blocked],
              )
            }
            publish(mount, ops)
          }),
        ),
      ),
    )
  }

  /** Reads the graph on the line: the live tasks and the conversations each owns. */
  #build(storage: StorageReads): Effect.Effect<Mount, ReadError> {
    return Effect.gen({ self: this }, function* () {
      const records: TaskRecord[] = []
      for (const status of LIVE_STATUSES) {
        records.push(...(yield* scanAll((cursor) => storage.scanTasks({ status }, SCAN_PAGE_SIZE, cursor))))
      }
      records.sort((a, b) => a.id - b.id)
      const tasks: Record<string, TaskGraphNode> = {}
      const subjects = new Map<string, BlockedSubject>()
      for (const record of records) {
        const owned = yield* scanAll((cursor) =>
          storage.scanConversations({ ownerTaskId: record.id }, SCAN_PAGE_SIZE, cursor),
        )
        const conversations = owned.map((conversation) => conversation.id).sort((a, b) => a - b)
        const subject = blockedSubject(record)
        tasks[String(record.id)] = nodeOf(record, conversations, this.#scheduler.blockedReason(subject))
        subjects.set(String(record.id), subject)
      }
      return { value: { tasks }, observers: new Set<Follower<TaskGraph>>(), subjects }
    })
  }
}

/** Derives the mount's operations from one publication and hands the revision to every observer. */
function advance(
  mount: Mount,
  publication: CommitPublication,
  blocked: (subject: BlockedSubject) => BlockedReason | undefined,
): void {
  const ops: Op[] = []
  // Nodes this publication set or deleted, over the mount's value.
  const changed = new Map<string, TaskGraphNode | undefined>()
  const node = (key: string): TaskGraphNode | undefined =>
    changed.has(key) ? changed.get(key) : mount.value.tasks[key]
  for (const change of publication.changes) {
    if (change.type !== "task") continue
    const record = change.value
    const key = String(record.id)
    const previous = node(key)
    if (record.state.status === "terminal") {
      mount.subjects.delete(key)
      if (previous === undefined) continue
      ops.push(["d", ["tasks", key]])
      changed.set(key, undefined)
      continue
    }
    const subject = blockedSubject(record)
    mount.subjects.set(key, subject)
    const next = nodeOf(record, previous?.conversations ?? [], blocked(subject))
    if (previous !== undefined && JSON.stringify(next) === JSON.stringify(previous)) continue
    ops.push(["s", ["tasks", key], next as unknown as JsonValue])
    changed.set(key, next)
  }
  // After the tasks, so a conversation created with its owner task in one commit finds the owner's node. Change order
  // within a publication is unspecified, so each owner's list is sorted again.
  const created = new Map<string, ConversationId[]>()
  for (const change of publication.changes) {
    if (change.type !== "conversation" || change.value.owner === undefined) continue
    const key = String(change.value.owner.taskId)
    if (node(key) !== undefined) created.set(key, [...(created.get(key) ?? []), change.value.id])
  }
  for (const [key, ids] of created) {
    const conversations = [...node(key)!.conversations, ...ids].sort((a, b) => a - b)
    ops.push(["s", ["tasks", key, "conversations"], conversations])
  }
  publish(mount, ops)
}

/** Applies `ops` to the mount and hands the revision to every observer. */
function publish(mount: Mount, ops: Op[]): void {
  if (ops.length === 0) return
  mount.value = applyImmutable(mount.value, ops)
  const change = { value: mount.value, ops, retired: false }
  for (const follower of [...mount.observers]) advanceFollower(follower, change)
}

function nodeOf(
  record: TaskRecord,
  conversations: readonly ConversationId[],
  blocked: BlockedReason | undefined,
): TaskGraphNode {
  return {
    id: record.id,
    kind: record.kind,
    conversationId: record.conversationId,
    ...(record.owner === undefined ? {} : { owner: record.owner }),
    background: record.background,
    abortRequested: record.abortRequested,
    state: stateOf(record),
    conversations,
    ...(blocked === undefined ? {} : { blocked }),
  }
}

function stateOf(record: TaskRecord): TaskGraphState {
  const state = record.state
  switch (state.status) {
    case "pending":
    case "running":
      return { status: state.status, phase: phaseOf(state.checkpoint) }
    case "waiting":
      return { status: "waiting", phase: phaseOf(state.checkpoint), on: [...state.on], policy: state.policy }
    case "sleeping":
      return { status: "sleeping", phase: phaseOf(state.checkpoint), until: state.until }
    // Terminal records never reach here: they leave the graph.
    case "completing":
    case "terminal":
      return { status: "completing", outcome: state.outcome.status }
  }
}

const phaseOf = (checkpoint: unknown): string => (checkpoint as { readonly phase: string }).phase

const scanAll = <T>(page: (cursor: Cursor | undefined) => Effect.Effect<Page<T>, ReadError>) =>
  Effect.gen(function* () {
    const items: T[] = []
    let cursor: Cursor | undefined
    do {
      const next = yield* page(cursor)
      items.push(...next.items)
      cursor = next.next
    } while (cursor !== undefined)
    return items
  })
