// The wire clients speak to a server that runs the kernel (`NISSE_KERNEL=1`): JSON-RPC over the home's socket, one
// call per line. A client watches a conversation's view: the view through a window first, then the operations each
// commit applies to it. `bun run schema` prints it to `schema/nisse.kernel.schema.json`.
import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const KERNEL_PROTOCOL_VERSION = 1

export const ConversationId = Schema.String.annotate({
  description: "A conversation's id: the one its client chose at conversation/start, or else the number it gave.",
})
export type ConversationId = typeof ConversationId.Type

export const Json = Schema.Unknown.annotate({ description: "Any JSON value." })

export const EntryRecord = Schema.Struct({
  id: Schema.Int,
  conversationId: Schema.Int,
  kind: Schema.String.annotate({
    description:
      "pi.user, pi.assistant and pi.tool-result carry model messages in `model`; nisse.run_end says how a run ended in `data`, nisse.approval who answered a call.",
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
    description:
      "pi.agent, pi.live, pi.inbox, pi.provider, pi.usage and nisse.approvals, by kind; pi.live holds the run in flight, nisse.approvals the calls waiting for a person.",
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

export class NoSuchApproval extends Schema.TaggedError<NoSuchApproval>()("NoSuchApproval", {
  approval: Schema.String,
}) {}

/** The id a client chose cannot name a conversation: `message` says why. */
export class InvalidConversationId extends Schema.TaggedError<InvalidConversationId>()("InvalidConversationId", {
  message: Schema.String,
}) {}

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

export const Approvals = Schema.Literals(["ask", "auto"]).annotate({
  description: "`ask`: calls that change things wait for approval/resolve; `auto`: every call runs without asking.",
})

export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  provider: Schema.String,
}) {}

export class CannotSignIn extends Schema.TaggedError<CannotSignIn>()("CannotSignIn", {
  provider: Schema.String,
  message: Schema.String,
}) {}

/** The effort is not a reasoning effort nisse knows; `efforts` lists those it does. */
export class UnknownEffort extends Schema.TaggedError<UnknownEffort>()("UnknownEffort", {
  effort: Schema.String,
  efforts: Schema.Array(Schema.String),
}) {}

export const ModelSelection = Schema.Struct({
  provider: Schema.String,
  model: Schema.optionalKey(
    Schema.String.annotate({ description: "Absent for the provider's own choice, as Claude Code makes it." }),
  ),
  effort: Schema.optionalKey(Schema.String.annotate({ description: "Absent for the model's own default." })),
})
export type ModelSelection = typeof ModelSelection.Type

export const StartConversation = Rpc.make("conversation/start", {
  payload: {
    cwd: Schema.String.annotate({ description: "The directory the conversation works in." }),
    id: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "The id to name it by, chosen by the client; not all digits. Starting again with an id that names a conversation answers with that one and changes nothing.",
      }),
    ),
    approvals: Schema.optionalKey(Approvals.annotate({ description: "Default ask." })),
    provider: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Absent for the default: the project's default_model, the home's, the model chosen last, else the preferred provider.",
      }),
    ),
    model: Schema.optionalKey(
      Schema.String.annotate({ description: "Without a provider, it goes to the default model's provider." }),
    ),
    effort: Schema.optionalKey(Schema.String),
  },
  success: Schema.Struct({
    conversation: ConversationId,
    model: ModelSelection.annotate({
      description:
        "The model it runs, defaults applied, with the provider's default model when none was named; for an id that names one, that conversation's.",
    }),
  }),
  error: Schema.Union([InvalidConversationId, UnknownProvider, UnknownEffort]),
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

export const ResolveApproval = Rpc.make("approval/resolve", {
  payload: {
    conversation: ConversationId,
    approval: Schema.String.annotate({
      description: "A key of the view's nisse.approvals `requests`: the call's tool task.",
    }),
    author: Schema.String.annotate({ description: "Who answers; the transcript names them." }),
    allow: Schema.Boolean,
  },
  success: Schema.Struct({
    accepted: Schema.Boolean.annotate({
      description: "False when another answer came first, or the call is no longer waiting: the first answer counts.",
    }),
  }),
  error: Schema.Union([NoSuchConversation, NoSuchApproval]),
})

export const StopServer = Rpc.make("server/stop")

export const AuthMethod = Schema.Literals(["browser", "device_code", "terminal"]).annotate({
  description:
    "browser: a browser on the server's machine signs in and calls back to it. device_code: any device signs in with a short code. terminal: the provider's own sign-in command runs in a terminal on the server's machine.",
})
export type AuthMethod = typeof AuthMethod.Type

export const ProviderHealth = Schema.Struct({
  status: Schema.Literals(["ready", "signed_out", "unavailable"]),
  version: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(Schema.String.annotate({ description: "Who it is signed in as, and on what plan." })),
  message: Schema.optionalKey(Schema.String.annotate({ description: "Why it is not ready, or what to do about it." })),
  checkedAt: Schema.Int,
})
export type ProviderHealth = typeof ProviderHealth.Type

export const ProviderSnapshot = Schema.Struct({
  id: Schema.String,
  driver: Schema.String.annotate({ description: "Its kind: claude, openai or script." }),
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

export const AuthInteraction = Schema.Union([
  Schema.TaggedStruct("browser", { url: Schema.String }).annotate({
    description:
      "Open url and sign in. A browser on another machine can't call back: answer with the address it ends on.",
  }),
  Schema.TaggedStruct("device_code", { url: Schema.String, code: Schema.String }),
  Schema.TaggedStruct("terminal", {
    command: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  }).annotate({
    description: "Run command with env in a terminal on the server's machine, then answer terminal_exited.",
  }),
])
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

export const AuthResponse = Schema.Union([
  Schema.TaggedStruct("callback", { url: Schema.String }),
  Schema.TaggedStruct("terminal_exited", { success: Schema.Boolean }),
])
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
  success: AuthState.annotate({ description: "The sign-in; the one already running for this provider, if any." }),
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
  success: AuthState.annotate({ description: "The last state of each provider's sign-in, then every change." }),
  stream: true,
})

export const KernelRpcs = RpcGroup.make(
  Initialize,
  StartConversation,
  Submit,
  Watch,
  Interrupt,
  ResolveApproval,
  StopServer,
  ListProviders,
  ListModels,
  StartAuth,
  RespondAuth,
  CancelAuth,
  Logout,
  WatchAuth,
)
