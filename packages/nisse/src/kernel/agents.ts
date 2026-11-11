// Subagent tools for the model on the kernel: spawn, send, follow up, wait, list and interrupt. A subagent is a child
// conversation owned by a background anchor task in its parent, so it outlives the parent's turns; each task given to
// it goes through a background reporter task in the parent, which delivers it, waits for the answer and mails the
// answer back. Both are durable tasks, so a restart resumes them (spec 7.3, example 22).
import {
  type AgentLimits,
  type Harness,
  ApprovalsDoc,
  approveAutomatically,
  AssistantEntry,
  ConversationIdle,
  configure,
  DEFAULT_AGENT_LIMITS,
  defineExtension,
  defineTool,
  depthOf,
  InboxDoc,
  LiveDoc,
  refusedSpawn,
  refusedWork,
  ROOT_TASK,
  type ToolExecutionApi,
  type ToolExecutionResult,
  TaskServices,
} from "@nisse/harness"
import {
  type ConversationId,
  defineDoc,
  defineTask,
  type EntryId,
  idFromNumber,
  type JsonObject,
  type NextTaskState,
} from "@nisse/kernel"
import type { AssistantMessage } from "@nisse/models"
import { int, obj, oneOf, opt, str } from "@nisse/schema"
import { rootConversation } from "@nisse/tools"
import { Clock, Duration, Effect, Option, Stream } from "effect"

/** How a subagent's last task ended, as `list_agents` reports it. */
export type AgentStatus = "pending_init" | "interrupted" | { completed: string } | { errored: string }

type Child = {
  conversationId: number
  task: string
  status?: AgentStatus
  reported: number[]
  /** Given a task its reporter has not yet seen end: it counts as working before its run starts. */
  assigned?: true
}

/** A conversation's subagents by name, and the reporter each tool call started. */
export const AgentsDoc = defineDoc<{ agents: Record<string, Child>; reporters: Record<string, number> }>({
  kind: "nisse.agents",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork starts without subagents.
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} }),
  checkpointWhen: () => true,
})

/** A subagent's own canonical task path, such as `/root/writer`; the conversation people started has none. */
export const TaskPathDoc = defineDoc<{ task: string }>({
  kind: "nisse.task_path",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ task: ROOT_TASK }),
  checkpointWhen: () => true,
})

export type MailKind = "new_task" | "message" | "final_answer"

/** The entry a message between agents is placed as; the model reads it as a user message. */
export const MAIL_ENTRY_KIND = "nisse.mail"

export const mailText = (kind: MailKind, task: string, sender: string, text: string) => {
  const type = { new_task: "NEW_TASK", message: "MESSAGE", final_answer: "FINAL_ANSWER" }[kind]
  return `Message Type: ${type}\nTask name: ${task}\nSender: ${sender}\nPayload:\n${text}`
}

const mailEntry = (kind: MailKind, task: string, sender: string) => ({
  kind: MAIL_ENTRY_KIND,
  data: { kind, task, sender },
})

/** The line in a subagent's instructions that names it; the `script` model reads it to pick the agent's steps. */
export const taskNameLine = (task: string) => `Your task name is ${task}.`
const TASK_NAME = /Your task name is (\/[^\s.]+)\./

/** The task a request is for: the last instructions that name one, or the root. */
export const taskOfRequest = (messages: ReadonlyArray<{ readonly role: string }>): string => {
  for (const message of [...messages].reverse()) {
    if (message.role !== "system") continue
    const named = TASK_NAME.exec(JSON.stringify(message))
    if (named !== null) return named[1]!
  }
  return ROOT_TASK
}

const errored = (message: string) =>
  `Agent errored: ${message}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`

// ─── Tasks ────────────────────────────────────────────────────────────────────

/** Owns a subagent's conversation: completes at once, and holds `completing` while the subagent has work. */
const Anchor = defineTask<null, { readonly phase: "done" }, null, TaskServices>({
  name: "nisse.agent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime) =>
      runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "completed", result: null } })),
  },
  abort: (_task, runtime) =>
    runtime.commit(() => Effect.succeed({ status: "terminal", outcome: { status: "aborted" } })),
})

type ReporterInput = { name: string; task: string; sender: string; conversationId: number; message: string }
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string }

/**
 * Gives one task to a subagent, waits for its answer, records how it ended, and mails the answer to the parent. Request
 * IDs from its own task ID make a rerun find its submissions, so each arrives once.
 */
const Reporter = defineTask<ReporterInput, ReporterState, null, TaskServices>({
  name: "nisse.agent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: (reporter, runtime) =>
      Effect.gen(function* () {
        const services = yield* TaskServices
        const { name, task, sender, message } = reporter.input
        const child = (yield* services.conversation(idFromNumber<ConversationId>(reporter.input.conversationId)))!
        const submission = yield* child.submit({
          type: "input",
          content: mailText("new_task", task, sender, message),
          // A working subagent takes it at its next step, as other mail.
          whenBusy: "steer",
          entry: mailEntry("new_task", task, sender),
          requestId: `agent:${reporter.id}`,
        })
        const settled = yield* submission.wait
        yield* runtime.commit((tx) =>
          Effect.gen(function* () {
            const agent = (yield* tx.doc(AgentsDoc, runtime.conversationId)).agents[name]!
            delete agent.assigned
            const next = (report?: string): NextTaskState<ReporterState, null> => ({
              status: "running",
              checkpoint: report === undefined ? { phase: "report" } : { phase: "report", report },
            })
            if (settled.status === "unanswered") {
              // Interrupted, or withdrawn while queued: nothing to report.
              if (settled.reason === "aborted") {
                agent.status = "interrupted"
                return next()
              }
              const detail = typeof settled.detail === "string" ? settled.detail : settled.reason
              agent.status = { errored: detail }
              return next(errored(detail))
            }
            if (settled.type !== "input") return next()
            const answer = settled.answer as EntryId
            // Several tasks can end in one answer; it is reported once.
            if (agent.reported.includes(answer)) return next()
            agent.reported.push(answer)
            const said = textOf((yield* tx.entry(AssistantEntry, answer))?.model?.[0] as AssistantMessage | undefined)
            agent.status = { completed: said }
            return next(said)
          }),
        )
      }),
    report: (reporter, runtime) =>
      Effect.gen(function* () {
        const report = reporter.state.checkpoint.report
        if (report !== undefined) {
          const { task, sender } = reporter.input
          const parent = (yield* (yield* TaskServices).conversation(runtime.conversationId))!
          const content = mailText("final_answer", sender, task, report)
          const entry = mailEntry("final_answer", sender, task)
          const submission = yield* parent.submit({
            type: "input",
            content,
            // Into the parent's running turn at its next step, as other mail; an idle parent starts a turn.
            whenBusy: "steer",
            entry,
            requestId: `agent-report:${reporter.id}`,
          })
          const settled = yield* submission.wait
          // Withdrawn before it was placed, as when the person stops the parent: the answer still joins its transcript,
          // once the stopped run has ended, so it lands then instead of waiting in the queue for the next prompt.
          if (settled.status === "unanswered" && settled.entry === undefined) {
            yield* parent.waitForIdle
            const timestamp = yield* Clock.currentTimeMillis
            yield* parent.submit({
              type: "write",
              entry: { ...entry, model: [{ role: "user", content, timestamp }] as unknown as JsonObject[] },
              requestId: `agent-report-kept:${reporter.id}`,
            })
          }
        }
        yield* runtime.commit(() =>
          Effect.succeed({ status: "terminal", outcome: { status: "completed", result: null } }),
        )
      }),
  },
  abort: (reporter, runtime) =>
    runtime.commit((tx) =>
      Effect.gen(function* () {
        const agent = (yield* tx.doc(AgentsDoc, runtime.conversationId)).agents[reporter.input.name]
        if (agent !== undefined) delete agent.assigned
        return { status: "terminal", outcome: { status: "aborted" } } as const
      }),
    ),
})

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")

// ─── Reading the tree ─────────────────────────────────────────────────────────

type Member = {
  readonly task: string
  readonly conversationId: ConversationId
  readonly child?: Child
  /** The conversation whose registry holds `child`. */
  readonly parent?: ConversationId
}

const taskOf = (api: ToolExecutionApi, conversationId: ConversationId) =>
  Effect.map(api.snapshot(TaskPathDoc, conversationId), (path) => path?.task ?? ROOT_TASK)

/** Every agent of the caller's tree, the root first, each parent before its subagents. */
const membersOf = (api: ToolExecutionApi) =>
  Effect.gen(function* () {
    const root = yield* rootConversation(api)
    const members: Member[] = [{ task: ROOT_TASK, conversationId: root }]
    for (let at = 0; at < members.length; at++) {
      const registry = yield* api.snapshot(AgentsDoc, members[at]!.conversationId)
      for (const child of Object.values(registry?.agents ?? {})) {
        const parent = members[at]!.conversationId
        members.push({ task: child.task, conversationId: idFromNumber(child.conversationId), child, parent })
      }
    }
    return members
  })

/** The agent `target` names, from the caller: a canonical path, or a name relative to the caller's path. */
const resolveTarget = (api: ToolExecutionApi, target: string) =>
  Effect.gen(function* () {
    const own = yield* taskOf(api, api.conversationId)
    const trimmed = target.trim()
    const task = trimmed.startsWith("/") ? trimmed : `${own}/${trimmed}`
    return { own, member: (yield* membersOf(api)).find((member) => member.task === task) }
  })

const busy = (api: ToolExecutionApi, conversationId: ConversationId) =>
  Effect.map(api.snapshot(LiveDoc, conversationId), (live) => live?.run !== undefined)

/**
 * Counts the tree's working subagents for a commit that gives one a task, so tasks given at once see each other: those
 * in `registry` (the doc of `parent`, read in the commit) by their marks and runs, the rest as read before it.
 */
const workingCounter = (api: ToolExecutionApi, members: ReadonlyArray<Member>, parent: ConversationId) =>
  Effect.gen(function* () {
    let elsewhere = 0
    const running = new Set<number>()
    for (const member of members) {
      if (member.child === undefined) continue
      const working = (yield* busy(api, member.conversationId)) || member.child.assigned === true
      if (member.parent === parent) {
        if (working) running.add(member.child.conversationId)
      } else if (working) elsewhere++
    }
    return (registry: { readonly agents: Record<string, Child> }) =>
      elsewhere +
      Object.values(registry.agents).filter((child) => child.assigned === true || running.has(child.conversationId))
        .length
  })

const statusOf = (api: ToolExecutionApi, member: Member) =>
  Effect.map(busy(api, member.conversationId), (running): AgentStatus | "running" =>
    running ? "running" : (member.child?.status ?? "pending_init"),
  )

// ─── Tools ────────────────────────────────────────────────────────────────────

const ok = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] })
const json = (value: unknown) => ok(JSON.stringify(value))
const failed = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true })

const DEFAULT_WAIT_MS = 30_000
const MIN_WAIT_MS = 10_000
const MAX_WAIT_MS = 3_600_000

const spawnDescription = `Spawns an agent to work on the specified task. If your current task is \`/root/task1\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`/root/task1/task_3\`.
You are then able to refer to this agent as \`task_3\` or \`/root/task1/task_3\` interchangeably. However an agent \`/root/task2/task_3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task_3\`.
The spawned agent will have the same tools as you.
Spawned agents inherit your current model by default. Do not set the \`model\` field unless the user explicitly asks for a different model.
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.

Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.

Note that passing \`fork_turns="none"\` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas \`fork_turns="all"\` will provide the subagent with all surrounding context.`

const spawnSchema = obj({
  task_name: str({ description: "Task name for the new agent. Use lowercase letters, digits, and underscores." }),
  message: str({ description: "Initial plain-text task for the new agent." }),
  fork_turns: opt(
    oneOf(["all", "none"], {
      description: "Parent history to inherit. Defaults to `all`; use `none` to start without parent history.",
    }),
  ),
  model: opt(str({ description: "Model override for the new agent. Omit unless an explicit override is needed." })),
  reasoning_effort: opt(
    oneOf(["minimal", "low", "medium", "high", "xhigh"], {
      description: "Reasoning effort override for the new agent. Omit to inherit the parent effort.",
    }),
  ),
})

type SpawnInput = {
  task_name: string
  message: string
  fork_turns?: "all" | "none"
  model?: string
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh"
}

const background = { ownership: { kind: "conversation" }, background: true } as const

const spawnAgent = (limits: AgentLimits) =>
  defineTool({
    name: "spawn_agent",
    description: spawnDescription,
    parameters: spawnSchema,
    execute: (input: SpawnInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        if (input.message.trim() === "") return failed("Empty message can't be sent to an agent")
        const name = input.task_name.trim()
        if (!/^[a-z0-9_]+$/.test(name)) return failed("task_name takes lowercase letters, digits and underscores")
        const own = yield* taskOf(api, api.conversationId)
        const members = yield* membersOf(api)
        const working = yield* workingCounter(api, members, api.conversationId)
        const agent = yield* api.agent
        const parentModel = agent.model
        if (input.model !== undefined && parentModel === undefined) return failed("this agent has no model to vary")
        if (input.model !== undefined && api.models().getModel(parentModel!.provider, input.model) === undefined)
          return failed(`no model ${input.model} on ${parentModel!.provider}; leave model out to use yours`)
        const task = `${own}/${name}`
        // A subagent of a conversation that runs every call without asking does too: nobody watches it to answer.
        const auto = (yield* api.snapshot(ApprovalsDoc, api.conversationId))?.auto === true
        const started = yield* api.commit((tx) =>
          Effect.gen(function* () {
            const registry = yield* tx.doc(AgentsDoc, api.conversationId)
            // A rerun of this call finds the subagent it started.
            const already = registry.reporters[String(api.taskId)]
            if (already !== undefined) return registry.agents[name]?.conversationId
            if (Object.hasOwn(registry.agents, name)) return undefined
            const refused = refusedSpawn(limits, own, working(registry))
            if (refused !== undefined) return refused
            const forkAt = input.fork_turns === "none" ? undefined : yield* tx.latestEntryId(api.conversationId)
            const anchor = yield* tx.createTask(Anchor, null, background)
            const ownership = { kind: "task", taskId: anchor } as const
            const child =
              forkAt === undefined
                ? yield* tx.createConversation({ ownership })
                : yield* tx.forkConversation(api.conversationId, forkAt, { ownership })
            yield* configure(tx, child.id, {
              // The instructions a conversation started with are its own; a subagent starts without them.
              instructions: `${taskNameLine(task)} You are a subagent; your final answer goes to ${own}.`,
              ...(input.model === undefined
                ? {}
                : { model: { provider: parentModel!.provider, modelId: input.model } }),
              ...(input.reasoning_effort === undefined ? {} : { thinkingLevel: input.reasoning_effort }),
              // Past the depth limit a subagent is not offered spawn_agent at all.
              ...(depthOf(task) >= limits.maxDepth ? { modelTools: { remove: [{ name: "spawn_agent" }] } } : {}),
            })
            ;(yield* tx.doc(TaskPathDoc, child.id)).task = task
            if (auto) yield* approveAutomatically(tx, child.id)
            registry.agents[name] = { conversationId: Number(child.id), task, reported: [], assigned: true }
            const reporter: ReporterInput = {
              name,
              task,
              sender: own,
              conversationId: Number(child.id),
              message: input.message,
            }
            registry.reporters[String(api.taskId)] = Number(yield* tx.createTask(Reporter, reporter, background))
            return Number(child.id)
          }),
        )
        if (started === undefined) return failed(`${task} already exists; use followup_task or send_message`)
        if (typeof started === "string") return failed(started)
        // A client that sees the call attaches to the subagent's view through its details.
        return { ...json({ task_name: task, nickname: null }), details: { task, conversation: started } }
      }),
  })

const messageSchema = (target: string, message: string) =>
  obj({ target: str({ description: target }), message: str({ description: message }) })

/** A message that starts no turn: steers a busy agent, and is added to an idle one's transcript for its next turn. */
const sendMessage = defineTool({
  name: "send_message",
  description:
    "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
  parameters: messageSchema(
    "Relative or canonical task name to message (from spawn_agent).",
    "Message text to queue on the target agent.",
  ),
  execute: (input: { target: string; message: string }, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      if (input.message.trim() === "") return failed("Empty message can't be sent to an agent")
      const { own, member } = yield* resolveTarget(api, input.target)
      if (member === undefined) return failed(`no agent ${input.target.trim()}`)
      const to = (yield* api.conversation(member.conversationId))!
      const content = mailText("message", member.task, own, input.message)
      const entry = mailEntry("message", member.task, own)
      const requestId = `agent-message:${api.taskId}`
      yield* to.submit({ type: "input", content, whenBusy: "steer", whenIdle: "reject", entry, requestId }).pipe(
        Effect.catchIf(
          (error) => error instanceof ConversationIdle,
          () =>
            to.submit({
              type: "write",
              entry: { ...entry, model: [{ role: "user", content, timestamp: api.now() }] as unknown as JsonObject[] },
              requestId,
            }),
        ),
      )
      return ok("")
    }),
})

const followupTask = (limits: AgentLimits) =>
  defineTool({
    name: "followup_task",
    description:
      "Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
    parameters: messageSchema(
      "Agent id or canonical task name to send a follow-up task to (from spawn_agent).",
      "Message text to send to the target agent.",
    ),
    execute: (input: { target: string; message: string }, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        if (input.message.trim() === "") return failed("Empty message can't be sent to an agent")
        const { own, member } = yield* resolveTarget(api, input.target)
        if (member === undefined) return failed(`no agent ${input.target.trim()}`)
        if (member.child === undefined) return failed("followup_task takes a subagent; send_message reaches the root")
        // The reporter lives in the subagent's parent, whose registry records how the task ended.
        const name = member.task.split("/").at(-1)!
        const parentTask = member.task.slice(0, member.task.lastIndexOf("/"))
        const members = yield* membersOf(api)
        const parentConversation = members.find((each) => each.task === parentTask)!.conversationId
        // A task for an idle subagent starts a run, so it counts against maxThreads; a working one only queues it.
        const idle = !(yield* busy(api, member.conversationId)) && member.child.assigned !== true
        const working = yield* workingCounter(api, members, parentConversation)
        const reporter: ReporterInput = {
          name,
          task: member.task,
          sender: own,
          conversationId: Number(member.conversationId),
          message: input.message,
        }
        const refused = yield* api.commit((tx) =>
          Effect.gen(function* () {
            const registry = yield* tx.doc(AgentsDoc, parentConversation)
            if (registry.reporters[String(api.taskId)] !== undefined) return undefined
            const refused = idle ? refusedWork(limits, working(registry)) : undefined
            if (refused !== undefined) return refused
            registry.agents[name]!.assigned = true
            const created = yield* tx.createTask(Reporter, reporter, {
              ...background,
              conversationId: parentConversation,
            })
            registry.reporters[String(api.taskId)] = Number(created)
            return undefined
          }),
        )
        return refused === undefined ? ok("") : failed(refused)
      }),
  })

const waitAgent = defineTool({
  name: "wait_agent",
  description:
    "Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
  parameters: obj({
    timeout_ms: opt(
      int({
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_MS}, min ${MIN_WAIT_MS}, max ${MAX_WAIT_MS}.`,
      }),
    ),
  }),
  replay: "safe",
  execute: (input: { timeout_ms?: number }, api: ToolExecutionApi) =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = input.timeout_ms === undefined ? undefined : Math.max(0, input.timeout_ms)
        if (requested !== undefined && requested > MAX_WAIT_MS)
          return failed(`timeout_ms must be at most ${MAX_WAIT_MS} (asked for ${requested})`)
        const timeout = requested === undefined ? DEFAULT_WAIT_MS : Math.max(requested, MIN_WAIT_MS)
        const watch = yield* api.watchDoc(InboxDoc, api.conversationId)
        // A steered item reaches the model after this turn, so it is news: mail or input steered while the turn ran
        // ends the wait at once. A follow-up waits for the run to end, so it does not.
        const arrival = (items: ReadonlyArray<{ readonly mode: string; readonly entry?: unknown }>) => {
          const steered = items.filter((item) => item.mode === "steer")
          return steered.find((item) => isMail(item)) ?? steered[0]
        }
        const first = watch === undefined ? undefined : arrival(watch.value.items)
        const woken =
          first ??
          (watch === undefined
            ? undefined
            : Option.getOrUndefined(
                Option.flatten(
                  yield* watch.changes.pipe(
                    Stream.map((change) => arrival(change.value.items)),
                    Stream.filter((item) => item !== undefined),
                    Stream.runHead,
                    Effect.timeoutOption(Duration.millis(timeout)),
                  ),
                ),
              ))
        const mail = woken !== undefined && isMail(woken)
        const said =
          woken === undefined ? "Wait timed out." : mail ? "Wait completed." : "Wait interrupted by new input."
        const message =
          requested !== undefined && requested < timeout
            ? `${said}\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${timeout}ms.`
            : said
        return json({ message, timed_out: woken === undefined })
      }),
    ),
})

const isMail = (item: { readonly entry?: unknown }) =>
  (item.entry as { readonly kind?: string } | undefined)?.kind === MAIL_ENTRY_KIND

const listAgents = defineTool({
  name: "list_agents",
  description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
  parameters: obj({
    path_prefix: opt(
      str({ description: "Task-path prefix filter without a trailing slash. Omit to list all live agents." }),
    ),
  }),
  replay: "safe",
  execute: (input: { path_prefix?: string }, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const agents = []
      for (const member of yield* membersOf(api)) {
        if (!member.task.startsWith(input.path_prefix ?? "")) continue
        agents.push({ agent_name: member.task, agent_status: yield* statusOf(api, member) })
      }
      return json({ agents })
    }),
})

const interruptAgent = defineTool({
  name: "interrupt_agent",
  description:
    "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
  parameters: obj({
    target: str({ description: "Agent id or canonical task name to interrupt (from spawn_agent)." }),
  }),
  execute: (input: { target: string }, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const { own, member } = yield* resolveTarget(api, input.target)
      if (member === undefined) return failed(`no agent ${input.target.trim()}`)
      if (own === member.task || own.startsWith(`${member.task}/`))
        return failed("an agent can't interrupt itself or an agent above it")
      const previous = yield* statusOf(api, member)
      yield* (yield* api.conversation(member.conversationId))!.abort()
      return json({ previous_status: previous })
    }),
})

/**
 * Stops a conversation's runs and every subagent's under it, as `conversation/interrupt` promises. Each conversation of
 * the tree is aborted on its own, all at once, so the reporters that relay answers carry on as they do when one
 * subagent is stopped, and background work such as compaction is left alone. A subagent its parent started before the
 * parent stopped is found by the next pass.
 */
export const interruptTree = (harness: Harness, root: ConversationId) =>
  Effect.gen(function* () {
    const stopped = new Set<ConversationId>()
    for (;;) {
      const fresh = (yield* treeOf(harness, root)).filter((id) => !stopped.has(id))
      if (fresh.length === 0) return
      for (const id of fresh) stopped.add(id)
      yield* Effect.forEach(
        fresh,
        (id) => Effect.flatMap(harness.conversation(id), (conversation) => conversation?.abort() ?? Effect.void),
        { concurrency: "unbounded", discard: true },
      )
    }
  })

/** The conversation and its subagents', each parent before its subagents. */
const treeOf = (harness: Harness, root: ConversationId) =>
  Effect.gen(function* () {
    const tree = [root]
    for (let at = 0; at < tree.length; at++) {
      const registry = yield* harness.session.snapshot(AgentsDoc, tree[at]!)
      for (const child of Object.values(registry?.agents ?? {})) tree.push(idFromNumber(child.conversationId))
    }
    return tree
  })

/** The subagent tools, under `limits`; their tasks come with them, so a restart resumes pending reporters. */
export const agentTools = (limits: AgentLimits = DEFAULT_AGENT_LIMITS) =>
  defineExtension({
    name: "nisse-agents",
    tasks: [Anchor, Reporter],
    tools: [spawnAgent(limits), sendMessage, followupTask(limits), waitAgent, listAgents, interruptAgent],
  })
