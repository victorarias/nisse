// claude.run through the harness's own seams: a Harness over real SQLite whose registry holds extensions written as a
// host installs them, with Claude Code played by sigma's fake `claude` replaying a recorded process per spawn. These
// cover what the wire cannot reach yet: extension tools and hooks, and forks.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Scope } from "effect"
import { type EntryRecord, openSqliteStorage } from "@sigma/kernel"
import { fromProviders } from "@sigma/models"
import {
  AssistantEntry,
  approveAutomatically,
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  type Harness,
  hook,
  openHarness,
  ResetEntry,
  ToolTask,
  UsageDoc,
  UserEntry,
} from "@sigma/harness"
import { type ClaudeProcessesOptions, claudeRunTasks, makeClaudeProcesses } from "../src/index.ts"

const FIXTURES = join(import.meta.dir, "../../../fixtures/claude")
const FAKE = join(import.meta.dir, "../../sigma/test/support/fake-claude")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake Claude Code playing the fixtures' processes one per spawn, in order, and what it logged. */
const fake = (...fixtures: [string, ...string[]]) => {
  const dir = mkdtempSync("/tmp/sigma-claude-")
  dirs.push(dir)
  const played = join(dir, "fixture.ndjson")
  writeFileSync(played, fixtures.map((fixture) => readFileSync(join(FIXTURES, `${fixture}.ndjson`), "utf8")).join("\n"))
  return {
    dir,
    settings: {
      executable: FAKE,
      env: { FAKE_CLAUDE_FIXTURE: played, FAKE_CLAUDE_DIR: dir },
    },
    log: (): Array<any> =>
      readFileSync(join(dir, "log.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  }
}

type Fake = ReturnType<typeof fake>

const spawns = (claude: Fake) =>
  claude
    .log()
    .filter((entry) => entry.argv && entry.probe === undefined)
    .map((entry) => entry.argv as string[])

const hookAnswers = (claude: Fake) =>
  claude
    .log()
    .filter((entry) => entry.answered === "hook_callback")
    .map((entry) => entry.received.response.response.hookSpecificOutput)
    .filter((output) => output !== undefined)

/** A Harness running Claude conversations on `claude`, with `extensions` installed, closed with the scope. */
const open = (
  claude: Fake,
  extensions: ReadonlyArray<Parameters<ReturnType<typeof createRegistry>["install"]>[0]>,
  reports: Array<unknown> = [],
  processes: ClaudeProcessesOptions = {},
) =>
  Effect.gen(function* () {
    // The fake writes the conversation's directory into its recorded paths as given; on macOS /tmp is /private/tmp.
    const dir = realpathSync(mkdtempSync("/tmp/sigma-harness-"))
    dirs.push(dir)
    const registry = createRegistry()
    const tasks = claudeRunTasks({
      settings: (provider) => (provider === "claude" ? claude.settings : undefined),
      processes: yield* makeClaudeProcesses(processes),
    })
    registry.install(defineExtension({ name: "claude", tasks: [tasks.run, tasks.subagent] }))
    for (const extension of extensions) registry.install(extension)
    const harness = yield* Effect.acquireRelease(
      Effect.flatMap(openSqliteStorage(join(dir, "kernel.sqlite")), (storage) =>
        openHarness(storage, {
          registry,
          models: fromProviders([]),
          runTasks: tasks.runTasks,
          onReport: (report) => reports.push(report),
        }),
      ),
      (harness) => Effect.ignore(harness.close),
    )
    return { harness, cwd: dir }
  })

/** A Claude conversation whose calls run without asking: the fake answers whatever it is told. */
const start = (harness: Harness, cwd: string) =>
  harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { model: { provider: "claude", modelId: "" }, cwd },
    init: (tx, created) => approveAutomatically(tx, created),
  })

const ask = (conversation: Conversation, text: string) =>
  Effect.andThen(conversation.submit({ type: "input", content: text }), conversation.waitForIdle)

const entries = (conversation: Conversation) =>
  Effect.map(conversation.entries({ order: "ascending" }, 1000), (page) => page.items)

const said = (all: ReadonlyArray<EntryRecord>) =>
  all.flatMap((entry) =>
    (entry.model ?? []).flatMap((message: any) => {
      if (message.role === "toolResult")
        return [
          `result ${message.toolName}: ${message.content.map((part: any) => part.text).join("")}${message.isError ? " (error)" : ""}`,
        ]
      if (message.role === "assistant")
        return message.content.map((part: any) =>
          part.type === "toolCall" ? `call ${part.name} ${JSON.stringify(part.arguments)}` : `assistant: ${part.text}`,
        )
      return [`user: ${typeof message.content === "string" ? message.content : ""}`]
    }),
  )

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

/** Refuses `touch`, rewrites `echo original`, and reads one line of every file. */
const guard = defineExtension({
  name: "guard",
  hooks: [
    hook(ToolTask, {
      beforeTool: (call: { arguments: Record<string, unknown> }) =>
        Effect.sync(() => {
          const input = call.arguments as { command?: string; file_path?: string }
          if (input.command?.startsWith("touch")) return { block: "no touching" }
          if (input.command === "echo original") return { arguments: { ...input, command: "echo rewritten" } }
          if (input.file_path !== undefined) return { arguments: { ...input, limit: 1 } }
          return undefined
        }),
    }),
  ],
})

/** An extension tool that tells the time. */
const clock = defineExtension({
  name: "clock",
  tools: [
    defineTool({
      name: "Clock",
      description: "The time in a zone",
      parameters: { type: "object", properties: { zone: { type: "string" } }, required: ["zone"] },
      execute: (args: { zone: string }) =>
        Effect.succeed({ output: [{ type: "text" as const, text: `noon in ${args.zone}` }] }),
    }),
  ],
})

test("claude-extensions: an extension's tool reaches Claude through sigma's own MCP server, without asking", async () => {
  const claude = fake("own_tool")
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [clock])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "what time is it")
      return yield* entries(conversation)
    }),
  )
  expect(said(all)).toEqual([
    "user: what time is it",
    'call Clock {"zone":"CET"}',
    "result Clock: noon in CET",
    "assistant: It is noon in CET.",
  ])
  // Claude Code is offered the tool once, over MCP, not also as one of its own.
  expect(spawns(claude)[0]!.find((arg) => arg.startsWith("--disallowedTools"))).toBe("--disallowedTools=Clock")
  expect(claude.log().find((entry) => entry.initialize)?.initialize.sdkMcpServers).toEqual(["sigma"])
})

test("claude-extensions: an extension refuses a call Claude wants, in sigma's words, and Claude Code hears why", async () => {
  const claude = fake("bash_hook_denied")
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [guard])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "touch it")
      return yield* entries(conversation)
    }),
  )
  expect(said(all).filter((line) => line.startsWith("result"))).toEqual([
    "result Bash: Tool call blocked: no touching (error)",
  ])
  expect(hookAnswers(claude)).toEqual([
    {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Tool call blocked: no touching",
    },
  ])
})

test("claude-extensions: an extension's rewrite of a call is what Claude Code runs and what the transcript shows", async () => {
  const claude = fake("bash_hook_rewritten")
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [guard])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "echo it")
      return yield* entries(conversation)
    }),
  )
  expect(said(all).slice(1, 3)).toEqual([
    'call Bash {"command":"echo rewritten","description":"Print the word original"}',
    "result Bash: rewritten",
  ])
  expect(hookAnswers(claude)).toEqual([
    {
      hookEventName: "PreToolUse",
      updatedInput: { command: "echo rewritten", description: "Print the word original" },
    },
  ])
})

test("claude-extensions: an extension's hooks reach the calls of Claude's subagents, in the subagent's conversation", async () => {
  const claude = fake("subagent_hooked")
  const hookedIn: Array<[string, number]> = []
  const witness = defineExtension({
    name: "witness",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call: { name: string }, api: { conversationId: unknown }) =>
          Effect.sync(() => void hookedIn.push([call.name, Number(api.conversationId)])),
      }),
    ],
  })
  const { parent, child, cwd, parentId, childId } = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [guard, witness])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "what time is it")
      const all = yield* entries(conversation)
      const placed = all.find((entry) => entry.kind === "sigma.subagent")!.data as { conversation: number }
      const subagent = (yield* harness.conversation(placed.conversation as never))!
      yield* subagent.waitForIdle
      const parentId = Number(conversation.id)
      return { parent: all, child: yield* entries(subagent), cwd, parentId, childId: placed.conversation }
    }),
  )
  // The hooks act on the conversation the call is in.
  expect(hookedIn).toEqual([
    ["Agent", parentId],
    ["Read", childId],
  ])
  expect(said(child).find((line) => line.startsWith("call"))).toBe(
    `call Read ${JSON.stringify({ file_path: `${cwd}/notes.txt`, limit: 1 })}`,
  )
  expect(said(parent).some((line) => line.startsWith("call Read"))).toBe(false)
  expect(hookAnswers(claude)).toEqual([
    { hookEventName: "PreToolUse", updatedInput: { file_path: `${cwd}/notes.txt`, limit: 1 } },
  ])
})

test("claude-extensions: an extension's tool runs for Claude's subagents, in the subagent's conversation", async () => {
  const claude = fake("subagent_own_tool")
  const { parent, child } = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [clock])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "ask a subagent the time in CET")
      const all = yield* entries(conversation)
      const placed = all.find((entry) => entry.kind === "sigma.subagent")!.data as { conversation: number }
      const subagent = (yield* harness.conversation(placed.conversation as never))!
      yield* subagent.waitForIdle
      return { parent: all, child: yield* entries(subagent) }
    }),
  )
  expect(said(child).filter((line) => /^(call|result) Clock/.test(line))).toEqual([
    'call Clock {"zone":"CET"}',
    "result Clock: noon in CET",
  ])
  expect(said(parent).some((line) => line.includes("Clock {"))).toBe(false)
  expect(said(parent).at(-1)).toBe("assistant: noon in CET")
})

test("image-input: an image in a prompt reaches Claude Code beside its text", async () => {
  const claude = fake("text")
  const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [])
      const conversation = yield* start(harness, cwd)
      yield* conversation.submit({ type: "input", content: [{ type: "text", text: "what is this" }, image] })
      yield* conversation.waitForIdle
    }),
  )
  const sent = claude.log().find((entry) => entry.received?.type === "user")!.received.message.content
  expect(sent).toEqual([
    { type: "text", text: "what is this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ])
})

test("claude-clear: a reset queued while Claude works ends the run, and what was queued with it starts fresh", async () => {
  const claude = fake("read", "text")
  const queued: { conversation?: Conversation } = {}
  const resets = defineExtension({
    name: "resets",
    hooks: [
      hook(ToolTask, {
        beforeTool: () =>
          Effect.gen(function* () {
            yield* queued.conversation!.submit({
              type: "write",
              entry: {
                kind: ResetEntry.kind,
                head: "self",
                model: [{ role: "user", content: "start over", timestamp: 0 }],
              },
            })
            yield* queued.conversation!.submit({ type: "input", content: "Reply with exactly: fixture text ok" })
            return undefined
          }),
      }),
    ],
  })
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [resets])
      const conversation = yield* start(harness, cwd)
      queued.conversation = conversation
      yield* ask(conversation, "read it")
      return yield* entries(conversation)
    }),
  )
  expect(all.map((entry) => entry.kind)).toEqual([
    "pi.user",
    "pi.assistant",
    "pi.tool-result",
    "pi.reset",
    "pi.user",
    "pi.assistant",
  ])
  // The next run starts a session of its own, told only what follows the reset.
  const [first, next] = spawns(claude)
  expect(next!.some((arg) => arg.startsWith("--resume"))).toBe(false)
  expect(next!.find((arg) => arg.startsWith("--session-id"))).not.toBe(
    first!.find((arg) => arg.startsWith("--session-id")),
  )
  const told = claude
    .log()
    .filter((entry) => entry.received?.type === "user" && entry.spawn === 1)
    .map((entry) => entry.received.message.content.map((part: { text: string }) => part.text))
  expect(told).toEqual([["start over", "Reply with exactly: fixture text ok"]])
})

test("image-tool-result: an image an extension tool returns reaches Claude Code beside its text", async () => {
  const claude = fake("own_tool")
  const picture = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }
  const camera = defineExtension({
    name: "clock",
    tools: [
      defineTool({
        name: "Clock",
        description: "The time in a zone, and a picture of the clock",
        parameters: { type: "object", properties: { zone: { type: "string" } }, required: ["zone"] },
        execute: (args: { zone: string }) =>
          Effect.succeed({ output: [{ type: "text" as const, text: `noon in ${args.zone}` }, picture] }),
      }),
    ],
  })
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [camera])
      yield* ask(yield* start(harness, cwd), "what time is it")
    }),
  )
  const reply = claude.log().find((entry) => entry.answered === "mcp_message")!.received.response.response
  expect(JSON.stringify(reply)).toContain(JSON.stringify([{ type: "text", text: "noon in CET" }, picture]))
})

test("claude-live, claude-resume: an edit to the context closes the live process and starts a fresh session told the edited conversation", async () => {
  const claude = fake("text", "text")
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "a secret to forget")
      const first = (yield* entries(conversation)).find((entry) => entry.kind === UserEntry.kind)!
      yield* conversation.submit({
        type: "write",
        entry: { kind: "test.forget", edits: [{ target: first.id, action: "omit" }] },
      })
      yield* ask(conversation, "Reply with exactly: fixture text ok")
    }),
  )
  const [before, after] = spawns(claude)
  expect(after!.some((arg) => arg.startsWith("--resume"))).toBe(false)
  expect(after!.find((arg) => arg.startsWith("--session-id"))).not.toBe(
    before!.find((arg) => arg.startsWith("--session-id")),
  )
  const told = claude
    .log()
    .filter((entry) => entry.received?.type === "user" && entry.spawn === 1)
    .flatMap((entry) => entry.received.message.content.map((part: { text: string }) => part.text))
  expect(told.join("\n")).not.toContain("a secret to forget")
  expect(told.at(-1)).toBe("Reply with exactly: fixture text ok")
})

test("claude-live: a reset between runs closes the live process, and the next run starts a fresh session", async () => {
  const claude = fake("text", "text")
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "a secret to forget")
      yield* conversation.submit({
        type: "write",
        entry: { kind: ResetEntry.kind, head: "self", model: [{ role: "user", content: "start over", timestamp: 0 }] },
      })
      yield* ask(conversation, "Reply with exactly: fixture text ok")
    }),
  )
  const [before, after] = spawns(claude)
  expect(after!.some((arg) => arg.startsWith("--resume"))).toBe(false)
  expect(after!.find((arg) => arg.startsWith("--session-id"))).not.toBe(
    before!.find((arg) => arg.startsWith("--session-id")),
  )
  const told = claude
    .log()
    .filter((entry) => entry.received?.type === "user" && entry.spawn === 1)
    .flatMap((entry) => entry.received.message.content.map((part: { text: string }) => part.text))
  expect(told).toEqual(["start over", "Reply with exactly: fixture text ok"])
})

test("claude-read: parallel calls of one response are each committed with the result Claude Code returned", async () => {
  const claude = fake("parallel_reads_hooked")
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [])
      const conversation = yield* start(harness, cwd)
      yield* ask(
        conversation,
        "In a single message, call the Read tool twice in parallel: once on a.txt and once on b.txt. Then reply with both contents, separated by a comma.",
      )
      const context = yield* conversation.context()
      return { entries: yield* entries(conversation), context: context.messages.map((message) => message.role) }
    }),
  )
  expect(said(all.entries).filter((line) => line.startsWith("result"))).toEqual([
    "result Read: 1\tapple\n2\t",
    "result Read: 1\tbanana\n2\t",
  ])
  // One response: both calls, then both results, in the model context.
  expect(all.context).toEqual(["user", "assistant", "assistant", "toolResult", "toolResult", "assistant"])
})

test("steer-claude: a steer sent between the results of parallel calls reaches Claude Code after both", async () => {
  const claude = fake("steer_mid_message")
  const steered: { conversation?: Conversation } = {}
  const refuseA = defineExtension({
    name: "guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call: { arguments: Record<string, unknown> }) =>
          Effect.gen(function* () {
            const path = String(call.arguments.file_path)
            if (path.endsWith("a.txt")) return { block: "a.txt is off limits" }
            // Sent while b.txt's call is in flight, after a.txt's result.
            yield* steered.conversation!.submit({
              type: "input",
              content: "Also end your reply with the word BANANA.",
              whenBusy: "steer",
            })
            return undefined
          }),
      }),
    ],
  })
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [refuseA])
      const conversation = yield* start(harness, cwd)
      steered.conversation = conversation
      yield* ask(
        conversation,
        "In a single message, call the Read tool twice in parallel: once on a.txt and once on b.txt. Then reply with both contents, separated by a comma.",
      )
      return yield* entries(conversation)
    }),
  )
  const lines = said(all)
  expect(lines.slice(-4)).toEqual([
    "result Read: 1\tbanana\n2\t",
    "user: Also end your reply with the word BANANA.",
    "assistant: a.txt was off limits; b.txt holds banana.",
    "assistant: b.txt holds banana. BANANA",
  ])
  const steers = claude.log().filter((entry) => entry.received?.type === "user" && entry.received.priority === "next")
  expect(steers).toHaveLength(1)
})

test("claude-resume: a fork of a Claude conversation forks Claude Code's session at the fork's position", async () => {
  const claude = fake("died_while_idle")
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "Remember the word PLUM. Reply with exactly: noted")
      const [last] = (yield* conversation.entries({}, 1)).items
      const fork = yield* conversation.fork(last!.id, { ownership: { kind: "ownerless" } })
      yield* ask(fork, "Which word did I ask you to remember? Reply with that word only.")
    }),
  )
  const [first, second] = spawns(claude)
  const session = first!.find((arg) => arg.startsWith("--session-id"))!.split("=")[1]
  expect(second).toContain(`--resume=${session}`)
  expect(second).toContain("--fork-session")
  expect(second!.find((arg) => arg.startsWith("--session-id"))).not.toBe(`--session-id=${session}`)
})

test("claude-resume: what each run spent is added to the conversation's usage, once, when each run starts its own process", async () => {
  const claude = fake("died_while_idle")
  const usage = await run(
    Effect.gen(function* () {
      // No live process: the recording's two runs each started one.
      const { harness, cwd } = yield* open(claude, [], [], { idle: 0 })
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "Remember the word PLUM. Reply with exactly: noted")
      yield* ask(conversation, "Which word did I ask you to remember? Reply with that word only.")
      return (yield* harness.session.snapshot(UsageDoc, conversation.id))!.models
    }),
  )
  // Each process reports its own totals at its result: the two recorded results, added up.
  expect(usage["claude/claude-haiku-5-5"]).toMatchObject({
    input: 4,
    output: 10,
    cacheRead: 38_052,
    cacheWrite: 12_626,
    totalTokens: 50_692,
  })
  expect(usage["claude/claude-haiku-5-5"]!.cost.total).toBeCloseTo(0.00291112, 10)
})

/** Commits a turn another provider answered: the prompt, and its echo. */
const scripted = (conversation: Conversation, text: string) =>
  conversation.commit((tx) =>
    Effect.gen(function* () {
      yield* tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: text, timestamp: 0 }] })
      const answer = {
        role: "assistant",
        content: [{ type: "text", text: `You said: ${text}` }],
        api: "script",
        provider: "script",
        model: "script",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      }
      yield* tx.appendEntry(AssistantEntry, conversation.id, { model: [answer as never] })
    }),
  )

test("claude-switch, claude-live: switching to Claude from another provider retells the conversation to a new Claude Code session", async () => {
  const claude = fake("handoff")
  const question = "Which word did I ask you to remember? Reply with just the word."
  const last = "What was the last thing I said before this message? Reply with just that word."
  await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [])
      const conversation = yield* harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "script", modelId: "script" }, cwd },
      })
      yield* scripted(conversation, "Remember the word lantern.")
      yield* scripted(conversation, "x".repeat(70_000))
      yield* scripted(conversation, "Nothing else for now.")
      yield* conversation.configure({ model: { provider: "claude", modelId: "haiku" } })
      yield* ask(conversation, question)
      yield* conversation.configure({ model: { provider: "script", modelId: "script" } })
      yield* scripted(conversation, "plum")
      yield* conversation.configure({ model: { provider: "claude", modelId: "haiku" } })
      yield* ask(conversation, last)
    }),
  )
  const told = (spawn: number) =>
    claude
      .log()
      .filter((entry) => entry.received?.type === "user" && entry.spawn === spawn)
      .map((entry) => entry.received.message.content.map((block: { text: string }) => block.text))
  const opening = [
    "This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it.",
    "Remember the word lantern.",
    "(3 entries left out here)",
    "Nothing else for now.",
    "You answered: You said: Nothing else for now.",
  ]
  expect(told(0)).toEqual([[...opening, question]])
  expect(told(1)).toEqual([
    [...opening, question, "You answered: lantern", "plum", "You answered: You said: plum", last],
  ])
  const [first, second] = spawns(claude)
  expect(second!.some((arg) => arg.startsWith("--resume"))).toBe(false)
  expect(second!.find((arg) => arg.startsWith("--session-id"))).not.toBe(
    first!.find((arg) => arg.startsWith("--session-id")),
  )
})

test("execute-after: afterTool changes what Claude Code's Read returns, and says so when it can't change another tool's result", async () => {
  const claude = fake("read_after_hooked")
  const shout = defineExtension({
    name: "shout",
    hooks: [
      hook(ToolTask, {
        afterTool: (_call: unknown, result: { output: Array<{ type: "text"; text: string }> }) =>
          Effect.succeed({
            ...result,
            output: result.output.map((part) => ({ ...part, text: part.text.toUpperCase() })),
          }),
      }),
    ],
  })
  const reports: Array<unknown> = []
  const all = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [shout], reports)
      const conversation = yield* start(harness, cwd)
      yield* ask(
        conversation,
        "Use the Read tool to read notes.txt, then use the Bash tool to run `echo quiet`, then reply with exactly what each returned, separated by a comma.",
      )
      return yield* entries(conversation)
    }),
  )
  expect(said(all).filter((line) => !line.startsWith("call"))).toEqual([
    "user: Use the Read tool to read notes.txt, then use the Bash tool to run `echo quiet`, then reply with exactly what each returned, separated by a comma.",
    "result Read: 1\tTHE GNOME LIVES UNDER THE FLOOR\n2\t",
    "result Bash: quiet",
    "assistant: THE GNOME LIVES UNDER THE FLOOR, quiet",
  ])
  const outputs = claude
    .log()
    .filter((entry) => entry.answered === "hook_callback")
    .map((entry) => entry.received.response.response.hookSpecificOutput)
    .filter((output) => output?.hookEventName === "PostToolUse")
  expect(outputs).toEqual([
    {
      hookEventName: "PostToolUse",
      updatedToolOutput: expect.objectContaining({
        file: expect.objectContaining({ content: "THE GNOME LIVES UNDER THE FLOOR\n" }),
      }),
    },
  ])
  expect(reports).toEqual([
    expect.objectContaining({
      kind: "extension_error",
      error: new Error("afterTool changed Bash's result, but Claude Code keeps its own result"),
    }),
  ])
})
