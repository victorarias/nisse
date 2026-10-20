use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::*;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
    Integer(i64),
    String(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Message {
    Request(Request),
    Response(Response),
    Error(ErrorResponse),
    Notification(Notification),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Request {
    pub id: RequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Response {
    pub id: RequestId,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ErrorResponse {
    pub id: RequestId,
    pub error: RpcError,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;

    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Notification {
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

/// Requests a client sends, keyed by method.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "method", content = "params")]
pub enum ClientRequest {
    #[serde(rename = "initialize")]
    Initialize(InitializeParams),
    #[serde(rename = "conversation/create")]
    ConversationCreate(ConversationCreateParams),
    #[serde(rename = "conversation/list")]
    ConversationList(ConversationListParams),
    #[serde(rename = "conversation/read")]
    ConversationRead(ConversationReadParams),
    #[serde(rename = "conversation/subscribe")]
    ConversationSubscribe(ConversationSubscribeParams),
    #[serde(rename = "conversation/submit")]
    ConversationSubmit(ConversationSubmitParams),
}

impl ClientRequest {
    pub fn into_request(self, id: RequestId) -> Request {
        let mut value = serde_json::to_value(self).expect("client requests serialize");
        let method = value["method"]
            .as_str()
            .expect("tagged with method")
            .to_owned();
        let params = value["params"].take();
        Request { id, method, params }
    }

    pub fn from_request(request: &Request) -> Result<Self, RpcError> {
        let tagged = serde_json::json!({ "method": request.method, "params": request.params });
        serde_json::from_value(tagged).map_err(|error| {
            let known = KNOWN_METHODS.contains(&request.method.as_str());
            if known {
                RpcError::new(RpcError::INVALID_PARAMS, error.to_string())
            } else {
                RpcError::new(
                    RpcError::METHOD_NOT_FOUND,
                    format!("unknown method {}", request.method),
                )
            }
        })
    }
}

const KNOWN_METHODS: &[&str] = &[
    "initialize",
    "conversation/create",
    "conversation/list",
    "conversation/read",
    "conversation/subscribe",
    "conversation/submit",
];

/// Notifications the server sends, keyed by method.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "method", content = "params")]
pub enum ServerNotification {
    #[serde(rename = "conversation/committed")]
    Committed(Commit),
    #[serde(rename = "conversation/status")]
    Status(StatusChanged),
    #[serde(rename = "ui/changed")]
    UiChanged(UiChanged),
}

impl ServerNotification {
    pub fn into_notification(self) -> Notification {
        let mut value = serde_json::to_value(self).expect("notifications serialize");
        let method = value["method"]
            .as_str()
            .expect("tagged with method")
            .to_owned();
        Notification {
            method,
            params: value["params"].take(),
        }
    }

    pub fn from_notification(notification: &Notification) -> Option<Self> {
        serde_json::from_value(serde_json::json!({
            "method": notification.method,
            "params": notification.params,
        }))
        .ok()
    }
}
