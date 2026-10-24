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
    /// The model that answers this server's conversations.
    pub model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ConversationCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Conversation {
    pub id: ConversationId,
    pub title: Option<String>,
    pub creator: Actor,
    pub status: ConversationStatus,
    pub created_at_ms: i64,
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
    /// The newest commit the result reflects; subscribe from here.
    pub seq: Seq,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConversationSubscribeParams {
    pub conversation_id: ConversationId,
    #[serde(default)]
    pub since_seq: Seq,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
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
