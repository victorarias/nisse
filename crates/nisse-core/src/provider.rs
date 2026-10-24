use std::{future::Future, path::Path, pin::Pin, time::Duration};

use anyhow::{Result, bail};
use nisse_protocol::{
    AuthInteraction, AuthMethod, AuthResponse, ModelInfo, ProviderHealth, ProviderStatus, Skill,
    kinds,
};
use tokio::sync::mpsc;

use crate::{
    tools::{ToolCall, run_builtin_tool},
    turn::{Approval, Turn},
};

pub type ProviderFuture<'a, T = ()> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
pub type HealthFuture<'a> = Pin<Box<dyn Future<Output = ProviderHealth> + Send + 'a>>;
pub type ModelsFuture<'a> = Pin<Box<dyn Future<Output = Vec<ModelInfo>> + Send + 'a>>;

/// Runs one turn: answers the conversation's newest input, committing through `turn` as it goes.
/// A provider that runs its own agent loop, like Claude Code, still commits every step there.
/// A provider that needs an account says how it stands and signs in to it.
pub trait Provider: Send + Sync {
    /// What runs it, such as `claude` or `openai`, whatever the name a server gives it.
    fn driver(&self) -> &str;

    /// The model a conversation gets when it names none. `None` leaves the choice to the
    /// provider each time it runs, as Claude Code makes it.
    fn default_model(&self) -> Option<&str> {
        None
    }

    /// The skills Nisse lists for a conversation in `cwd`, and attaches to input that names
    /// them. A provider whose agent expands skills itself, like Claude Code, has none here.
    fn skills(&self, cwd: &Path) -> Vec<Skill> {
        let _ = cwd;
        Vec::new()
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a>;

    /// The models a selection can name, best first, as last found, or found again when
    /// `refresh` is set.
    fn models(&self, _refresh: bool) -> ModelsFuture<'_> {
        Box::pin(async { Vec::new() })
    }

    /// How it stands, as last found, or found again when `refresh` is set.
    fn health(&self, _refresh: bool) -> HealthFuture<'_> {
        Box::pin(async { ProviderHealth::new(ProviderStatus::Ready) })
    }

    /// The ways to sign in, the first one preferred; none when there is nothing to sign in to.
    fn sign_in_methods(&self) -> Vec<AuthMethod> {
        Vec::new()
    }

    /// Signs in by `method`, showing a person what to do through `flow`. Its health tells
    /// whether that worked.
    fn sign_in(&self, _method: AuthMethod, _flow: SignIn) -> ProviderFuture<'_> {
        Box::pin(async { bail!("there is nothing to sign in to") })
    }

    fn sign_out(&self) -> ProviderFuture<'_> {
        Box::pin(async { bail!("there is nothing to sign out of") })
    }
}

/// A sign-in in progress: what it shows people, and what they answer.
pub struct SignIn {
    show: Box<dyn Fn(AuthInteraction) + Send + Sync>,
    responses: mpsc::UnboundedReceiver<AuthResponse>,
}

impl SignIn {
    pub fn new(
        show: impl Fn(AuthInteraction) + Send + Sync + 'static,
        responses: mpsc::UnboundedReceiver<AuthResponse>,
    ) -> Self {
        Self {
            show: Box::new(show),
            responses,
        }
    }

    pub fn show(&self, interaction: AuthInteraction) {
        (self.show)(interaction);
    }

    /// The next answer; `None` once nobody can answer anymore.
    pub async fn response(&mut self) -> Option<AuthResponse> {
        self.responses.recv().await
    }
}

/// A stand-in model: it echoes, and runs `Bash` for input that starts with `!`.
pub struct Echo {
    pub think: Duration,
}

impl Provider for Echo {
    fn driver(&self) -> &str {
        "echo"
    }

    fn default_model(&self) -> Option<&str> {
        Some("echo")
    }

    fn models(&self, _refresh: bool) -> ModelsFuture<'_> {
        Box::pin(async {
            vec![ModelInfo {
                id: "echo".into(),
                name: "Echo".into(),
                description: Some("Says what it was told and runs !commands".into()),
                efforts: Vec::new(),
                default_effort: None,
                context_window: None,
                code_mode: false,
            }]
        })
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
                    parent: None,
                };
                turn.call_tool(call, Approval::NotNeeded, run_builtin_tool(turn.cwd()))
                    .await?;
                turn.place_steers()?;
            }
        })
    }
}
