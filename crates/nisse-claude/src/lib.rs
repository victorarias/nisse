//! Claude through Claude Code. Claude keeps Claude Code's own tools and agent loop; Nisse speaks
//! the CLI's stream-json control protocol, commits every step through the turn, and resumes
//! Claude's session at the newest message it committed.

mod process;
mod record;
mod session;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use anyhow::Result;
use nisse_core::{Provider, ProviderFuture, Turn, new_id};
use nisse_protocol::kinds;
use serde_json::json;
use tokio::task::AbortHandle;

use crate::{
    process::Process,
    record::Recorder,
    session::{PRE_TOOL_USE, ProviderState, Session, Unresumable},
};

/// A conversation's claude process is stopped after this long without a turn; the next turn
/// resumes its session.
pub const IDLE: Duration = Duration::from_secs(10 * 60);

pub struct ClaudeOptions {
    /// The `claude` executable.
    pub binary: PathBuf,
    /// Where Claude Code works: its tools run here.
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// A directory to write each conversation's replay fixture into (`NISSE_RECORD`).
    pub record: Option<PathBuf>,
}

pub struct Claude {
    options: ClaudeOptions,
    idle: Arc<Mutex<HashMap<String, Parked>>>,
}

struct Parked {
    session: Session,
    generation: String,
    _stop: IdleStop,
}

struct IdleStop(AbortHandle);

impl Drop for IdleStop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Claude {
    pub fn new(options: ClaudeOptions) -> Self {
        Self {
            options,
            idle: Arc::default(),
        }
    }

    async fn run_turn(&self, turn: &Turn) -> Result<()> {
        let conversation_id = turn.conversation_id().to_owned();
        let mut parked = self
            .idle
            .lock()
            .expect("idle lock")
            .remove(&conversation_id)
            .map(|parked| parked.session);
        parked.take_if(|session| session.has_stopped());
        let mut session = match parked {
            Some(session) => session,
            None => self.start(turn, resumable_state(turn)?)?,
        };
        if let Err(error) = session.answer(turn).await {
            if !error.is::<Unresumable>() {
                return Err(error);
            }
            drop(session);
            session = self.start(turn, None)?;
            session.answer(turn).await?;
        }
        self.park(conversation_id, session);
        Ok(())
    }

    /// Starts claude on the session it saved, or on a new one when there is none to resume. A
    /// new session reaches the provider state once Claude holds some of the conversation, and
    /// is retold the conversation when it holds more than people's words.
    fn start(&self, turn: &Turn, resumable: Option<ProviderState>) -> Result<Session> {
        let retell = resumable.is_none()
            && turn
                .transcript()?
                .iter()
                .any(|entry| entry.kind != kinds::USER);
        let state = resumable.unwrap_or_else(|| ProviderState {
            session: new_id(),
            head: None,
            delivered: 0,
        });

        let mut args: Vec<String> = [
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
            "--permission-prompt-tool",
            "stdio",
            "--include-partial-messages",
            "--replay-user-messages",
            "--setting-sources",
            "user,project,local",
        ]
        .map(str::to_owned)
        .into();
        if let Some(model) = &self.options.model {
            args.extend(["--model".to_owned(), model.clone()]);
        }
        match &state.head {
            Some(head) => args.extend([
                "--resume".to_owned(),
                state.session.clone(),
                "--resume-session-at".to_owned(),
                head.clone(),
            ]),
            None => args.extend(["--session-id".to_owned(), state.session.clone()]),
        }

        let initialize = new_id();
        let recorder = match &self.options.record {
            Some(dir) => {
                let recorder = Recorder::open(
                    dir,
                    turn.conversation_id(),
                    &state.session,
                    &self.options.cwd,
                )?;
                recorder.outbound(&json!({ "argv": args }));
                Some(Arc::new(recorder))
            }
            None => None,
        };
        let process = Process::spawn(&self.options.binary, &self.options.cwd, &args, recorder)?;
        process.send(json!({
            "type": "control_request",
            "request_id": initialize,
            "request": {
                "subtype": "initialize",
                "hooks": { "PreToolUse": [{ "hookCallbackIds": [PRE_TOOL_USE] }] },
            },
        }));
        let session = Session::new(process, state);
        Ok(if retell { session.retelling() } else { session })
    }

    fn park(&self, conversation_id: String, session: Session) {
        let generation = new_id();
        let idle = Arc::downgrade(&self.idle);
        let stop = tokio::spawn(stop_when_idle(
            idle,
            conversation_id.clone(),
            generation.clone(),
        ))
        .abort_handle();
        self.idle.lock().expect("idle lock").insert(
            conversation_id,
            Parked {
                session,
                generation,
                _stop: IdleStop(stop),
            },
        );
    }
}

fn resumable_state(turn: &Turn) -> Result<Option<ProviderState>> {
    let saved: Option<ProviderState> =
        serde_json::from_value(turn.provider_state()?).unwrap_or(None);
    Ok(saved.filter(|state| state.head.is_some()))
}

async fn stop_when_idle(
    idle: Weak<Mutex<HashMap<String, Parked>>>,
    conversation_id: String,
    generation: String,
) {
    tokio::time::sleep(IDLE).await;
    let Some(idle) = idle.upgrade() else {
        return;
    };
    let stopped = {
        let mut idle = idle.lock().expect("idle lock");
        match idle.get(&conversation_id) {
            Some(parked) if parked.generation == generation => idle.remove(&conversation_id),
            _ => None,
        }
    };
    drop(stopped);
}

impl Provider for Claude {
    fn model(&self) -> &str {
        self.options.model.as_deref().unwrap_or("claude")
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(self.run_turn(turn))
    }
}
