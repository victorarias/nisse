import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const PROTOCOL_VERSION = 5

export const ConversationId = Schema.String.pipe(Schema.brand("ConversationId"))
export type ConversationId = typeof ConversationId.Type

export const EntryId = Schema.String.pipe(Schema.brand("EntryId"))
export type EntryId = typeof EntryId.Type

export const SubmissionId = Schema.String.pipe(Schema.brand("SubmissionId"))
export type SubmissionId = typeof SubmissionId.Type

export const Person = Schema.TaggedStruct("person", { name: Schema.String })
export const Nisse = Schema.TaggedStruct("nisse", {})
export const AgentAuthor = Schema.TaggedStruct("agent", { conversation: ConversationId }).annotate({
  description: "The model of another conversation in the same tree, such as a subagent's parent.",
})
export const Author = Schema.Union([Person, Nisse, AgentAuthor])
export type Author = typeof Author.Type

export const CallId = Schema.String.pipe(Schema.brand("CallId"))
export type CallId = typeof CallId.Type

export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type

export const Skill = Schema.Struct({ name: Schema.String, description: Schema.String, path: Schema.String })
export type Skill = typeof Skill.Type

export const AttachedSkill = Schema.Struct({ name: Schema.String, path: Schema.String, text: Schema.String }).annotate({
  description: "A skill's SKILL.md as it was when the input named it.",
})
export type AttachedSkill = typeof AttachedSkill.Type

export const MailKind = Schema.Literals(["new_task", "message", "final_answer"]).annotate({
  description:
    "new_task: work to do, which starts a run when the recipient has none. message: taken in at the recipient's next step, without starting a run. final_answer: a subagent's last message of a run, for its parent.",
})
export type MailKind = typeof MailKind.Type

export const Mail = Schema.Struct({
  kind: MailKind,
  task: Schema.String.annotate({ description: "The recipient's task name, such as /root/explore." }),
  sender: Schema.String.annotate({ description: "The sender's task name." }),
}).annotate({ description: "What one agent sent another." })
export type Mail = typeof Mail.Type

export const UserText = Schema.TaggedStruct("user", {
  submission: SubmissionId,
  text: Schema.String,
  skills: Schema.optionalKey(Schema.Array(AttachedSkill)),
  mail: Schema.optionalKey(Mail),
})
export const Message = Schema.TaggedStruct("message", { text: Schema.String })
export const ToolCall = Schema.TaggedStruct("tool_call", {
  call: CallId,
  tool: Schema.String,
  input: Schema.Unknown,
  parent: Schema.optionalKey(
    CallId.annotate({ description: "The call that made this one, such as the script that ran it in code mode." }),
  ),
})
export const ToolResult = Schema.TaggedStruct("tool_result", {
  call: CallId,
  output: Schema.String,
  error: Schema.Boolean,
})
export const ApprovalRequest = Schema.TaggedStruct("approval", {
  approval: ApprovalId,
  call: CallId,
  tool: Schema.String,
  input: Schema.Unknown,
})
export const ModelSelection = Schema.Struct({
  provider: Schema.String,
  model: Schema.optionalKey(
    Schema.String.annotate({ description: "Absent for the provider's own choice, as Claude Code makes it." }),
  ),
  effort: Schema.optionalKey(Schema.String.annotate({ description: "Absent for the model's own default." })),
})
export type ModelSelection = typeof ModelSelection.Type

export const ModelSwitch = Schema.TaggedStruct("model", { selection: ModelSelection }).annotate({
  description: "Someone switched the conversation's model; it answers with it from the next run on.",
})
export const Subagent = Schema.TaggedStruct("subagent", {
  call: CallId,
  conversation: ConversationId,
  title: Schema.String,
  agentType: Schema.optionalKey(Schema.String),
}).annotate({ description: "The call started a subagent, which works in a conversation of its own." })
export const ApprovalAnswer = Schema.TaggedStruct("approval_answer", { approval: ApprovalId, allow: Schema.Boolean })
export const Outcome = Schema.Literals(["answered", "interrupted", "failed", "restart_limit"])
export type Outcome = typeof Outcome.Type
export const RunEnd = Schema.TaggedStruct("run_end", { outcome: Outcome, message: Schema.optionalKey(Schema.String) })
export const EntryBody = Schema.Union([
  UserText,
  Message,
  ToolCall,
  ToolResult,
  ApprovalRequest,
  ApprovalAnswer,
  RunEnd,
  ModelSwitch,
  Subagent,
])
export type EntryBody = typeof EntryBody.Type

export const Entry = Schema.Struct({
  id: EntryId,
  seq: Schema.Int,
  at: Schema.Int,
  author: Author,
  body: EntryBody,
})
export type Entry = typeof Entry.Type

export const Approvals = Schema.Literals(["ask", "auto"])
export type Approvals = typeof Approvals.Type

export const Lineage = Schema.Struct({
  parent: ConversationId,
  root: ConversationId.annotate({ description: "The conversation people started, at the top of the tree." }),
  call: CallId.annotate({ description: "The parent's call that started it." }),
  task: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Its task name, such as /root/explore, which agents address it by. Absent when its parent's provider runs it, as Claude Code runs its own subagents: then it takes input only through its parent, and stops when its parent's run does.",
    }),
  ),
  title: Schema.String,
  agentType: Schema.optionalKey(Schema.String),
  forkedAt: Schema.optionalKey(
    Schema.Int.annotate({ description: "It starts from its parent's transcript before this seq." }),
  ),
}).annotate({ description: "Where a subagent comes from. It runs on its parent's provider, in its directory." })
export type Lineage = typeof Lineage.Type

export const Conversation = Schema.Struct({
  id: ConversationId,
  cwd: Schema.String,
  createdAt: Schema.Int,
  model: ModelSelection,
  approvals: Approvals,
  lineage: Schema.optionalKey(Lineage),
})
export type Conversation = typeof Conversation.Type

export const Status = Schema.Literals(["idle", "working", "waiting"])
export type Status = typeof Status.Type

export const Queued = Schema.Struct({
  submission: SubmissionId,
  author: Author,
  text: Schema.String,
  steer: Schema.Boolean,
  mail: Schema.optionalKey(Mail),
})
export type Queued = typeof Queued.Type

export const Live = Schema.Struct({ text: Schema.String, output: Schema.Record(Schema.String, Schema.String) })
export type Live = typeof Live.Type

export const LiveText = Schema.TaggedStruct("text", { append: Schema.String })
export const LiveTextEnd = Schema.TaggedStruct("text_end", {})
export const LIVE_OUTPUT_TAIL = 4096

export const LiveOutput = Schema.TaggedStruct("output", { call: CallId, append: Schema.String }).annotate({
  description: `Output appended to a running call. Live output keeps only the last ${LIVE_OUTPUT_TAIL} characters of each call; the tool_result holds what the call returned.`,
})
export const LiveOutputEnd = Schema.TaggedStruct("output_end", { call: CallId })
export const LiveClear = Schema.TaggedStruct("clear", {})
export const LiveChange = Schema.Union([LiveText, LiveTextEnd, LiveOutput, LiveOutputEnd, LiveClear])
export type LiveChange = typeof LiveChange.Type

export const Snapshot = Schema.TaggedStruct("snapshot", {
  conversation: Conversation,
  seq: Schema.Int,
  entries: Schema.Array(Entry),
  live: Live,
  queued: Schema.Array(Queued),
  status: Status,
})
export type Snapshot = typeof Snapshot.Type

export const Commit = Schema.TaggedStruct("commit", {
  seq: Schema.Int,
  at: Schema.Int,
  conversation: ConversationId,
  entries: Schema.Array(Entry),
  live: Schema.optionalKey(Schema.Array(LiveChange)),
  enqueued: Schema.optionalKey(Queued),
  status: Schema.optionalKey(Status),
})
export type Commit = typeof Commit.Type

export const Delivery = Schema.Union([Snapshot, Commit])
export type Delivery = typeof Delivery.Type

export const RunEnded = Schema.Struct({
  outcome: Outcome,
  message: Schema.optionalKey(Schema.String.annotate({ description: "The run_end's message, such as why it failed." })),
  said: Schema.optionalKey(
    Schema.String.annotate({ description: "The last message the model wrote in the conversation." }),
  ),
})
export type RunEnded = typeof RunEnded.Type

export const TreeStatus = Schema.TaggedStruct("tree", {
  conversation: ConversationId.annotate({
    description: "A conversation people started; its tree is it and its subagents.",
  }),
  seq: Schema.Int,
  status: Status.annotate({
    description: "waiting when a conversation in the tree waits on a person, working when one runs, idle otherwise.",
  }),
  ended: Schema.optionalKey(RunEnded.annotate({ description: "The run of the conversation itself ended at seq." })),
})
export type TreeStatus = typeof TreeStatus.Type

export const TreeSnapshot = Schema.TaggedStruct("trees", {
  seq: Schema.Int,
  trees: Schema.Array(TreeStatus).annotate({ description: "Every tree that is not idle; the rest are idle." }),
})
export type TreeSnapshot = typeof TreeSnapshot.Type

export const TreeDelivery = Schema.Union([TreeSnapshot, TreeStatus])
export type TreeDelivery = typeof TreeDelivery.Type

export class NoSuchConversation extends Schema.TaggedError<NoSuchConversation>()("NoSuchConversation", {
  conversation: Schema.String,
}) {}

export class NoSuchApproval extends Schema.TaggedError<NoSuchApproval>()("NoSuchApproval", {
  approval: Schema.String,
}) {}

export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  provider: Schema.String,
}) {}

export class CannotSignIn extends Schema.TaggedError<CannotSignIn>()("CannotSignIn", {
  provider: Schema.String,
  message: Schema.String,
}) {}

export class TakesNoInput extends Schema.TaggedError<TakesNoInput>()("TakesNoInput", {
  conversation: Schema.String,
}) {}

export class FellBehind extends Schema.TaggedError<FellBehind>()("FellBehind", {
  seq: Schema.Int,
}) {}

export const Initialize = Rpc.make("initialize", {
  payload: { client: Schema.String, version: Schema.String, protocol: Schema.Int },
  success: Schema.Struct({ version: Schema.String, protocol: Schema.Int }),
})

export const StartConversation = Rpc.make("conversation/start", {
  payload: {
    id: Schema.optionalKey(
      ConversationId.annotate({
        description: "Start it with this id. When a conversation has it already, that conversation is the answer.",
      }),
    ),
    cwd: Schema.String,
    provider: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    approvals: Schema.optionalKey(Approvals),
  },
  success: Conversation,
  error: UnknownProvider,
})

export const ListConversations = Rpc.make("conversation/list", {
  success: Schema.Array(Conversation),
})

export const Subscribe = Rpc.make("conversation/subscribe", {
  payload: { conversation: ConversationId, sinceSeq: Schema.optionalKey(Schema.Int) },
  success: Delivery,
  error: Schema.Union([NoSuchConversation, FellBehind]),
  stream: true,
})

export const Submit = Rpc.make("conversation/submit", {
  payload: {
    conversation: ConversationId,
    requestId: Schema.String,
    author: Schema.String,
    text: Schema.String,
    steer: Schema.optionalKey(Schema.Boolean),
  },
  success: Schema.Struct({ submission: SubmissionId }),
  error: Schema.Union([NoSuchConversation, TakesNoInput]),
})

export const Interrupt = Rpc.make("conversation/interrupt", {
  payload: {
    conversation: ConversationId.annotate({ description: "Stops its run and the runs of every subagent under it." }),
  },
  error: NoSuchConversation,
})

export const ResolveApproval = Rpc.make("approval/resolve", {
  payload: { conversation: ConversationId, approval: ApprovalId, author: Schema.String, allow: Schema.Boolean },
  success: Schema.Struct({ accepted: Schema.Boolean }),
  error: Schema.Union([NoSuchConversation, NoSuchApproval]),
})

export const SelectModel = Rpc.make("conversation/select_model", {
  payload: { conversation: ConversationId, author: Schema.String, selection: ModelSelection },
  error: Schema.Union([NoSuchConversation, UnknownProvider, TakesNoInput]),
})

export const WatchStatus = Rpc.make("status/watch", {
  success: TreeDelivery.annotate({
    description: "The status of every tree, then each commit that changes one or ends the run of its root.",
  }),
  error: FellBehind,
  stream: true,
})

export const StopServer = Rpc.make("server/stop")

export const ListSkills = Rpc.make("skills/list", {
  payload: { conversation: ConversationId },
  success: Schema.Array(Skill).annotate({
    description:
      "The skills input to this conversation can name with /name or $name. Empty when its provider expands skills itself.",
  }),
  error: NoSuchConversation,
})

export const AuthMethod = Schema.Literals(["browser", "device_code", "terminal"]).annotate({
  description:
    "browser: a browser on the server's machine signs in and calls back to it. device_code: any device signs in with a short code. terminal: the provider's own sign-in command runs in a terminal on the server's machine.",
})
export type AuthMethod = typeof AuthMethod.Type

export const ProviderStatus = Schema.Literals(["ready", "signed_out", "unavailable"])
export type ProviderStatus = typeof ProviderStatus.Type

export const ProviderHealth = Schema.Struct({
  status: ProviderStatus,
  version: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(Schema.String.annotate({ description: "Who it is signed in as, and on what plan." })),
  message: Schema.optionalKey(Schema.String.annotate({ description: "Why it is not ready, or what to do about it." })),
  checkedAt: Schema.Int,
})
export type ProviderHealth = typeof ProviderHealth.Type

export const ProviderSnapshot = Schema.Struct({
  id: Schema.String,
  driver: Schema.String,
  signIn: Schema.Array(AuthMethod).annotate({ description: "The ways to sign in, the first one preferred." }),
  health: ProviderHealth,
})
export type ProviderSnapshot = typeof ProviderSnapshot.Type

export const ModelInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  efforts: Schema.Array(Schema.String).annotate({ description: "The reasoning efforts it takes, least first." }),
  defaultEffort: Schema.optionalKey(Schema.String),
  contextWindow: Schema.optionalKey(Schema.Int),
})
export type ModelInfo = typeof ModelInfo.Type

export const ProviderModels = Schema.Struct({
  provider: Schema.String,
  defaultModel: Schema.optionalKey(
    Schema.String.annotate({ description: "What a selection naming no model gets; absent when the provider picks." }),
  ),
  models: Schema.Array(ModelInfo).annotate({ description: "Best first." }),
})
export type ProviderModels = typeof ProviderModels.Type

export const AuthPhase = Schema.Literals([
  "starting",
  "waiting",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "signed_out",
])
export type AuthPhase = typeof AuthPhase.Type

export const authEnded = (phase: AuthPhase) => phase !== "starting" && phase !== "waiting" && phase !== "verifying"

export const BrowserInteraction = Schema.TaggedStruct("browser", { url: Schema.String }).annotate({
  description:
    "Open url and sign in. A browser on another machine can't call back: answer with the address it ends on.",
})
export const DeviceCodeInteraction = Schema.TaggedStruct("device_code", { url: Schema.String, code: Schema.String })
export const TerminalInteraction = Schema.TaggedStruct("terminal", {
  command: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
}).annotate({ description: "Run command with env in a terminal on the server's machine, then answer terminal_exited." })
export const AuthInteraction = Schema.Union([BrowserInteraction, DeviceCodeInteraction, TerminalInteraction])
export type AuthInteraction = typeof AuthInteraction.Type

export const AuthState = Schema.Struct({
  provider: Schema.String,
  flow: Schema.String,
  phase: AuthPhase,
  interaction: Schema.optionalKey(AuthInteraction.annotate({ description: "What a person must do while it waits." })),
  message: Schema.optionalKey(Schema.String.annotate({ description: "Who it signed in as, or why it failed." })),
}).annotate({
  description: "One sign-in, or a sign-out, as every connection sees it. A provider has at most one sign-in at a time.",
})
export type AuthState = typeof AuthState.Type

export const CallbackResponse = Schema.TaggedStruct("callback", { url: Schema.String })
export const TerminalExited = Schema.TaggedStruct("terminal_exited", { success: Schema.Boolean })
export const AuthResponse = Schema.Union([CallbackResponse, TerminalExited])
export type AuthResponse = typeof AuthResponse.Type

export const ListProviders = Rpc.make("providers/list", {
  payload: { refresh: Schema.optionalKey(Schema.Boolean) },
  success: Schema.Array(ProviderSnapshot),
})

export const ListModels = Rpc.make("models/list", {
  payload: { refresh: Schema.optionalKey(Schema.Boolean) },
  success: Schema.Array(ProviderModels),
})

export const StartAuth = Rpc.make("auth/start", {
  payload: { provider: Schema.String, method: Schema.optionalKey(AuthMethod) },
  success: AuthState,
  error: Schema.Union([UnknownProvider, CannotSignIn]),
})

export const RespondAuth = Rpc.make("auth/respond", {
  payload: { provider: Schema.String, flow: Schema.String, response: AuthResponse },
  success: Schema.Struct({ accepted: Schema.Boolean }),
})

export const CancelAuth = Rpc.make("auth/cancel", {
  payload: { provider: Schema.String, flow: Schema.String },
  success: Schema.Struct({ accepted: Schema.Boolean }),
})

export const Logout = Rpc.make("auth/logout", {
  payload: { provider: Schema.String },
  success: ProviderSnapshot,
  error: Schema.Union([UnknownProvider, CannotSignIn]),
})

export const WatchAuth = Rpc.make("auth/watch", {
  success: AuthState,
  stream: true,
})

export const NisseRpcs = RpcGroup.make(
  Initialize,
  StartConversation,
  ListConversations,
  Subscribe,
  Submit,
  Interrupt,
  ResolveApproval,
  SelectModel,
  WatchStatus,
  StopServer,
  ListSkills,
  ListProviders,
  ListModels,
  StartAuth,
  RespondAuth,
  CancelAuth,
  Logout,
  WatchAuth,
)
