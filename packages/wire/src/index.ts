// The wire clients speak to a server that runs the kernel (`NISSE_KERNEL=1`): JSON-RPC over the home's socket, one
// call per line. A client watches a conversation's view: the view through a window first, then the operations each
// commit applies to it. `bun run schema` prints it to `schema/nisse.kernel.schema.json`.
import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const KERNEL_PROTOCOL_VERSION = 1

export const ConversationId = Schema.String.annotate({
  description: "A conversation's id, as conversation/start gave it.",
})
export type ConversationId = typeof ConversationId.Type

export const Json = Schema.Unknown.annotate({ description: "Any JSON value." })

export const EntryRecord = Schema.Struct({
  id: Schema.Int,
  conversationId: Schema.Int,
  kind: Schema.String.annotate({
    description:
      "pi.user, pi.assistant and pi.tool-result carry model messages in `model`; nisse.run_end says how a run ended in `data`.",
  }),
  model: Schema.optionalKey(Schema.Array(Json)),
  data: Schema.optionalKey(Json),
  head: Schema.optionalKey(Schema.Int),
  edits: Schema.optionalKey(Schema.Array(Json)),
  byTaskId: Schema.optionalKey(Schema.Int),
}).annotate({ description: "One immutable transcript record." })
export type EntryRecord = typeof EntryRecord.Type

export const Outcome = Schema.Literals(["answered", "interrupted", "failed", "restart_limit"])
export type Outcome = typeof Outcome.Type

export const RUN_END_KIND = "nisse.run_end"

export const RunEnd = Schema.Struct({
  outcome: Outcome,
  message: Schema.optionalKey(Schema.String.annotate({ description: "Why the run ended without an answer." })),
  answer: Schema.optionalKey(
    Schema.Int.annotate({ description: "The pi.assistant entry that answered; absent when the run was cut after it." }),
  ),
}).annotate({ description: `The data of a ${RUN_END_KIND} entry, the last entry of every run.` })
export type RunEnd = typeof RunEnd.Type

export const View = Schema.Struct({
  conversation: Schema.Struct({
    id: Schema.Int,
    parent: Schema.optionalKey(
      Schema.Struct({ conversationId: Schema.Int, at: Schema.Int }).annotate({
        description: "The conversation this one was forked from, and the last entry it inherits.",
      }),
    ),
    owner: Schema.optionalKey(
      Schema.Struct({ conversationId: Schema.Int, taskId: Schema.Int }).annotate({
        description: "The task that created this conversation, and that task's conversation.",
      }),
    ),
  }),
  entries: Schema.Array(EntryRecord).annotate({ description: "A window over the transcript, oldest first." }),
  before: Schema.optionalKey(
    Schema.Int.annotate({
      description: "The entry just before the window; absent when the window starts the transcript.",
    }),
  ),
  docs: Schema.Record(Schema.String, Json).annotate({
    description: "pi.agent, pi.live, pi.inbox, pi.provider and pi.usage, by kind; pi.live holds the run in flight.",
  }),
})
export type View = typeof View.Type

export const Window = Schema.Struct({
  from: Schema.optionalKey(
    Schema.Int.annotate({ description: "Start the window at this entry, such as the one after the last you hold." }),
  ),
  min: Schema.optionalKey(Schema.Int.annotate({ description: "The newest entries the window holds at least; 50." })),
  max: Schema.optionalKey(
    Schema.Int.annotate({ description: "Past this many, the oldest leave the window down to min; twice min." }),
  ),
})
export type Window = typeof Window.Type

export const ViewStart = Schema.TaggedStruct("view", { view: View })
export const ViewChange = Schema.TaggedStruct("change", {
  ops: Schema.Array(Json).annotate({
    description:
      'The operations one commit applied to the view, in order: ["r", value] replaces it, ["s", path, value] sets, ["d", path] deletes, ["a", path, text] appends text, ["t", path, length] truncates text, ["p", path, at, deleteCount, items] splices an array, ["m", path, permutation] reorders one.',
  }),
})
export const ViewItem = Schema.Union([ViewStart, ViewChange])
export type ViewItem = typeof ViewItem.Type

export class NoSuchConversation extends Schema.TaggedError<NoSuchConversation>()("NoSuchConversation", {
  conversation: Schema.String,
}) {}

/** The window asked for is not one: `message` names the bound, its value and the rule. */
export class InvalidWindow extends Schema.TaggedError<InvalidWindow>()("InvalidWindow", {
  message: Schema.String,
}) {}

/** The client stopped reading; it watches again from the position it holds. */
export class FellBehind extends Schema.TaggedError<FellBehind>()("FellBehind", {
  limit: Schema.Int.annotate({
    description: "The changes a watch may hold unread before it is dropped; watch again from the position you hold.",
  }),
}) {}

export const Initialize = Rpc.make("initialize", {
  payload: { client: Schema.String, version: Schema.String, protocol: Schema.Int },
  success: Schema.Struct({ version: Schema.String, protocol: Schema.Int }),
})

export const StartConversation = Rpc.make("conversation/start", {
  payload: { cwd: Schema.String.annotate({ description: "The directory the conversation works in." }) },
  success: Schema.Struct({ conversation: ConversationId }),
})

export const Submit = Rpc.make("conversation/submit", {
  payload: {
    conversation: ConversationId,
    requestId: Schema.String.annotate({ description: "Submitting again with the same id is answered once." }),
    text: Schema.String,
  },
  success: Schema.Struct({ submission: Schema.Int }),
  error: NoSuchConversation,
})

export const Watch = Rpc.make("conversation/watch", {
  payload: { conversation: ConversationId, window: Schema.optionalKey(Window) },
  success: ViewItem.annotate({ description: "The view through the window, then each commit's changes to it." }),
  error: Schema.Union([NoSuchConversation, InvalidWindow, FellBehind]),
  stream: true,
})

export const Interrupt = Rpc.make("conversation/interrupt", {
  payload: { conversation: ConversationId.annotate({ description: "Stops its run; what was said stays." }) },
  error: NoSuchConversation,
})

export const StopServer = Rpc.make("server/stop")

export const KernelRpcs = RpcGroup.make(Initialize, StartConversation, Submit, Watch, Interrupt, StopServer)
