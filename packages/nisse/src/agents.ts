import type {
  CallId,
  Conversation,
  ConversationId,
  Entry,
  Mail,
  MailKind,
  ModelInfo,
  ModelSelection,
} from "@nisse/protocol"
import { Effect, Schema } from "effect"
import type { ConversationState } from "./store.ts"
import { failed, ok, tool, type Tool } from "./tools/tool.ts"
import type { AgentType } from "./workspace.ts"

export const ROOT_TASK = "/root"
const DEFAULT_WAIT_MS = 30_000
const MIN_WAIT_MS = 10_000
const MAX_WAIT_MS = 3_600_000

export interface AgentLimits {
  readonly maxDepth: number
  readonly maxThreads: number
}

export const defaultLimits: AgentLimits = { maxDepth: 1, maxThreads: 6 }

export interface Child {
  readonly call: CallId
  readonly task: string
  readonly title: string
  readonly agentType?: string
  readonly model: ModelSelection
  readonly forkedAt?: number
}

export type Woken = "mail" | "input" | "timeout"

export interface AgentContext {
  readonly caller: Conversation
  readonly limits: AgentLimits
  readonly types: ReadonlyArray<AgentType>
  readonly models: Effect.Effect<ReadonlyArray<ModelInfo>>
  readonly family: () => ReadonlyArray<ConversationState>
  readonly hasWork: (conversation: ConversationId) => boolean
  readonly transcript: (conversation: ConversationId) => ReadonlyArray<Entry>
  readonly spawn: (child: Child, message: string) => Effect.Effect<string | undefined>
  readonly deliver: (to: ConversationId, text: string, mail: Mail) => Effect.Effect<string | undefined>
  readonly interrupt: (conversation: ConversationId) => Effect.Effect<void>
  readonly nextInput: (timeoutMs: number) => Effect.Effect<Woken>
}

export const taskOf = (conversation: Conversation) => conversation.lineage?.task ?? ROOT_TASK

const depthOf = (task: string) => task.split("/").length - 2

export const errored = (message: string) =>
  `Agent errored: ${message}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`

export const mailText = (mail: Mail, text: string) => {
  const kind = ({ new_task: "NEW_TASK", message: "MESSAGE", final_answer: "FINAL_ANSWER" } as const)[mail.kind]
  return `Message Type: ${kind}\nTask name: ${mail.task}\nSender: ${mail.sender}\nPayload:\n${text}`
}

const json = (value: unknown) => ok(JSON.stringify(value))

const statusOf = (context: AgentContext, member: ConversationState): unknown => {
  if (member.status !== "idle" || context.hasWork(member.conversation.id)) return "running"
  const transcript = context.transcript(member.conversation.id)
  const end = transcript.findLastIndex((entry) => entry.body._tag === "run_end")
  const body = transcript[end]?.body
  if (body?._tag !== "run_end") return "pending_init"
  if (body.outcome === "interrupted") return "interrupted"
  if (body.outcome !== "answered") return { errored: body.message ?? body.outcome }
  const said = transcript.slice(0, end).findLast((entry) => entry.body._tag === "message")?.body
  return { completed: said?._tag === "message" ? said.text : "" }
}

const targetOf = (family: ReadonlyArray<ConversationState>, from: Conversation, name: string) => {
  const trimmed = name.trim()
  const task = trimmed.startsWith("/") ? trimmed : `${taskOf(from)}/${trimmed}`
  return family.find(
    (member) => taskOf(member.conversation) === task || member.conversation.id === (trimmed as ConversationId),
  )
}

const launchedAt = (transcript: ReadonlyArray<Entry>, launcher: CallId) =>
  transcript.find((entry) => entry.body._tag === "tool_call" && entry.body.call === launcher)?.seq

const spawnDescription = `Spawns an agent to work on the specified task. If your current task is \`/root/task1\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`/root/task1/task_3\`.
You are then able to refer to this agent as \`task_3\` or \`/root/task1/task_3\` interchangeably. However an agent \`/root/task2/task_3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task_3\`.
The spawned agent will have the same tools as you.
Spawned agents inherit your current model by default. Do not set the \`model\` field unless the user explicitly asks for a different model.
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.

Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.

Note that passing \`fork_turns="none"\` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas \`fork_turns="all"\` will provide the subagent with all surrounding context.`

const agentTypeDescription = (types: ReadonlyArray<AgentType>) =>
  [
    "Agent type override for the new agent. Omit unless explicitly asked. The selected role applies regardless of how much parent history is inherited.",
    ...(types.length === 0
      ? []
      : ["Available agent types:", ...types.map((type) => `- ${type.name}: ${type.description}`)]),
  ].join("\n")

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description } as never)

const spawnAgent = (context: AgentContext) =>
  tool({
    name: "spawn_agent",
    description: spawnDescription,
    readOnly: true,
    input: Schema.Struct({
      task_name: described(
        Schema.String,
        "Task name for the new agent. Use lowercase letters, digits, and underscores.",
      ),
      message: described(Schema.String, "Initial plain-text task for the new agent."),
      agent_type: Schema.optionalKey(described(Schema.String, agentTypeDescription(context.types))),
      fork_turns: Schema.optionalKey(
        described(
          Schema.String,
          "Parent history to inherit. Defaults to `all`; use `none` to start without parent history. Only `all` and `none` are supported.",
        ),
      ),
      model: Schema.optionalKey(
        described(Schema.String, "Model override for the new agent. Omit unless an explicit override is needed."),
      ),
      reasoning_effort: Schema.optionalKey(
        described(Schema.String, "Reasoning effort override for the new agent. Omit to inherit the parent effort."),
      ),
    }),
    run: (input, { call, parent }) =>
      Effect.gen(function* () {
        if (input.message.trim() === "") return failed("Empty message can't be sent to an agent")
        const name = input.task_name.trim()
        if (!/^[a-z0-9_]+$/.test(name)) return failed("task_name takes lowercase letters, digits and underscores")
        const fork = (input.fork_turns ?? "all").trim().toLowerCase()
        if (!["", "all", "none"].includes(fork) && !/^\d+$/.test(fork)) {
          return failed("fork_turns must be `none` or `all`")
        }
        const caller = context.caller
        if (depthOf(taskOf(caller)) >= context.limits.maxDepth) {
          return failed(`agents may nest ${context.limits.maxDepth} deep; this one can't start another`)
        }
        const task = `${taskOf(caller)}/${name}`
        const wanted = input.agent_type?.trim()
        const agentType = wanted ? context.types.find((type) => type.name === wanted) : undefined
        if (wanted && !agentType) {
          const known = context.types.map((type) => type.name)
          return failed(`no agent type ${wanted}; there are ${known.length === 0 ? "none" : known.join(", ")}`)
        }
        const catalog = yield* context.models
        const listed = (model: string | undefined) => model !== undefined && catalog.some((known) => known.id === model)
        if (input.model !== undefined && !listed(input.model)) {
          return failed(`no model ${input.model} on ${caller.model.provider}; leave model out to use yours`)
        }
        const model = input.model ?? (listed(agentType?.model) ? agentType!.model : undefined) ?? caller.model.model
        const effort = input.reasoning_effort ?? (model === caller.model.model ? caller.model.effort : undefined)
        const forkedAt = fork === "none" ? undefined : launchedAt(context.transcript(caller.id), parent ?? call)
        const refused = yield* context.spawn(
          {
            call,
            task,
            title: name,
            ...(agentType ? { agentType: agentType.name } : {}),
            model: {
              provider: caller.model.provider,
              ...(model === undefined ? {} : { model }),
              ...(effort === undefined ? {} : { effort }),
            },
            ...(forkedAt === undefined ? {} : { forkedAt }),
          },
          input.message,
        )
        return refused === undefined ? json({ task_name: task, nickname: null }) : failed(refused)
      }),
  })

const sendTo = (context: AgentContext, target: string, message: string, kind: MailKind) =>
  Effect.gen(function* () {
    if (message.trim() === "") return failed("Empty message can't be sent to an agent")
    const to = targetOf(context.family(), context.caller, target)
    if (!to) return failed(`no agent ${target.trim()}`)
    if (kind === "new_task" && to.conversation.lineage === undefined) {
      return failed("followup_task takes a subagent; send_message reaches the root")
    }
    const refused = yield* context.deliver(to.conversation.id, message, {
      kind,
      task: taskOf(to.conversation),
      sender: taskOf(context.caller),
    })
    return refused === undefined ? ok("") : failed(refused)
  })

const MessageInput = (target: string, message: string) =>
  Schema.Struct({ target: described(Schema.String, target), message: described(Schema.String, message) })

const sendMessage = (context: AgentContext) =>
  tool({
    name: "send_message",
    description:
      "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
    readOnly: true,
    input: MessageInput(
      "Relative or canonical task name to message (from spawn_agent).",
      "Message text to queue on the target agent.",
    ),
    run: (input) => sendTo(context, input.target, input.message, "message"),
  })

const followupTask = (context: AgentContext) =>
  tool({
    name: "followup_task",
    description:
      "Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
    readOnly: true,
    input: MessageInput(
      "Agent id or canonical task name to send a follow-up task to (from spawn_agent).",
      "Message text to send to the target agent.",
    ),
    run: (input) => sendTo(context, input.target, input.message, "new_task"),
  })

const waitAgent = (context: AgentContext) =>
  tool({
    name: "wait_agent",
    description:
      "Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
    readOnly: true,
    input: Schema.Struct({
      timeout_ms: Schema.optionalKey(
        described(
          Schema.Number,
          `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_MS}, min ${MIN_WAIT_MS}, max ${MAX_WAIT_MS}.`,
        ),
      ),
    }),
    run: (input) =>
      Effect.gen(function* () {
        const requested = input.timeout_ms === undefined ? undefined : Math.max(0, Math.floor(input.timeout_ms))
        if (requested !== undefined && requested > MAX_WAIT_MS)
          return failed(`timeout_ms must be at most ${MAX_WAIT_MS}`)
        const timeout = requested === undefined ? DEFAULT_WAIT_MS : Math.max(requested, MIN_WAIT_MS)
        const woken = yield* context.nextInput(timeout)
        const said = { mail: "Wait completed.", input: "Wait interrupted by new input.", timeout: "Wait timed out." }[
          woken
        ]
        const message =
          requested !== undefined && requested < timeout
            ? `${said}\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${timeout}ms.`
            : said
        return json({ message, timed_out: woken === "timeout" })
      }),
  })

const listAgents = (context: AgentContext) =>
  tool({
    name: "list_agents",
    description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
    readOnly: true,
    input: Schema.Struct({
      path_prefix: Schema.optionalKey(
        described(Schema.String, "Task-path prefix filter without a trailing slash. Omit to list all live agents."),
      ),
    }),
    run: (input) =>
      Effect.sync(() =>
        json({
          agents: context
            .family()
            .filter((member) => taskOf(member.conversation).startsWith(input.path_prefix ?? ""))
            .map((member) => ({ agent_name: taskOf(member.conversation), agent_status: statusOf(context, member) })),
        }),
      ),
  })

const interruptAgent = (context: AgentContext) =>
  tool({
    name: "interrupt_agent",
    description:
      "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
    readOnly: true,
    input: Schema.Struct({
      target: described(Schema.String, "Agent id or canonical task name to interrupt (from spawn_agent)."),
    }),
    run: (input) =>
      Effect.gen(function* () {
        const target = targetOf(context.family(), context.caller, input.target)
        if (!target) return failed(`no agent ${input.target.trim()}`)
        const task = taskOf(target.conversation)
        const own = taskOf(context.caller)
        if (own === task || own.startsWith(`${task}/`)) {
          return failed("an agent can't interrupt itself or an agent above it")
        }
        const previous = statusOf(context, target)
        yield* context.interrupt(target.conversation.id)
        return json({ previous_status: previous })
      }),
  })

export const agentTools = (context: AgentContext): ReadonlyArray<Tool> => [
  ...(depthOf(taskOf(context.caller)) < context.limits.maxDepth ? [spawnAgent(context)] : []),
  sendMessage(context),
  followupTask(context),
  waitAgent(context),
  listAgents(context),
  interruptAgent(context),
]
