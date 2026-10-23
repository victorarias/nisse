use std::{future::Future, pin::Pin, time::Duration};

use anyhow::Result;
use nisse_protocol::kinds;

use crate::{
    tools::{ToolCall, run_builtin_tool},
    turn::{Approval, Turn},
};

pub type ProviderFuture<'a> = Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;

/// Runs one turn: answers the conversation's newest input, committing through `turn` as it goes.
/// A provider that runs its own agent loop, like Claude Code, still commits every step there.
pub trait Provider: Send + Sync {
    fn model(&self) -> &str;
    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a>;
}

/// A stand-in model: it echoes, and runs `Bash` for input that starts with `!`.
pub struct Echo {
    pub think: Duration,
}

impl Provider for Echo {
    fn model(&self) -> &str {
        "echo"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            loop {
                tokio::time::sleep(self.think).await;
                let transcript = turn.transcript()?;
                let Some(last) = transcript.last() else {
                    return turn.say("Nothing to answer yet.");
                };
                if last.kind == kinds::TOOL_RESULT {
                    let outcome = if last.data["is_error"].as_bool() == Some(true) {
                        "failed"
                    } else {
                        "ran"
                    };
                    return turn.say(&format!(
                        "The command {outcome}:\n{}",
                        last.data["output"].as_str().unwrap_or_default().trim_end()
                    ));
                }
                let text = last.data["text"].as_str().unwrap_or_default();
                let Some(command) = text.strip_prefix('!') else {
                    return turn.say(&format!("You said: {text}"));
                };
                let call = ToolCall {
                    id: crate::new_id(),
                    name: "Bash".into(),
                    args: serde_json::json!({ "command": command.trim() }),
                };
                turn.call_tool(call, Approval::NotNeeded, run_builtin_tool)
                    .await?;
                turn.place_steers()?;
            }
        })
    }
}
