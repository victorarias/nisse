// claude.run through the harness's own seams: a Harness over real SQLite whose registry holds extensions written as a
// host installs them, with Claude Code played by nisse's fake `claude` replaying a recorded process per spawn. These
// cover what the kernel wire cannot reach yet: extension tools and hooks, and forks.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Scope } from "effect"
import { type EntryRecord, openSqliteStorage } from "@nisse/kernel"
import { fromProviders } from "@nisse/models"
import {
  approveAutomatically,
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  type Harness,
  hook,
  openHarness,
  ToolTask,
} from "@nisse/harness"
import { claudeRunTasks } from "../src/index.ts"

const FIXTURES = join(import.meta.dir, "../../../fixtures/claude")
const FAKE = join(import.meta.dir, "../../nisse/test/support/fake-claude")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake Claude Code playing `fixture`, and what it logged. */
const fake = (fixture: string) => {
  const dir = mkdtempSync("/tmp/nisse-claude-")
  dirs.push(dir)
  return {
    dir,
    settings: {
      executable: FAKE,
      env: { FAKE_CLAUDE_FIXTURE: join(FIXTURES, `${fixture}.ndjson`), FAKE_CLAUDE_DIR: dir },
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
const open = (claude: Fake, extensions: ReadonlyArray<Parameters<ReturnType<typeof createRegistry>["install"]>[0]>) =>
  Effect.gen(function* () {
    // The fake writes the conversation's directory into its recorded paths as given; on macOS /tmp is /private/tmp.
    const dir = realpathSync(mkdtempSync("/tmp/nisse-harness-"))
    dirs.push(dir)
    const registry = createRegistry()
    const tasks = claudeRunTasks({ settings: (provider) => (provider === "claude" ? claude.settings : undefined) })
    registry.install(defineExtension({ name: "claude", tasks: [tasks.run, tasks.subagent] }))
    for (const extension of extensions) registry.install(extension)
    const harness = yield* Effect.acquireRelease(
      Effect.flatMap(openSqliteStorage(join(dir, "kernel.sqlite")), (storage) =>
        openHarness(storage, { registry, models: fromProviders([]), runTasks: tasks.runTasks }),
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
        return [`result ${message.toolName}: ${message.content.map((part: any) => part.text).join("")}${message.isError ? " (error)" : ""}`]
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

test("claude-extensions: an extension's tool reaches Claude through nisse's own MCP server, without asking", async () => {
  const claude = fake("own_tool")
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
  expect(claude.log().find((entry) => entry.initialize)?.initialize.sdkMcpServers).toEqual(["nisse"])
})

test("claude-extensions: an extension refuses a call Claude wants, in nisse's words, and Claude Code hears why", async () => {
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
    { hookEventName: "PreToolUse", updatedInput: { command: "echo rewritten", description: "Print the word original" } },
  ])
})

test("claude-extensions: an extension's hooks reach the calls of Claude's subagents, in the subagent's conversation", async () => {
  const claude = fake("subagent_hooked")
  const { parent, child, cwd } = await run(
    Effect.gen(function* () {
      const { harness, cwd } = yield* open(claude, [guard])
      const conversation = yield* start(harness, cwd)
      yield* ask(conversation, "what time is it")
      const all = yield* entries(conversation)
      const placed = all.find((entry) => entry.kind === "nisse.subagent")!.data as { conversation: number }
      const subagent = (yield* harness.conversation(placed.conversation as never))!
      yield* subagent.waitForIdle
      return { parent: all, child: yield* entries(subagent), cwd }
    }),
  )
  expect(said(child).find((line) => line.startsWith("call"))).toBe(
    `call Read ${JSON.stringify({ file_path: `${cwd}/notes.txt`, limit: 1 })}`,
  )
  expect(said(parent).some((line) => line.startsWith("call Read"))).toBe(false)
  expect(hookAnswers(claude)).toEqual([
    { hookEventName: "PreToolUse", updatedInput: { file_path: `${cwd}/notes.txt`, limit: 1 } },
  ])
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
