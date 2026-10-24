//! Claude through Claude Code. Claude keeps Claude Code's own tools and agent loop; Nisse speaks
//! the CLI's stream-json control protocol, commits every step through the turn, and resumes
//! Claude's session at the newest message it committed.

mod probe;
mod process;
mod record;
mod session;

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use anyhow::{Result, bail};
use nisse_core::{HealthFuture, Provider, ProviderFuture, SignIn, Turn, new_id};
use nisse_protocol::{AuthInteraction, AuthMethod, AuthResponse, ProviderHealth, kinds};
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
    /// A directory to write each conversation's replay fixture into (`NISSE_RECORD`).
    pub record: Option<PathBuf>,
    /// Claude Code's own config directory, which holds the account (`CLAUDE_CONFIG_DIR`).
    pub config_dir: Option<PathBuf>,
    /// Set for every claude this provider starts.
    pub env: BTreeMap<String, String>,
    /// Added to the command line of every conversation's claude.
    pub args: Vec<String>,
}

impl ClaudeOptions {
    pub fn new(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            record: None,
            config_dir: None,
            env: BTreeMap::new(),
            args: Vec::new(),
        }
    }

    fn env(&self) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = self.env.clone().into_iter().collect();
        if let Some(dir) = &self.config_dir {
            env.push((
                "CLAUDE_CONFIG_DIR".into(),
                dir.to_string_lossy().into_owned(),
            ));
        }
        env
    }
}

pub struct Claude {
    options: ClaudeOptions,
    idle: Arc<Mutex<HashMap<String, Parked>>>,
    health: tokio::sync::Mutex<Option<ProviderHealth>>,
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
            health: tokio::sync::Mutex::default(),
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
        let mut answered = session.answer(turn).await;
        if answered
            .as_ref()
            .is_err_and(|error| error.is::<Unresumable>())
        {
            drop(session);
            session = self.start(turn, None)?;
            answered = session.answer(turn).await;
        }
        if session.auth_failed() {
            self.health.lock().await.take();
        }
        answered?;
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
        if let Some(model) = turn.model() {
            args.extend(["--model".to_owned(), model.to_owned()]);
        }
        args.extend(self.options.args.iter().cloned());
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
                let recorder =
                    Recorder::open(dir, turn.conversation_id(), &state.session, turn.cwd())?;
                recorder.outbound(&json!({ "argv": args }));
                Some(Arc::new(recorder))
            }
            None => None,
        };
        let process = Process::spawn(
            &self.options.binary,
            turn.cwd(),
            &args,
            &self.options.env(),
            recorder,
        )?;
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
    fn driver(&self) -> &str {
        "claude"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(self.run_turn(turn))
    }

    fn health(&self, refresh: bool) -> HealthFuture<'_> {
        Box::pin(async move {
            let mut known = self.health.lock().await;
            if let Some(health) = known.as_ref().filter(|_| !refresh) {
                return health.clone();
            }
            let options = &self.options;
            let health = probe::probe(&options.binary, &options.env()).await;
            *known = Some(health.clone());
            health
        })
    }

    fn sign_in_methods(&self) -> Vec<AuthMethod> {
        vec![AuthMethod::Terminal]
    }

    /// Claude Code keeps its own credentials, so a person signs in with its own command, in a
    /// terminal.
    fn sign_in(&self, _method: AuthMethod, mut flow: SignIn) -> ProviderFuture<'_> {
        Box::pin(async move {
            flow.show(AuthInteraction::Terminal {
                command: self.command(&["auth", "login"]),
                env: self.config_dir_env(),
            });
            loop {
                match flow.response().await {
                    Some(AuthResponse::TerminalExited { success: true }) => return Ok(()),
                    Some(AuthResponse::TerminalExited { success: false }) => {
                        bail!("`claude auth login` did not finish")
                    }
                    Some(AuthResponse::Callback { .. }) => {}
                    None => bail!("nobody is left to sign in"),
                }
            }
        })
    }

    /// Signs Claude Code out and stops every claude still running on the old sign-in.
    fn sign_out(&self) -> ProviderFuture<'_> {
        Box::pin(async move {
            let options = &self.options;
            let status = tokio::process::Command::new(&options.binary)
                .args(["auth", "logout"])
                .envs(options.env())
                .current_dir(std::env::temp_dir())
                .stdin(std::process::Stdio::null())
                .output()
                .await?;
            if !status.status.success() {
                bail!("`claude auth logout` failed ({})", status.status);
            }
            self.idle.lock().expect("idle lock").clear();
            self.health.lock().await.take();
            Ok(())
        })
    }
}

impl Claude {
    fn command(&self, args: &[&str]) -> Vec<String> {
        std::iter::once(self.options.binary.to_string_lossy().into_owned())
            .chain(args.iter().map(|arg| (*arg).to_owned()))
            .collect()
    }

    /// What a sign-in command needs to reach this instance's account, and nothing secret.
    fn config_dir_env(&self) -> BTreeMap<String, String> {
        self.options
            .config_dir
            .iter()
            .map(|dir| {
                (
                    "CLAUDE_CONFIG_DIR".to_owned(),
                    dir.to_string_lossy().into_owned(),
                )
            })
            .collect()
    }
}
