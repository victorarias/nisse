// The conversation view and a client's transcript through the harness's public API over real SQLite storage. The
// upstream suite runs the same code through the conformance adapter; this covers a client reconnecting across a restart.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, type Scope } from "effect"
import { type EntryRecord, openSqliteStorage } from "@nisse/kernel"
import { fromProviders } from "@nisse/models"
import {
  type Conversation,
  ConversationTranscript,
  type ConversationWindow,
  createRegistry,
  type Harness,
  openHarness,
  type TranscriptView,
} from "../src/index.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const databasePath = (): string => {
  const home = mkdtempSync(join(tmpdir(), "nisse-view-"))
  homes.push(home)
  return join(home, "kernel.sqlite")
}

const registry = createRegistry()

/** A Harness over the database at `path`, closed with the scope: one server's lifetime. */
const open = (path: string): Effect.Effect<Harness, unknown, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(openSqliteStorage(path), (storage) => openHarness(storage, { registry, models: fromProviders([]) })),
    (harness) => Effect.ignore(harness.close),
  )

const notes = (conversation: Conversation, count: number): Effect.Effect<void, unknown> =>
  conversation.commit((tx) =>
    Effect.forEach(Array.from({ length: count }), () => tx.appendEntry(conversation.id, { kind: "note" }), {
      discard: true,
    }),
  )

/** Connects a client: one watch's first value merged into its transcript, then the watch ends with its scope. */
const connect = (
  conversation: Conversation,
  transcript: ConversationTranscript<unknown>,
  window?: ConversationWindow,
) => Effect.scoped(Effect.map(conversation.watch(window), (watch) => transcript.merge(watch.value)))

const ids = (view: TranscriptView): (string | number)[] =>
  view.items.map((item) => (item.kind === "entry" ? item.entry.id : item.kind === "gap" ? "gap" : "earlier"))

const entryIds = (entries: readonly EntryRecord[]): (string | number)[] => entries.map((entry) => entry.id)

describe("conversation view", () => {
  test("view-resume, view-gap, view-fill-gap: a client reconnecting from its position gets what it missed, or a gap it fills", async () => {
    const path = databasePath()
    const window = { min: 3, max: 6 }
    // The client keeps its transcript across reconnects; its loader reads through the server it is connected to.
    let connected!: Conversation
    const transcript = new ConversationTranscript((query, limit) => connected.entries(query, limit))
    let allIds: (string | number)[] = []

    // First connection: the client holds the whole short transcript.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* open(path)
          const root = yield* harness.root()
          connected = root
          yield* notes(root, 3)
          const first = yield* connect(root, transcript, window)
          expect(ids(first)).toEqual(entryIds((yield* root.entries({}, 100)).items).reverse())
        }),
      ),
    )

    // The server restarts while two entries are committed: resuming from the client's position returns just those.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* open(path)
          const root = yield* harness.root()
          connected = root
          yield* notes(root, 2)
          const resumed = yield* Effect.scoped(
            Effect.map(root.watch({ ...transcript.resume, ...window }), (w) => w.value),
          )
          expect(resumed.entries).toHaveLength(2)
          const view = transcript.merge(resumed)
          const committed = entryIds((yield* root.entries({ order: "ascending" }, 100)).items)
          expect(ids(view)).toEqual(committed)
        }),
      ),
    )

    // Another restart while more than the window holds is committed: the client gets the newest and a gap it fills.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* open(path)
          const root = yield* harness.root()
          connected = root
          yield* notes(root, 10)
          let view = yield* connect(root, transcript, { ...transcript.resume, ...window })
          expect(view.items.filter((item) => item.kind === "gap")).toHaveLength(1)
          expect(view.items.filter((item) => item.kind === "entry")).toHaveLength(5 + window.min)
          for (let gap = view.items.find((item) => item.kind === "gap"); gap?.kind === "gap"; ) {
            view = yield* transcript.fillGap(gap)
            gap = view.items.find((item) => item.kind === "gap")
          }
          allIds = entryIds((yield* root.entries({ order: "ascending" }, 100)).items)
          expect(ids(view)).toEqual(allIds)
        }),
      ),
    )
    expect(allIds).toHaveLength(15)
  })
})
