use std::path::PathBuf;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type ConversationId = String;
pub type EntryId = String;
pub type Seq = i64;

/// Who caused an entry or a submission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Actor {
    Person { id: String, name: String },
    Agent { conversation_id: ConversationId },
    Extension { name: String },
    Model { model: String },
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InitializeParams {
    pub client: ClientInfo,
    pub protocol_version: u32,
    #[serde(default)]
    pub experimental: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InitializeResult {
    pub server: ClientInfo,
    pub protocol_version: u32,
    pub actor: Actor,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The client's working directory, absolute: tools run here and resolve relative paths
    /// against it, and the project's extensions are found from it.
    pub cwd: PathBuf,
    /// Who answers, by provider name; the default selection's provider when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The provider's model; the default selection's, or the provider's default, when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The model's reasoning effort; the default selection's when it names the same model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// Who answers a conversation, and how hard it thinks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModelSelection {
    pub provider: ProviderId,
    /// Absent when the provider picks its own model at run time, as Claude Code does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Absent for the model's own default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Conversation {
    pub id: ConversationId,
    pub title: Option<String>,
    pub creator: Actor,
    pub status: ConversationStatus,
    pub created_at_ms: i64,
    pub cwd: PathBuf,
    /// Read by each run as it starts.
    #[serde(flatten)]
    pub selection: ModelSelection,
    /// Set for a subagent: the conversation and tool call that started it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Lineage>,
}

/// Where a subagent comes from. It runs on its parent's provider, in its parent's directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Lineage {
    pub parent: ConversationId,
    /// The conversation people started, at the top of the tree.
    pub root: ConversationId,
    /// The parent's tool call that started it.
    pub call_id: String,
    /// Its canonical task name, such as `/root/explore`, which agents address it by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    /// The agent type it was started as, from Claude Code's agent files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Its parent's provider runs it inside the parent's own session, as Claude Code runs its
    /// subagents: it takes no input of its own, and stops when the parent's run does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hosted: bool,
    /// It starts from its parent's transcript before this commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_at: Option<Seq>,
}

/// Switches the conversation's model from its next run on, with a `nisse.model` entry.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationSelectModelParams {
    pub conversation_id: ConversationId,
    #[serde(flatten)]
    pub selection: ModelSelection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ConversationListParams {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationListResult {
    pub conversations: Vec<Conversation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationReadParams {
    pub conversation_id: ConversationId,
    #[serde(default)]
    pub since_seq: Seq,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationReadResult {
    pub conversation: Conversation,
    pub entries: Vec<Entry>,
    /// Text the model is still writing, not yet an entry.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub live: String,
    /// Input waiting for a run to place it, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queued: Vec<Queued>,
    /// The newest commit the result reflects; subscribe from here.
    pub seq: Seq,
}

/// A submission no run has placed yet. It leaves the queue as its entry lands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Queued {
    pub submission_id: String,
    pub author: Actor,
    pub input: Input,
    pub when_busy: WhenBusy,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationSubscribeParams {
    pub conversation_id: ConversationId,
    #[serde(default)]
    pub since_seq: Seq,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Input {
    Text { text: String },
    Write { kind: String, data: Value },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WhenBusy {
    Steer,
    #[default]
    FollowUp,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationSubmitParams {
    pub conversation_id: ConversationId,
    pub input: Input,
    /// Retrying with the same id returns the first submission instead of submitting twice.
    pub request_id: String,
    #[serde(default)]
    pub when_busy: WhenBusy,
}

/// Stops the conversation's run, if it has one, and the runs of every subagent under it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationInterruptParams {
    pub conversation_id: ConversationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationInterruptResult {
    /// False when nothing was running.
    pub interrupted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationSubmitResult {
    pub submission_id: String,
    pub status: SubmissionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionStatus {
    Queued,
    Placed,
    Answered,
    Unanswered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    Idle,
    Working,
    NeedsApproval,
    Parked,
}

/// One immutable transcript record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Entry {
    pub id: EntryId,
    pub seq: Seq,
    pub conversation_id: ConversationId,
    pub kind: String,
    pub author: Actor,
    pub data: Value,
    pub created_at_ms: i64,
}

pub mod kinds {
    pub const USER: &str = "nisse.user";
    pub const ASSISTANT: &str = "nisse.assistant";
    pub const TOOL_CALL: &str = "nisse.tool_call";
    pub const TOOL_RESULT: &str = "nisse.tool_result";
    pub const APPROVAL_REQUEST: &str = "nisse.approval_request";
    pub const APPROVAL: &str = "nisse.approval";
    /// Someone switched the conversation's model; its data is the new `ModelSelection`.
    pub const MODEL: &str = "nisse.model";
    /// A tool call started a subagent: `call_id`, the child's `conversation_id`, its `title`
    /// and its `agent_type`.
    pub const SUBAGENT: &str = "nisse.subagent";
}

/// What one agent sent another, carried by the `nisse.user` entry it became, as `mail`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Mail {
    #[serde(rename = "type")]
    pub kind: MailKind,
    /// The recipient's task name.
    pub task: String,
    /// The sender's task name.
    pub sender: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MailKind {
    /// Work to do: it starts a run when the recipient has none.
    NewTask,
    /// Taken in at the recipient's next step, without starting a run.
    Message,
    /// A subagent's last message of a run, for its parent.
    FinalAnswer,
}

impl MailKind {
    pub fn starts_a_run(self) -> bool {
        self == Self::NewTask
    }
}

/// One atomic write, as seen by subscribers of its conversation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Commit {
    pub seq: Seq,
    pub conversation_id: ConversationId,
    pub entries: Vec<Entry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ConversationStatus>,
    /// The text the model is still writing; empty once it became an entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<String>,
    /// The whole queue, whenever this commit changed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<Vec<Queued>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalResolveParams {
    pub conversation_id: ConversationId,
    pub call_id: String,
    pub allow: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalResolveResult {
    /// False when someone answered first, or nothing waits on this call.
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SkillsListParams {
    pub conversation_id: ConversationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SkillsListResult {
    pub skills: Vec<Skill>,
}

/// A folder of instructions the model can be asked to follow, by `/name` or `$name` in input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Its `SKILL.md`.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StatusChanged {
    pub conversation_id: ConversationId,
    pub status: ConversationStatus,
    pub seq: Seq,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "surface", rename_all = "snake_case")]
pub enum UiChanged {
    Status {
        extension: String,
        text: Option<String>,
    },
    Toast {
        extension: String,
        text: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ServerStopParams {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ServerStopResult {}

/// A configured provider instance's name, such as `claude` or `openai-work`.
pub type ProviderId = String;

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProvidersListParams {
    /// Check every instance again instead of answering with what was last found.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProvidersListResult {
    pub providers: Vec<ProviderSnapshot>,
}

/// What a provider instance is and how it stands, without asking its model anything.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderSnapshot {
    pub id: ProviderId,
    /// `claude`, `openai` or `echo`.
    pub driver: String,
    /// The ways this instance can be signed in to, the first one preferred.
    pub sign_in: Vec<AuthMethod>,
    #[serde(flatten)]
    pub health: ProviderHealth,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderHealth {
    pub status: ProviderStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Who it is signed in as, and on what plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Why it is not ready, or what to do about it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub checked_at_ms: i64,
}

impl ProviderHealth {
    /// Found just now, with nothing more to say.
    pub fn new(status: ProviderStatus) -> Self {
        let checked_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or_default();
        Self {
            status,
            version: None,
            account: None,
            message: None,
            checked_at_ms,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Ready,
    SignedOut,
    /// It can't run: not installed, or it failed to start.
    Unavailable,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ModelsListParams {
    /// Ask every provider again instead of answering with what was last found.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelsListResult {
    pub providers: Vec<ProviderModels>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderModels {
    pub provider: ProviderId,
    /// The model a selection that names none gets; absent when the provider picks at run time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Best first.
    pub models: Vec<ModelInfo>,
}

/// A model a selection can name, and what it supports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModelInfo {
    /// What a selection names.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The reasoning efforts it takes, least first; empty when it takes none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    /// In tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// It calls tools by writing scripts, as OpenAI's code-mode models do.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub code_mode: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    /// A browser on the server's machine signs in and calls back to it.
    Browser,
    /// Any device signs in with a short code.
    DeviceCode,
    /// The provider's own sign-in command runs in a terminal on the server's machine.
    Terminal,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AuthStartParams {
    pub provider: ProviderId,
    /// The instance's preferred method when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<AuthMethod>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AuthRespondParams {
    pub provider: ProviderId,
    pub flow_id: String,
    pub response: AuthResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AuthCancelParams {
    pub provider: ProviderId,
    pub flow_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AuthLogoutParams {
    pub provider: ProviderId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AuthAccepted {
    /// False when the flow already ended, or waits for nothing of this kind.
    pub accepted: bool,
}

/// One sign-in, as every connection sees it. A provider has at most one at a time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AuthState {
    pub provider: ProviderId,
    pub flow_id: String,
    pub phase: AuthPhase,
    /// What a person must do now, while the flow waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<AuthInteraction>,
    /// Who it signed in as, or why it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthPhase {
    Starting,
    Waiting,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
}

impl AuthPhase {
    pub fn is_over(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthInteraction {
    /// Open `url` and sign in. A browser on another machine can't call back: paste the address
    /// it ends on with a `callback` response.
    Browser { url: String },
    /// Open `url` on any device and enter `code`.
    DeviceCode { url: String, code: String },
    /// Run `command` with `env` in a terminal on the server's machine, then answer
    /// `terminal_exited`.
    Terminal {
        command: Vec<String>,
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        env: std::collections::BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthResponse {
    /// The address the browser ended on after signing in.
    Callback {
        url: String,
    },
    TerminalExited {
        success: bool,
    },
}
