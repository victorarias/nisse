import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const PROTOCOL_VERSION = 2

export const ConversationId = Schema.String.pipe(Schema.brand("ConversationId"))
export type ConversationId = typeof ConversationId.Type

export const EntryId = Schema.String.pipe(Schema.brand("EntryId"))
export type EntryId = typeof EntryId.Type

export const SubmissionId = Schema.String.pipe(Schema.brand("SubmissionId"))
export type SubmissionId = typeof SubmissionId.Type

export const Person = Schema.TaggedStruct("person", { name: Schema.String })
export const Nisse = Schema.TaggedStruct("nisse", {})
export const Author = Schema.Union([Person, Nisse])
export type Author = typeof Author.Type

export const CallId = Schema.String.pipe(Schema.brand("CallId"))
export type CallId = typeof CallId.Type

export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type

export const UserText = Schema.TaggedStruct("user", { submission: SubmissionId, text: Schema.String })
export const Message = Schema.TaggedStruct("message", { text: Schema.String })
export const ToolCall = Schema.TaggedStruct("tool_call", { call: CallId, tool: Schema.String, input: Schema.Unknown })
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

export const Conversation = Schema.Struct({
  id: ConversationId,
  cwd: Schema.String,
  createdAt: Schema.Int,
  provider: Schema.String,
  approvals: Approvals,
})
export type Conversation = typeof Conversation.Type

export const Status = Schema.Literals(["idle", "working", "waiting"])
export type Status = typeof Status.Type

export const Queued = Schema.Struct({
  submission: SubmissionId,
  author: Author,
  text: Schema.String,
  steer: Schema.Boolean,
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

export class NoSuchConversation extends Schema.TaggedError<NoSuchConversation>()("NoSuchConversation", {
  conversation: Schema.String,
}) {}

export class NoSuchApproval extends Schema.TaggedError<NoSuchApproval>()("NoSuchApproval", {
  approval: Schema.String,
}) {}

export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  provider: Schema.String,
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
    cwd: Schema.String,
    provider: Schema.optionalKey(Schema.String),
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
  error: NoSuchConversation,
})

export const Interrupt = Rpc.make("conversation/interrupt", {
  payload: { conversation: ConversationId },
  error: NoSuchConversation,
})

export const ResolveApproval = Rpc.make("approval/resolve", {
  payload: { conversation: ConversationId, approval: ApprovalId, author: Schema.String, allow: Schema.Boolean },
  success: Schema.Struct({ accepted: Schema.Boolean }),
  error: Schema.Union([NoSuchConversation, NoSuchApproval]),
})

export const StopServer = Rpc.make("server/stop")

export const NisseRpcs = RpcGroup.make(
  Initialize,
  StartConversation,
  ListConversations,
  Subscribe,
  Submit,
  Interrupt,
  ResolveApproval,
  StopServer,
)
