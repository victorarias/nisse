// The harness through its public API over real SQLite storage: conversations, their agents, the registry and tasks.
// The upstream suite runs the same package through the conformance adapter; these cover what it leaves out.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Option, Queue, Scope, Stream, Tracer } from "effect"
import {
  type ConversationId,
  defineDoc,
  defineTask,
  type EntryRecord,
  openSqliteStorage,
  type Task,
  type TaskId,
  TracePropagation,
} from "@nisse/kernel"
import { fromProviders } from "@nisse/models"
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@nisse/models/faux"
import {
  AgentDoc,
  type Conversation,
  type ConversationInit,
  createRegistry,
  defineExtension,
  defineTool,
  LiveDoc,
  type Harness,
  type HarnessOptions,
  openHarness,
  ProviderDoc,
  type Registry,
  section,
  TaskServices,
  type ToolRegistration,
} from "../src/index.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const databasePath = (): string => {
  const home = mkdtempSync(join(tmpdir(), "nisse-harness-"))
  homes.push(home)
  return join(home, "kernel.sqlite")
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> => Effect.runPromise(Effect.scoped(effect))

/** A Harness over the database at `path`, closed with the scope. */
const open = (
  path: string,
  registry: Registry,
  options: Omit<HarnessOptions, "registry" | "models"> = {},
): Effect.Effect<Harness, unknown, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(openSqliteStorage(path), (storage) =>
      openHarness(storage, { registry, models: fromProviders([]), ...options }),
    ),
    (harness) => Effect.ignore(harness.close),
  )

const tool = (name: string, fields: Partial<ToolRegistration> = {}): ToolRegistration =>
  defineTool({
    name,
    description: `The ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: () => Effect.succeed(name),
    ...fields,
  })

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 })

const note = (conversation: Conversation, text: string): Effect.Effect<EntryRecord, unknown> =>
  conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "message", model: [user(text)] }))

/** The text of each user message in a conversation's context. */
const contextTexts = (conversation: Conversation, at?: EntryRecord) =>
  Effect.map(conversation.context(at === undefined ? {} : { at: at.id }), (view) =>
    view.messages.map((message) => (message.role === "user" ? message.content : message.role)),
  )

/** A task that completes when it runs; the tests that use it only need it to exist. */
const Plain = defineTask<{ readonly name: string }, { readonly phase: "hold" }, null, TaskServices>({
  name: "test.plain",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: (_task, runtime) =>
      runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "completed", result: null } })),
  },
  abort: (_task, runtime) =>
    runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "aborted" } })),
})

describe("conversation agents", () => {
  test("agent-model, agent-thinking, agent-instructions, agent-cwd, agent-tools-filter, agent-resolved: configure changes what the agent resolves to, and null gives the field back to the host", async () => {
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: "files",
        tools: [tool("read"), tool("write")],
        sections: [section("rules", () => Effect.succeed("Keep files small."))],
      }),
    )
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), registry)
        const root = yield* harness.root()
        yield* root.configure({
          model: { provider: "openai", modelId: "gpt-5" },
          thinkingLevel: "high",
          instructions: "Answer briefly.",
          cwd: "/work",
          tools: [{ name: "read" }],
        })
        const agent = yield* root.agent
        expect(agent.model).toEqual({ provider: "openai", modelId: "gpt-5" })
        expect(agent.thinkingLevel).toBe("high")
        expect(agent.cwd).toBe("/work")
        expect(agent.instructions).toBe("Answer briefly.")
        expect(agent.extensions.map((extension) => extension.name)).toEqual(["files"])
        expect(agent.tools.map((tool) => tool.name)).toEqual(["read"])
        expect(agent.callable.map((tool) => tool.name)).toEqual(["read"])
        expect(agent.sections.map((section) => section.key)).toEqual(["rules", "instructions"])

        yield* root.configure({ model: null, thinkingLevel: null, instructions: null, cwd: null, tools: null })
        const reset = yield* root.agent
        expect(reset.model).toBeUndefined()
        expect(reset.thinkingLevel).toBe("off")
        expect(reset.cwd).toBeUndefined()
        expect(reset.tools.map((tool) => tool.name)).toEqual(["read", "write"])
        expect(reset.sections.map((section) => section.key)).toEqual(["rules"])
      }),
    )
  })

  test("agent-inherit: a conversation a task creates starts with a copy of its owner's agent, and a fork with the agent as of its entry", async () => {
    const registry = createRegistry()
    registry.install(defineExtension({ name: "tasks", tasks: [Plain] }))
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), registry)
        const root = yield* harness.root()
        yield* root.configure({ instructions: "parent brief", cwd: "/repo" })
        const taskId = yield* root.commit((tx) =>
          tx.createTask(Plain, { name: "owner" }, { ownership: { kind: "conversation" } }),
        )
        const child = yield* harness.createConversation({ ownership: { kind: "task", taskId } })
        // A copy, not a reference: the parent's later change stays its own.
        yield* root.configure({ instructions: "changed later" })
        expect(yield* harness.session.snapshot(AgentDoc, child.id)).toEqual({
          instructions: "parent brief",
          cwd: "/repo",
        })

        const entry = yield* note(root, "first")
        yield* root.configure({ instructions: "after the entry" })
        const fork = yield* root.fork(entry.id, { ownership: { kind: "ownerless" } })
        expect((yield* fork.agent).instructions).toBe("changed later")
        expect((yield* root.agent).instructions).toBe("after the entry")
      }),
    )
  })

  test("agent-visible: a document watch sees each agent change, and a read as of an earlier entry sees the agent then", async () => {
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), createRegistry())
        const root = yield* harness.root()
        yield* root.configure({ instructions: "one" })
        const entry = yield* note(root, "between")
        const watch = (yield* harness.session.watchDoc(AgentDoc, root.id))!
        expect(watch.value).toEqual({ instructions: "one" })
        const seen = yield* Queue.unbounded<unknown>()
        yield* Effect.forkScoped(Stream.runForEach(watch.changes, (change) => Queue.offer(seen, change.value)))
        yield* root.configure({ instructions: "two" })
        expect(yield* Queue.take(seen)).toEqual({ instructions: "two" })
        expect(yield* harness.session.snapshotAsOf(AgentDoc, root.id, entry.id)).toEqual({ instructions: "one" })
      }),
    )
  })

  test("settings-default-extensions: the host's default selection applies to a conversation without its own, which can edit it", async () => {
    const registry = createRegistry()
    registry.install(defineExtension({ name: "a", tools: [tool("from-a")] }))
    registry.install(defineExtension({ name: "b", tools: [tool("from-b")] }))
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), registry, { settings: { extensions: [{ name: "b" }] } })
        const root = yield* harness.root()
        expect((yield* root.agent).extensions.map((extension) => extension.name)).toEqual(["b"])
        yield* root.configure({ extensions: { add: [{ name: "a" }] } })
        expect((yield* root.agent).extensions.map((extension) => extension.name)).toEqual(["b", "a"])
      }),
    )
  })
})

describe("conversations", () => {
  test("fork-provider-identity: the root and each of its forks have their own provider session id", async () => {
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), createRegistry())
        const root = yield* harness.root()
        const entry = yield* note(root, "first")
        const fork = yield* root.fork(entry.id, { ownership: { kind: "ownerless" } })
        const again = yield* root.fork(entry.id, { ownership: { kind: "ownerless" } })
        const ids = [root, fork, again].map((conversation) => harness.session.snapshot(ProviderDoc, conversation.id))
        const sessionIds = (yield* Effect.all(ids)).map((state) => state?.sessionId)
        for (const id of sessionIds) expect(id).toBeString()
        expect(new Set(sessionIds).size).toBe(3)
      }),
    )
  })

  test("conversation-list, conversation-reopen: conversations are found again after a restart, with their agent and history", async () => {
    const path = databasePath()
    const created = await run(
      Effect.gen(function* () {
        const harness = yield* open(path, createRegistry())
        const root = yield* harness.root()
        yield* root.configure({ instructions: "kept" })
        yield* note(root, "hello")
        const other = yield* harness.createConversation({ ownership: { kind: "ownerless" } })
        yield* note(other, "elsewhere")
        return { root: root.id, other: other.id }
      }),
    )
    await run(
      Effect.gen(function* () {
        const harness = yield* open(path, createRegistry())
        const listed = yield* harness.session.read((storage) => storage.scanConversations({}, 10, undefined))
        expect(listed.items.map((record) => record.id)).toEqual([created.root, created.other])
        const root = (yield* harness.conversation(created.root))!
        expect((yield* harness.root()).id).toBe(created.root)
        expect((yield* root.agent).instructions).toBe("kept")
        expect(yield* contextTexts(root)).toEqual(["hello"])
        expect(yield* contextTexts((yield* harness.conversation(created.other))!)).toEqual(["elsewhere"])
        expect(yield* harness.conversation(999 as ConversationId)).toBeUndefined()
      }),
    )
  })

  test("reset-context, reset-handoff, fork-at-entry: a fork that resets starts a new context with its handoff, and the original and the fork's earlier entries keep theirs", async () => {
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), createRegistry())
        const root = yield* harness.root()
        yield* note(root, "u1")
        const second = yield* note(root, "u2")
        yield* note(root, "u3")
        // Rule 3: the fork sees the parent's entries through `at` and its own after them.
        const fork = yield* root.fork(second.id, { ownership: { kind: "ownerless" } })
        const before = yield* note(fork, "f1")
        expect(yield* contextTexts(fork)).toEqual(["u1", "u2", "f1"])
        // Rules 1, 2 and 5: the reset is the head; the context is the reset followed by what comes after it.
        yield* fork.reset("Summary so far")
        expect(yield* contextTexts(fork)).toEqual(["Summary so far"])
        yield* note(fork, "f2")
        expect(yield* contextTexts(fork)).toEqual(["Summary so far", "f2"])
        const view = yield* fork.context()
        expect(view.head?.kind).toBe("pi.reset")
        expect(view.entries[0]).toEqual(view.head!)
        // History is kept: the context cut off before the reset is the one the fork had, and the parent is untouched.
        expect(yield* contextTexts(fork, before)).toEqual(["u1", "u2", "f1"])
        expect(yield* contextTexts(root)).toEqual(["u1", "u2", "u3"])
        // u1 and u2 through the fork point, then f1, the reset carrying its handoff, and f2.
        const history = yield* fork.entries({}, 10)
        expect(history.items.length).toBe(5)
        // A reset without a handoff leaves an empty context.
        yield* root.reset()
        expect(yield* contextTexts(root)).toEqual([])
        expect(yield* contextTexts(fork)).toEqual(["Summary so far", "f2"])
      }),
    )
  })
})

describe("registry", () => {
  test("registry-install-conflict: an extension whose task name another extension has is refused, and nothing is published", async () => {
    const registry = createRegistry()
    registry.install(defineExtension({ name: "first", tasks: [Plain] }))
    let published = 0
    registry.subscribe(() => published++)
    const before = registry.snapshot()
    expect(() => registry.install(defineExtension({ name: "second", tasks: [Plain] }))).toThrow(
      "Task test.plain of extension second is already installed",
    )
    expect(published).toBe(0)
    expect(registry.snapshot()).toBe(before)
    expect(registry.snapshot().extension("second")).toBeUndefined()
  })

  test("extension-tool-metadata: a tool's declared facts reach the registry and decide who may call it", async () => {
    const registry = createRegistry()
    const internal = tool("internal", { callers: ["tools"], replay: "safe", executionMode: "sequential" })
    const later = tool("later", { deferred: true })
    registry.install(defineExtension({ name: "kit", tools: [tool("plain"), internal, later] }))
    const listed = registry
      .snapshot()
      .tools()
      .map(({ extension, tool }) => [extension.name, tool.name, tool.replay, tool.callers])
    expect(listed).toEqual([
      ["kit", "plain", undefined, undefined],
      ["kit", "internal", "safe", ["tools"]],
      ["kit", "later", undefined, undefined],
    ])
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), registry)
        const agent = yield* (yield* harness.root()).agent
        expect(agent.tools.map((tool) => tool.name)).toEqual(["plain"])
        expect(agent.deferred.map((tool) => tool.name)).toEqual(["later"])
        expect(agent.callable.map((tool) => tool.name)).toEqual(["plain", "internal", "later"])
        expect(agent.callable[1]).toBe(internal)
      }),
    )
  })

  test("extension-stored-by-name: a selection names extensions, so it outlives an uninstall and a restart and binds to what is installed later", async () => {
    const path = databasePath()
    const registry = createRegistry()
    registry.install(defineExtension({ name: "search", tools: [tool("find")] }))
    registry.install(defineExtension({ name: "other" }))
    const id = await run(
      Effect.gen(function* () {
        const harness = yield* open(path, registry)
        const root = yield* harness.root()
        yield* root.configure({ extensions: [{ name: "search" }] })
        registry.uninstall({ name: "search" })
        // Absent code stops applying, and nothing is rewritten.
        expect((yield* root.agent).extensions).toEqual([])
        expect(yield* harness.session.snapshot(AgentDoc, root.id)).toEqual({ extensions: ["search"] })
        return root.id
      }),
    )
    const later = createRegistry()
    await run(
      Effect.gen(function* () {
        const harness = yield* open(path, later)
        const root = (yield* harness.conversation(id))!
        expect((yield* root.agent).tools).toEqual([])
        later.install(defineExtension({ name: "search", tools: [tool("find")] }))
        expect((yield* root.agent).tools.map((tool) => tool.name)).toEqual(["find"])
      }),
    )
  })

  test("extension-state: an extension's own document survives a restart, and a fork reads it as of its entry", async () => {
    const Notes = defineDoc<{ lines: string[] }>({
      kind: "test.notes",
      version: 1,
      scope: "conversation",
      history: "rewindable",
      fork: "asOf",
      initial: () => ({ lines: [] }),
      checkpointWhen: () => false,
    })
    const path = databasePath()
    const write = (conversation: Conversation, line: string) =>
      conversation.commit((tx) =>
        Effect.gen(function* () {
          ;(yield* tx.doc(Notes, conversation.id)).lines.push(line)
          return yield* tx.appendEntry(conversation.id, { kind: "note", data: { line } })
        }),
      )
    const ids = await run(
      Effect.gen(function* () {
        const harness = yield* open(path, createRegistry())
        const root = yield* harness.root()
        const first = yield* write(root, "first")
        yield* write(root, "second")
        return { root: root.id, first: first.id }
      }),
    )
    await run(
      Effect.gen(function* () {
        const harness = yield* open(path, createRegistry())
        const root = (yield* harness.conversation(ids.root))!
        expect(yield* harness.session.snapshot(Notes, root.id)).toEqual({ lines: ["first", "second"] })
        const fork = yield* root.fork(ids.first, { ownership: { kind: "ownerless" } })
        expect(yield* harness.session.snapshot(Notes, fork.id)).toEqual({ lines: ["first"] })
      }),
    )
  })

  test("extension-reload: reloading an extension mid-run leaves running work on the old code and starts new work on the new", async () => {
    const started = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    type Result = { readonly code: string; readonly tools: readonly string[] }
    const version = (code: string, wait: boolean) =>
      defineTask<null, { readonly phase: "run" }, Result, TaskServices>({
        name: "test.work",
        version: 1,
        initial: () => ({ phase: "run" }),
        phases: {
          run: (_task, runtime) =>
            Effect.gen(function* () {
              if (wait) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(gate)
              }
              // Resolved after the reload: the agent of the phase's snapshot, as the code is.
              const agent = yield* (yield* TaskServices).agent
              const result = { code, tools: agent.tools.map((tool) => tool.name) }
              yield* runtime.commit(() =>
                Effect.succeed({ status: "terminal" as const, outcome: { status: "completed" as const, result } }),
              )
            }),
        },
        abort: () => Effect.void,
      })
    const registry = createRegistry()
    registry.install(defineExtension({ name: "work", tasks: [version("old", true)], tools: [tool("old-tool")] }))
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), registry)
        const root = yield* harness.root()
        const create = root.commit((tx) =>
          tx.createTask(version("any", false), null, { ownership: { kind: "conversation" } }),
        ) as Effect.Effect<TaskId<Result>, unknown>
        yield* harness.resume
        const running = yield* create
        yield* Deferred.await(started)

        registry.install(defineExtension({ name: "work", tasks: [version("new", false)], tools: [tool("new-tool")] }))
        const fresh = yield* create
        const newer = yield* harness.waitForTask(fresh)
        expect(newer.state.outcome).toEqual({ status: "completed", result: { code: "new", tools: ["new-tool"] } })

        yield* Deferred.succeed(gate, undefined)
        const older = yield* harness.waitForTask(running)
        expect(older.state.outcome).toEqual({ status: "completed", result: { code: "old", tools: ["old-tool"] } })
      }),
    )
  })
})

describe("submissions", () => {
  test("session-init: the host's init seeds the root once, in the commit that creates it, and never again after a restart", async () => {
    const Seeded = defineDoc<{ runs: number }>({
      kind: "test.seeded",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ runs: 0 }),
      checkpointWhen: () => true,
    })
    const path = databasePath()
    let inits = 0
    const init: ConversationInit = (tx, id) =>
      Effect.map(tx.doc(Seeded, id), (seeded) => {
        inits++
        seeded.runs++
      })
    for (let open_ = 0; open_ < 2; open_++) {
      await run(
        Effect.gen(function* () {
          const harness = yield* open(path, createRegistry())
          const root = yield* harness.root({ agent: { instructions: "seeded" }, init })
          expect(yield* harness.session.snapshot(Seeded, root.id)).toEqual({ runs: 1 })
          expect((yield* root.agent).instructions).toBe("seeded")
        }),
      )
    }
    expect(inits).toBe(1)
  })

  test("submission-dedupe: a submission retried with its request ID after a restart lands once", async () => {
    const path = databasePath()
    const draft = { requestId: "send-1", type: "write", entry: { kind: "message", model: [user("once")] } } as const
    const first = await run(
      Effect.gen(function* () {
        const harness = yield* open(path, createRegistry())
        const root = yield* harness.root()
        const submission = yield* root.submit(draft)
        yield* submission.wait
        return { root: root.id, submission: submission.id }
      }),
    )
    await run(
      Effect.gen(function* () {
        const harness = yield* open(path, createRegistry())
        const root = (yield* harness.conversation(first.root))!
        const retried = yield* root.submit(draft)
        expect(retried.id).toBe(first.submission)
        expect((yield* retried.wait).status).toBe("done")
        const stored = yield* harness.session.read((storage) =>
          storage.scanSubmissions({ conversationId: first.root }, 10, undefined),
        )
        expect(stored.items.map((record) => record.id)).toEqual([first.submission])
        expect(yield* contextTexts(root)).toEqual(["once"])
      }),
    )
  })
})

describe("runs", () => {
  test("run-retry-live, run-failed-attempt: Stop during a retry backoff ends the run as aborted without waiting it out", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" })])
    await run(
      Effect.gen(function* () {
        const storage = yield* openSqliteStorage(databasePath())
        const harness = yield* Effect.acquireRelease(
          openHarness(storage, {
            registry: createRegistry(),
            models: fromProviders([faux.provider]),
            // The longest backoff, a minute (maxAgentDelayMs): Stop ends it long before.
            settings: { retry: { baseDelayMs: 3_600_000 } },
          }),
          (opened) => Effect.ignore(opened.close),
        )
        const root = yield* harness.root({ agent: { model: { provider: "faux", modelId: "faux-1" } } })
        const watch = (yield* harness.session.watchDoc(LiveDoc, root.id))!
        const submission = yield* root.submit({ type: "input", content: "hi" })
        const retrying = yield* Stream.runHead(
          Stream.filter(watch.changes, (change) => change.value.generation?.retry !== undefined),
        )
        const retry = Option.getOrThrow(retrying).value.generation!.retry
        expect(retry?.error).toBe("503 Service Unavailable")
        expect(retry!.at).toBeGreaterThan(Date.now())
        const failed = yield* harness.session.read((reads) =>
          reads.scanEntries({ conversationId: root.id }, 10, undefined),
        )
        expect(
          failed.items.map((entry) => [
            entry.kind,
            (entry.model?.[0] as { stopReason?: string } | undefined)?.stopReason,
          ]),
        ).toContainEqual(["pi.assistant", "error"])

        yield* root.abort()
        expect(yield* submission.wait).toMatchObject({ status: "unanswered", reason: "aborted" })
        expect(yield* harness.session.snapshot(LiveDoc, root.id)).toMatchObject({ runFailure: { reason: "aborted" } })
        expect((yield* harness.session.snapshot(LiveDoc, root.id))?.generation).toBeUndefined()
      }),
    )
  })
})

describe("tasks", () => {
  test("doc-watch: a document watch a task keeps past its handler ends with the invocation", async () => {
    const handed = Deferred.makeUnsafe<Stream.Stream<unknown, unknown>>()
    const watcher = defineTask<null, { readonly phase: "run" }, null, TaskServices>({
      name: "test.watcher",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: (task, runtime) =>
          Effect.gen(function* () {
            // A scope the handler never closes: only the invocation's end stops the watch.
            const scope = yield* Scope.make()
            const watch = yield* Scope.provide(scope)((yield* TaskServices).watchDoc(AgentDoc, task.conversationId))
            yield* Deferred.succeed(handed, watch!.changes)
            yield* runtime.commit(() =>
              Effect.succeed({ status: "terminal" as const, outcome: { status: "completed" as const, result: null } }),
            )
          }),
      },
      abort: () => Effect.void,
    })
    const registry = createRegistry()
    registry.install(defineExtension({ name: "watching", tasks: [watcher] }))
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), registry)
        const root = yield* harness.root()
        yield* harness.resume
        const id = yield* root.commit((tx) => tx.createTask(watcher, null, { ownership: { kind: "conversation" } }))
        yield* harness.waitForTask(id)
        // The changes end, rather than following the document for as long as the Harness runs.
        yield* Stream.runDrain(yield* Deferred.await(handed))
      }),
    )
  })

  test("task-memory-bounded: long chains of ended tasks leave the scheduler and the document cache as they were", async () => {
    // Each link creates the next, which it owns, then ends; it holds `completing` until the chain below it ends, and
    // then the chain finalizes from the bottom up.
    type LinkState = { readonly phase: "run" }
    const Link: Task<{ readonly left: number }, LinkState, null, TaskServices> = defineTask({
      name: "test.link",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: (task, runtime) =>
          Effect.andThen(
            runtime.commit((tx) =>
              Effect.gen(function* () {
                if (task.input.left > 0) {
                  const options = { ownership: { kind: "task" as const, taskId: task.id } }
                  yield* tx.createTask(Link, { left: task.input.left - 1 }, options)
                }
                return undefined
              }),
            ),
            runtime.commit(() =>
              Effect.succeed({ status: "terminal" as const, outcome: { status: "completed" as const, result: null } }),
            ),
          ),
      },
      abort: () => Effect.void,
    })
    const registry = createRegistry()
    registry.install(defineExtension({ name: "chains", tasks: [Link] }))
    await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), registry)
        const root = yield* harness.root()
        yield* harness.resume
        const chain = Effect.gen(function* () {
          const top = yield* root.commit((tx) =>
            tx.createTask(Link, { left: 200 }, { ownership: { kind: "conversation" } }),
          )
          expect((yield* harness.waitForTask(top)).state.outcome.status).toBe("completed")
          yield* harness.waitForIdle
          return { scheduler: harness.indexSizes, documents: harness.session.documentCacheSizes }
        })
        const first = yield* chain
        expect(first.scheduler).toEqual({ live: 0, below: 0, conversations: 0, waiters: 0 })
        for (let round = 0; round < 3; round++) expect(yield* chain).toEqual(first)
        expect((yield* harness.inspect).tasks).toEqual([])
      }),
    )
  })
})

/** A tracer whose spans named `name` are broken by `broken`; every other span records as Effect's own do. */
const breakingTracer = (name: string, broken: (span: Tracer.NativeSpan) => void): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      if (options.name === name) broken(span)
      return span
    },
  })

/**
 * One input answered under `tracer` and `propagation`, by a faux model that calls a tool first: how its submission
 * settled, and what the Harness reported.
 */
const answerUnder = async (tracer: Tracer.Tracer, propagation?: TracePropagation) => {
  const reports: unknown[] = []
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("answer"),
  ])
  const registry = createRegistry()
  registry.install(defineExtension({ name: "echo", tools: [tool("echo")] }))
  const settled = await run(
    Effect.gen(function* () {
      const storage = yield* openSqliteStorage(databasePath())
      const harness = yield* Effect.acquireRelease(
        openHarness(storage, {
          registry,
          models: fromProviders([faux.provider]),
          onReport: (report) => reports.push(report),
        }),
        (opened) => Effect.ignore(opened.close),
      )
      const root = yield* harness.root({ agent: { model: { provider: "faux", modelId: "faux-1" } } })
      const submission = yield* root.submit({ type: "input", content: "hi" })
      return yield* submission.wait
    }).pipe(Effect.withTracer(tracer), Effect.provideService(TracePropagation, propagation)),
  )
  return { settled, reports }
}

describe("telemetry", () => {
  test("telemetry-spans: a tracer that cannot open phase spans is reported, and the run still answers", async () => {
    const tracer = Tracer.make({
      span(options) {
        if (options.name === "pi.durable.phase") throw new Error("tracer broke")
        return new Tracer.NativeSpan(options)
      },
    })
    const { settled, reports } = await answerUnder(tracer)
    expect(settled.status).toBe("done")
    expect(reports.length).toBeGreaterThan(0)
    expect(reports).toMatchObject(reports.map(() => ({ kind: "host_error", callback: "telemetry" })))
  })

  const broke = () => {
    throw new Error("telemetry broke")
  }
  const carriers = new WeakMap<object, Record<string, string>>()
  const working: TracePropagation = {
    inject: (span) => carriers.get(span) ?? (carriers.set(span, { span: span.spanId }), carriers.get(span)),
    extract: (carrier) => Tracer.externalSpan({ spanId: carrier.span!, traceId: carrier.span! }),
  }
  test.each([
    [
      "the tool call's names on its phase span",
      breakingTracer("pi.durable.phase", (span) => {
        const attribute = span.attribute.bind(span)
        span.attribute = (key, value) => (key.startsWith("tool.") ? broke() : attribute(key, value))
      }),
      working,
    ],
    [
      "opening a submit span",
      Tracer.make({
        span: (options) => (options.name === "pi.durable.submit" ? broke() : new Tracer.NativeSpan(options)),
      }),
      working,
    ],
    [
      "injecting a carrier",
      Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
      { ...working, inject: broke },
    ],
    [
      "extracting a carrier",
      Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
      { ...working, extract: broke },
    ],
  ] as const)(
    "telemetry-spans: telemetry that throws on %s is reported, and the run still answers",
    async (_, tracer, propagation) => {
      const { settled, reports } = await answerUnder(tracer, propagation)
      expect(settled.status).toBe("done")
      expect(reports.length).toBeGreaterThan(0)
      expect(reports).toMatchObject(reports.map(() => ({ kind: "host_error", callback: "telemetry" })))
    },
  )

  test("telemetry-spans: a tracer that throws on a model request's span leaves the run's answer", async () => {
    const tracer = breakingTracer("pi.ai.request", (span) => {
      span.end = () => {
        throw new Error("tracer broke")
      }
    })
    const { settled } = await answerUnder(tracer)
    expect(settled.status).toBe("done")
  })

  test("telemetry-spans: a tracer that throws on a submit span is reported, and the stored submission still reaches its caller", async () => {
    const reports: unknown[] = []
    const tracer = breakingTracer("pi.durable.submit", (span) => {
      span.end = () => {
        throw new Error("tracer broke")
      }
    })
    const status = await run(
      Effect.gen(function* () {
        const harness = yield* open(databasePath(), createRegistry(), { onReport: (report) => reports.push(report) })
        const root = yield* harness.root()
        const submission = yield* root.submit({ type: "write", entry: { kind: "app.note" } })
        return (yield* submission.status).status
      }).pipe(Effect.withTracer(tracer)),
    )
    expect(status).toBe("done")
    expect(reports).toMatchObject([{ kind: "host_error", callback: "telemetry" }])
  })
})
