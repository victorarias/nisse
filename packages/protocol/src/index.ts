// The protocol clients speak to the server: JSON-RPC over the home's socket, one call per line. A client watches a
// conversation's view: the view through a window first, then the operations each commit applies to it. `bun run
// schema` prints it to `schema/nisse.schema.json`.
import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const PROTOCOL_VERSION = 1

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
      "pi.user, pi.assistant and pi.tool-result carry model messages in `model`; nisse.run_end says how a run ended in `data`, nisse.approval who answered a call, nisse.withdrawn which input was withdrawn before it ran.",
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

/** An entry `{ author, selection }`: someone switched the conversation's model; it answers with it from the next run on. */
export const MODEL_KIND = "nisse.model"

/** A person's input: the entry its user message is placed as, with data `{ author, requestId }`. */
export const USER_KIND = "nisse.user"

/** A person's input withdrawn while it waited, as an interrupt withdraws what waits, with data `{ requestId }`. */
export const WITHDRAWN_KIND = "nisse.withdrawn"

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

/** The conversation's provider runs it inside its parent's run, so it takes input only through its parent. */
export class TakesNoInput extends Schema.TaggedError<TakesNoInput>()("TakesNoInput", {
  conversation: Schema.String,
}) {}

/** The entry is not one the conversation's transcript holds. */
export class NoSuchEntry extends Schema.TaggedError<NoSuchEntry>()("NoSuchEntry", {
  entry: Schema.Int,
}) {}

export class NoSuchConversation extends Schema.TaggedError<NoSuchConversation>()("NoSuchConversation", {
  conversation: Schema.String,
}) {}

/** An attached image the server cannot decode or make fit the model's image limits; `message` says why. */
export class UnreadableImage extends Schema.TaggedError<UnreadableImage>()("UnreadableImage", {
  name: Schema.String,
  message: Schema.String,
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

/** Starts a new, empty context, the transcript kept. Behind a working run it waits in pi.inbox and applies at the run's next step. */
/** The server opened its home read-only (`nisse serve --read-only`): it shows the home and changes nothing. */
export class ReadOnlyServer extends Schema.TaggedError<ReadOnlyServer>()("ReadOnlyServer", {
  message: Schema.String,
}) {}

export const Initialize = Rpc.make("initialize", {
  payload: { client: Schema.String, version: Schema.String, protocol: Schema.Int },
  success: Schema.Struct({
    version: Schema.String,
    protocol: Schema.Int,
    readOnly: Schema.Boolean.annotate({
      description: "The server shows its home and changes nothing: calls that would change it fail ReadOnlyServer.",
    }),
  }),
})

export const Approvals = Schema.Literals(["ask", "auto"]).annotate({
  description: "`ask`: calls that change things wait for approval/resolve; `auto`: every call runs without asking.",
})
export type Approvals = typeof Approvals.Type

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
          "The id to name it by, chosen by the client; not all digits. Starting with an id that names a conversation, a chosen one or its number, answers with that one by the id other calls name it by, and changes nothing.",
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
    instructions: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Instructions the model follows in this conversation, beside its own. Its subagents don't get them.",
      }),
    ),
  },
  success: Schema.Struct({
    conversation: ConversationId,
    model: ModelSelection.annotate({
      description:
        "The model it runs, defaults applied, with the provider's default model when none was named; for an id that names one, that conversation's.",
    }),
  }),
  error: Schema.Union([ReadOnlyServer, InvalidConversationId, UnknownProvider, UnknownEffort]),
})

/** An image a person attaches to their input. */
export const Image = Schema.Struct({
  name: Schema.String.annotate({ description: "What the transcript calls it, such as its file name." }),
  data: Schema.String.annotate({ description: "The file's bytes, base64." }),
  mimeType: Schema.String.annotate({ description: "image/png, image/jpeg, image/gif, image/webp or image/bmp." }),
})
export type Image = typeof Image.Type

export const Submit = Rpc.make("conversation/submit", {
  payload: {
    conversation: ConversationId,
    requestId: Schema.String.annotate({
      description: `Submitting again with the same id is answered once. The input's ${USER_KIND} entry keeps it in its data, or its ${WITHDRAWN_KIND} entry when it is withdrawn before it runs.`,
    }),
    author: Schema.String.annotate({
      description: `Who wrote it; the input is placed as a ${USER_KIND} entry naming them, and waits in pi.inbox with them.`,
    }),
    text: Schema.String,
    images: Schema.optionalKey(
      Schema.Array(Image).annotate({
        description:
          "Placed after the text, each prepared to fit the model's image limits (resized or converted); the entry's data names them.",
      }),
    ),
    steer: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Reach the run in flight at its next step instead of waiting for it to end; idle, it starts a run.",
      }),
    ),
  },
  success: Schema.Struct({ submission: Schema.Int }),
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, TakesNoInput, UnreadableImage]),
})

export const Watch = Rpc.make("conversation/watch", {
  payload: { conversation: ConversationId, window: Schema.optionalKey(Window) },
  success: ViewItem.annotate({ description: "The view through the window, then each commit's changes to it." }),
  error: Schema.Union([NoSuchConversation, InvalidWindow, FellBehind]),
  stream: true,
})

export const Interrupt = Rpc.make("conversation/interrupt", {
  payload: { conversation: ConversationId.annotate({ description: "Stops its run; what was said stays." }) },
  error: Schema.Union([ReadOnlyServer, NoSuchConversation]),
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
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, NoSuchApproval]),
})

export const Lineage = Schema.Struct({
  parent: ConversationId,
  root: ConversationId.annotate({ description: "The conversation people started, at the top of the tree." }),
  call: Schema.String.annotate({ description: "The parent's call that started it." }),
  title: Schema.String,
  task: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Its task name, such as /root/explore, which agents address it by. Absent when its parent's provider runs it, as Claude Code runs its own subagents: then it takes input only through its parent, and stops when its parent's run does.",
    }),
  ),
  agentType: Schema.optionalKey(Schema.String),
}).annotate({ description: "Where a subagent comes from. It runs on its parent's provider, in its directory." })
export type Lineage = typeof Lineage.Type

export const ConversationInfo = Schema.Struct({
  id: ConversationId,
  cwd: Schema.String,
  model: ModelSelection,
  approvals: Approvals,
  lineage: Schema.optionalKey(Lineage),
  instructions: Schema.optionalKey(
    Schema.String.annotate({
      description: "What the client that started it asked the model to follow, beside its own.",
    }),
  ),
  ended: Schema.optionalKey(
    Schema.Struct({
      outcome: Outcome,
      message: Schema.optionalKey(Schema.String.annotate({ description: "Why the run ended without an answer." })),
      said: Schema.optionalKey(
        Schema.String.annotate({ description: "The last message the model wrote in the conversation." }),
      ),
    }).annotate({ description: "How the conversation's last run ended." }),
  ),
})
export type ConversationInfo = typeof ConversationInfo.Type

export const ListConversations = Rpc.make("conversation/list", {
  success: Schema.Array(ConversationInfo).annotate({
    description: "Every conversation, subagents included, oldest first.",
  }),
})

export const SelectModel = Rpc.make("conversation/select_model", {
  payload: {
    conversation: ConversationId,
    author: Schema.String.annotate({ description: "Who switched it; the transcript names them." }),
    selection: ModelSelection,
  },
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, UnknownProvider, UnknownEffort, TakesNoInput]),
})

export const Skill = Schema.Struct({ name: Schema.String, description: Schema.String, path: Schema.String })
export type Skill = typeof Skill.Type

export const AttachedSkill = Schema.Struct({ name: Schema.String, path: Schema.String, text: Schema.String }).annotate({
  description: "A skill's SKILL.md as it was when the input named it.",
})
export type AttachedSkill = typeof AttachedSkill.Type

export const ListSkills = Rpc.make("skills/list", {
  payload: { conversation: ConversationId },
  success: Schema.Array(Skill).annotate({
    description: `The skills input to this conversation can name with /name or $name, which then carries them as \`skills\` in its ${USER_KIND} entry's data. Empty when its provider expands skills itself.`,
  }),
  error: NoSuchConversation,
})

export const Entries = Rpc.make("conversation/entries", {
  payload: {
    conversation: ConversationId,
    from: Schema.optionalKey(Schema.Int.annotate({ description: "The oldest entry to include." })),
    to: Schema.optionalKey(Schema.Int.annotate({ description: "The newest entry to include." })),
    order: Schema.optionalKey(
      Schema.Literals(["ascending", "descending"]).annotate({ description: "Default descending: newest first." }),
    ),
    limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "The most entries one page holds.",
    }),
    cursor: Schema.optionalKey(Json.annotate({ description: "The `next` of the page before, to read on from it." })),
  },
  success: Schema.Struct({
    entries: Schema.Array(EntryRecord).annotate({
      description: "Every entry of the transcript in the range, forks' inherited ones included.",
    }),
    next: Schema.optionalKey(Json.annotate({ description: "Present when more entries follow; pass it as `cursor`." })),
  }),
  error: NoSuchConversation,
})

export const ReadContext = Rpc.make("conversation/context", {
  payload: {
    conversation: ConversationId,
    at: Schema.optionalKey(
      Schema.Int.annotate({ description: "Cut the context off after this entry; absent for the context now." }),
    ),
  },
  success: Schema.Struct({
    messages: Schema.Array(Json).annotate({ description: "What the model is sent: the messages of its next request." }),
    entries: Schema.Array(Schema.Int).annotate({
      description: "The entries the context is made of, oldest first: since the last reset or compaction.",
    }),
  }),
  error: Schema.Union([NoSuchConversation, NoSuchEntry]),
})

export const ExtensionInfo = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  state: Schema.Literals(["loaded", "failed", "disabled"]),
  message: Schema.optionalKey(Schema.String.annotate({ description: "Why it failed to load." })),
})
export type ExtensionInfo = typeof ExtensionInfo.Type

export const ListExtensions = Rpc.make("extensions/list", {
  success: Schema.Array(ExtensionInfo).annotate({
    description: "Every extension in the home, in the order they load.",
  }),
})

export const ReloadExtensions = Rpc.make("extensions/reload", {
  success: Schema.Array(ExtensionInfo).annotate({
    description:
      "Loads every extension again from disk, with its options from config.toml, then swaps them in, clears every status line and unloads the old ones.",
  }),
})

export const TreeStatus = Schema.TaggedStruct("tree", {
  conversation: ConversationId.annotate({
    description: "A conversation people started; its tree is it and its subagents.",
  }),
  seq: Schema.Int.annotate({
    description:
      "The commit the tree's status changed at; 0 for a tree that was already busy when the server started, before any change.",
  }),
  status: Schema.Literals(["idle", "working", "waiting"]).annotate({
    description: "waiting when a conversation in the tree waits on a person, working when one runs, idle otherwise.",
  }),
  ended: Schema.optionalKey(
    Schema.Struct({
      outcome: Outcome,
      message: Schema.optionalKey(Schema.String.annotate({ description: "Why the run ended without an answer." })),
      said: Schema.optionalKey(
        Schema.String.annotate({ description: "The last message the model wrote in the conversation." }),
      ),
    }).annotate({ description: "The run of the conversation itself ended at seq." }),
  ),
})
export type TreeStatus = typeof TreeStatus.Type

export const TreeSnapshot = Schema.TaggedStruct("trees", {
  seq: Schema.Int.annotate({
    description:
      "The last commit this server published before the watch began; 0 when it has published none since it started. Every later item has a greater seq.",
  }),
  trees: Schema.Array(TreeStatus).annotate({ description: "Every tree that is not idle; the rest are idle." }),
})

export const TreeItem = Schema.Union([TreeSnapshot, TreeStatus])
export type TreeItem = typeof TreeItem.Type

export const WatchStatus = Rpc.make("status/watch", {
  success: TreeItem.annotate({
    description: "The status of every tree, then each commit that changes one or ends the run of its root.",
  }),
  error: FellBehind,
  stream: true,
})

/** Each extension's status line in a conversation, by extension name; the view's document of this kind. */
export const STATUS_LINES_KIND = "nisse.status_lines"

/** An entry `{ extension, text }`: an extension told the people in the conversation something. */
export const TOAST_KIND = "nisse.toast"

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
  error: Schema.Union([ReadOnlyServer, UnknownProvider, CannotSignIn]),
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
  error: Schema.Union([ReadOnlyServer, UnknownProvider, CannotSignIn]),
})

export const WatchAuth = Rpc.make("auth/watch", {
  success: AuthState.annotate({ description: "The last state of each provider's sign-in, then every change." }),
  stream: true,
})

/** The conversation is working, and the call takes an idle one. */
export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()("ConversationBusy", {
  conversation: Schema.String,
}) {}

/** The conversation cannot compact now: `message` says why, such as a provider that compacts by itself. */
export class CannotCompact extends Schema.TaggedError<CannotCompact>()("CannotCompact", {
  message: Schema.String,
}) {}

/** `conversation/continue` has nothing to go on with: no run has ended, or the last one answered. */
export class NothingToContinue extends Schema.TaggedError<NothingToContinue>()("NothingToContinue", {
  message: Schema.String,
}) {}

export class NoSuchSubmission extends Schema.TaggedError<NoSuchSubmission>()("NoSuchSubmission", {
  submission: Schema.Int,
}) {}

/** A person started a new context: an entry of this kind, `{ author }`, whose `model` carries the handoff, if any. */
export const RESET_KIND = "pi.reset"

/** A summary that replaced earlier context: an entry of this kind, whose `data.reason` says what started it. */
export const COMPACTION_KIND = "pi.compaction"

/** An entry `{ author, instructions?, maxTurns? }`: someone changed the conversation's settings; null clears one. */
export const CONFIGURED_KIND = "nisse.configured"

export const Fork = Rpc.make("conversation/fork", {
  payload: {
    conversation: ConversationId,
    at: Schema.Int.annotate({ description: "The last entry the fork inherits; the fork goes on from it." }),
    id: Schema.optionalKey(
      Schema.String.annotate({ description: "The id to name the fork by, as conversation/start takes one." }),
    ),
  },
  success: Schema.Struct({
    conversation: ConversationId.annotate({
      description: "The fork: a conversation of its own, on the same model, settings and approvals.",
    }),
  }),
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, NoSuchEntry, InvalidConversationId, TakesNoInput]),
})

/**
 * Starts a new, empty context, the transcript kept. Behind a working run it waits in pi.inbox and applies at the run's
 * next step.
 */
export const Reset = Rpc.make("conversation/reset", {
  payload: {
    conversation: ConversationId,
    author: Schema.String.annotate({ description: `Who reset it; its ${RESET_KIND} entry names them.` }),
    handoff: Schema.optionalKey(
      Schema.String.annotate({ description: "The first message of the new context, such as a brief of the work." }),
    ),
  },
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, TakesNoInput]),
})

/**
 * Summarizes the context now. pi.live's `compactions` shows it running and `compactionFailure` why one failed; its
 * pi.compaction entry replaces what it summarized.
 */
export const Compact = Rpc.make("conversation/compact", {
  payload: {
    conversation: ConversationId,
    instructions: Schema.optionalKey(
      Schema.String.annotate({ description: "What the summary should keep, beside what it always keeps." }),
    ),
  },
  success: Schema.Struct({
    outcome: Schema.Literals(["compacted", "nothing_to_compact", "failed", "stopped"]).annotate({
      description:
        "compacted: its pi.compaction entry is placed, at once or, behind a run in flight, at the run's next step. nothing_to_compact: the context is no longer than what a summary keeps. stopped: interrupted before it ended.",
    }),
    message: Schema.optionalKey(Schema.String.annotate({ description: "Why it failed." })),
  }).annotate({ description: "How the compaction ended; the call answers once it has." }),
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, TakesNoInput, CannotCompact]),
})

/** Starts a run with no new input after one that did not answer: it failed, was interrupted or hit a limit. */
export const Continue = Rpc.make("conversation/continue", {
  payload: { conversation: ConversationId },
  success: Schema.Struct({ submission: Schema.Int }),
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, TakesNoInput, ConversationBusy, NothingToContinue]),
})

export const Withdraw = Rpc.make("submission/withdraw", {
  payload: {
    conversation: ConversationId,
    submission: Schema.Int.annotate({ description: "An `id` of the view's pi.inbox `items`." }),
  },
  success: Schema.Struct({
    result: Schema.Literals(["withdrawn", "already_placed", "settled"]).annotate({
      description: "already_placed: the run took it in already; settled: its run ended.",
    }),
  }),
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, NoSuchSubmission]),
})

/** Changes the conversation's settings from its next model request on. */
export const Configure = Rpc.make("conversation/configure", {
  payload: {
    conversation: ConversationId,
    author: Schema.String.annotate({ description: `Who changed it; its ${CONFIGURED_KIND} entry names them.` }),
    instructions: Schema.optionalKey(
      Schema.NullOr(Schema.String).annotate({
        description: "The model's instructions beside its own; null clears them.",
      }),
    ),
    maxTurns: Schema.optionalKey(
      Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
        description:
          "The tool rounds one run may take before it ends failed, naming the limit; null for no limit, the default.",
      }),
    ),
  },
  error: Schema.Union([ReadOnlyServer, NoSuchConversation, TakesNoInput]),
})

export const UsageTotals = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number.annotate({ description: "An estimate in US dollars; 0 on a subscription." }),
  }),
}).annotate({ description: "Tokens spent, as the providers reported them." })

export const Usage = Schema.Struct({
  models: Schema.Record(Schema.String, UsageTotals).annotate({
    description: "By `provider/model`: the answers and summaries each model made.",
  }),
  tools: Schema.Record(Schema.String, UsageTotals).annotate({
    description: "By tool name: what tools that call models spent, such as a summary a tool asked for.",
  }),
}).annotate({ description: "The same ledger as the view's pi.usage document." })

export const GetUsage = Rpc.make("usage/get", {
  payload: {
    conversation: Schema.optionalKey(
      ConversationId.annotate({
        description: "One conversation's own spend; absent for every conversation's, summed.",
      }),
    ),
  },
  success: Usage,
  error: NoSuchConversation,
})

export const TaskGraphStart = Schema.TaggedStruct("graph", {
  graph: Schema.Struct({
    tasks: Schema.Record(Schema.String, Json).annotate({
      description:
        "Every live task by id: its kind, conversationId, owner task, state (status, phase, the tasks it waits on), blocked reason, and the conversations it owns.",
    }),
  }),
})
export const TaskGraphChange = Schema.TaggedStruct("change", {
  ops: Schema.Array(Json).annotate({ description: "The operations one commit applied to the graph, as a view's." }),
})
export const TaskGraphItem = Schema.Union([TaskGraphStart, TaskGraphChange])
export type TaskGraphItem = typeof TaskGraphItem.Type

export const WatchTasks = Rpc.make("tasks/watch", {
  success: TaskGraphItem.annotate({ description: "The graph of the home's live work, then each commit's changes." }),
  error: FellBehind,
  stream: true,
})

export const NisseRpcs = RpcGroup.make(
  Initialize,
  StartConversation,
  ListConversations,
  Submit,
  Watch,
  Entries,
  ReadContext,
  SelectModel,
  ListSkills,
  Interrupt,
  Fork,
  Reset,
  Compact,
  Continue,
  Withdraw,
  Configure,
  GetUsage,
  WatchTasks,
  ResolveApproval,
  ListExtensions,
  ReloadExtensions,
  WatchStatus,
  StopServer,
  ListProviders,
  ListModels,
  StartAuth,
  RespondAuth,
  CancelAuth,
  Logout,
  WatchAuth,
)
