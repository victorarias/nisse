use std::{future::Future, pin::Pin, time::Duration};

use anyhow::Result;
use nisse_protocol::{Entry, kinds};

use crate::tools::ToolCall;

pub type ModelFuture<'a> = Pin<Box<dyn Future<Output = Result<ModelResponse>> + Send + 'a>>;

pub enum ModelResponse {
    Text(String),
    ToolCall(ToolCall),
}

pub trait Model: Send + Sync {
    fn name(&self) -> &str;
    fn respond<'a>(&'a self, transcript: &'a [Entry]) -> ModelFuture<'a>;
}

/// A stand-in model until real providers land: it echoes, and runs `bash` for input that starts with `!`.
pub struct EchoModel {
    pub think: Duration,
}

impl Model for EchoModel {
    fn name(&self) -> &str {
        "echo"
    }

    fn respond<'a>(&'a self, transcript: &'a [Entry]) -> ModelFuture<'a> {
        Box::pin(async move {
            tokio::time::sleep(self.think).await;
            let Some(last) = transcript.last() else {
                return Ok(ModelResponse::Text("Nothing to answer yet.".into()));
            };
            let text = last.data["text"].as_str().unwrap_or_default();
            Ok(match last.kind.as_str() {
                kinds::TOOL_RESULT => {
                    let outcome = if last.data["is_error"].as_bool() == Some(true) {
                        "failed"
                    } else {
                        "ran"
                    };
                    ModelResponse::Text(format!(
                        "The command {outcome}:\n{}",
                        last.data["output"].as_str().unwrap_or_default().trim_end()
                    ))
                }
                _ => match text.strip_prefix('!') {
                    Some(command) => ModelResponse::ToolCall(ToolCall {
                        id: crate::new_id(),
                        name: "bash".into(),
                        args: serde_json::json!({ "command": command.trim() }),
                    }),
                    None => ModelResponse::Text(format!("You said: {text}")),
                },
            })
        })
    }
}
