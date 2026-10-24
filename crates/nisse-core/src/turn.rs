use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, anyhow};
use nisse_protocol::{
    Actor, Conversation, ConversationStatus, Entry, Seq, SubmissionStatus, kinds,
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::{
    harness::{Harness, is_steer, place_steers, tool_result},
    tools::{ToolCall, ToolOutcome},
};

/// Streamed text is committed at most this often, so every client sees it at most this late.
pub const LIVE_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    NotNeeded,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny(String),
}

/// A provider's handle on the run it answers. Everything it does is committed through here.
#[derive(Clone)]
pub struct Turn {
    harness: Harness,
    conversation_id: String,
    cwd: PathBuf,
    model: Option<String>,
    actor: Actor,
    live: Arc<Mutex<Live>>,
}

#[derive(Default)]
struct Live {
    pending: Option<String>,
    flushing: bool,
}

impl Turn {
    pub(crate) fn new(harness: Harness, conversation: &Conversation, actor: Actor) -> Self {
        Self {
            harness,
            conversation_id: conversation.id.clone(),
            cwd: conversation.cwd.clone(),
            model: conversation.model.clone(),
            actor,
            live: Arc::default(),
        }
    }

    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    /// The conversation's directory: tools run here.
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// The model the conversation chose; absent when the provider picks.
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn transcript(&self) -> Result<Vec<Entry>> {
        self.entries_since(0)
    }

    pub fn entries_since(&self, since_seq: Seq) -> Result<Vec<Entry>> {
        self.harness
            .store()
            .entries(&self.conversation_id, since_seq)
    }

    pub fn provider_state(&self) -> Result<Value> {
        self.harness.store().provider_state(&self.conversation_id)
    }

    pub fn set_provider_state(&self, state: &Value) -> Result<()> {
        self.harness
            .commit(&self.conversation_id, |tx| tx.set_provider_state(state))
    }

    /// The text the model has written so far in its current message.
    pub fn stream(&self, text: &str) {
        let mut live = self.live.lock().expect("live lock");
        live.pending = Some(text.to_owned());
        if live.flushing {
            return;
        }
        live.flushing = true;
        let turn = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(LIVE_INTERVAL).await;
            let mut live = turn.live.lock().expect("live lock");
            live.flushing = false;
            if let Some(text) = live.pending.take() {
                let committed = turn
                    .harness
                    .commit(&turn.conversation_id, |tx| tx.set_live(&text));
                if let Err(error) = committed {
                    eprintln!("nisse: could not commit streamed text: {error:#}");
                }
            }
        });
    }

    /// One finished message from the model, in the middle of a run.
    pub fn say(&self, text: &str) -> Result<()> {
        self.say_with_state(text, None)
    }

    /// `say`, committing `provider_state` with the message when there is one.
    pub fn say_with_state(&self, text: &str, provider_state: Option<&Value>) -> Result<()> {
        self.settled_live(|tx, actor| {
            tx.append(kinds::ASSISTANT, actor, json!({ "text": text }))?;
            provider_state.map_or(Ok(()), |state| tx.set_provider_state(state))
        })
    }

    /// The model's final message: it answers every input the run placed.
    pub fn answer(&self, text: &str) -> Result<()> {
        self.settled_live(|tx, actor| {
            tx.append(kinds::ASSISTANT, actor, json!({ "text": text }))?;
            tx.settle_placed(SubmissionStatus::Answered)
        })
    }

    pub(crate) fn settled_live<T>(
        &self,
        write: impl FnOnce(&mut crate::store::Tx<'_>, &Actor) -> Result<T>,
    ) -> Result<T> {
        let mut live = self.live.lock().expect("live lock");
        live.pending = None;
        self.harness.commit(&self.conversation_id, |tx| {
            tx.set_live("")?;
            write(tx, &self.actor)
        })
    }

    /// Commits the call, runs it through the extensions' `tool.call` hooks and, when asked, an
    /// approval, then commits its result.
    pub async fn call_tool<F>(
        &self,
        call: ToolCall,
        approval: Approval,
        run: F,
    ) -> Result<ToolOutcome>
    where
        F: FnOnce(ToolCall) -> ToolOutcome + Send + 'static,
    {
        self.call_tool_with_state(call, approval, run, || Ok(None))
            .await
    }

    /// `call_tool`, committing the provider state `provider_state` returns, when it returns
    /// one, together with the call and again with its result. It is asked as each of the two
    /// is committed.
    pub async fn call_tool_with_state<F, S>(
        &self,
        call: ToolCall,
        approval: Approval,
        run: F,
        mut provider_state: S,
    ) -> Result<ToolOutcome>
    where
        F: FnOnce(ToolCall) -> ToolOutcome + Send + 'static,
        S: FnMut() -> Result<Option<Value>> + Send,
    {
        let mut keep_provider_state = |tx: &mut crate::store::Tx<'_>| match provider_state()? {
            Some(state) => tx.set_provider_state(&state),
            None => Ok(()),
        };
        self.settled_live(|tx, actor| {
            tx.append(kinds::TOOL_CALL, actor, serde_json::to_value(&call)?)?;
            keep_provider_state(tx)
        })?;
        let harness = self.harness.clone();
        let cwd = self.cwd.clone();
        let committed_call = call.clone();
        let (asks, mut asked) = mpsc::unbounded_channel::<(ToolCall, oneshot::Sender<Decision>)>();
        let mut ran = tokio::task::spawn_blocking(move || {
            let hooks = match harness.hooks(&cwd) {
                Ok(hooks) => hooks,
                Err(error) => {
                    return ToolOutcome::error(format!("could not load extensions: {error:#}"));
                }
            };
            let run = Mutex::new(Some(run));
            hooks.tool_call(call, &|call| {
                if let Approval::Ask = approval {
                    let (answer, answered) = oneshot::channel();
                    let _ = asks.send((call.clone(), answer));
                    match answered.blocking_recv() {
                        Ok(Decision::Allow) => {}
                        Ok(Decision::Deny(reason)) => return ToolOutcome::denied(reason),
                        Err(_) => return ToolOutcome::error("the approval was abandoned"),
                    }
                }
                match run.lock().expect("run lock").take() {
                    Some(run) => run(call),
                    None => ToolOutcome::error("this call already ran"),
                }
            })
        });
        let outcome = loop {
            tokio::select! {
                outcome = &mut ran => break outcome?,
                Some((call, answer)) = asked.recv() => {
                    let _ = answer.send(self.ask(&call, None).await?);
                }
            }
        };
        self.harness.commit(&self.conversation_id, |tx| {
            tx.append(
                kinds::TOOL_RESULT,
                &Actor::System,
                tool_result(&committed_call, &outcome),
            )?;
            keep_provider_state(tx)
        })?;
        Ok(outcome)
    }

    /// Steers wait for the model's round of tool calls to end: call this once every call of the
    /// round has its result, and the steers that arrived meanwhile join the run.
    pub fn place_steers(&self) -> Result<()> {
        let waiting = self
            .harness
            .store()
            .open_submissions(&self.conversation_id)?
            .iter()
            .any(is_steer);
        if !waiting {
            return Ok(());
        }
        self.harness.commit(&self.conversation_id, place_steers)
    }

    /// Asks the people in the conversation whether `call` may run, and waits for the first answer.
    pub async fn ask(&self, call: &ToolCall, reason: Option<String>) -> Result<Decision> {
        let answered = self.harness.ask(&self.conversation_id, &call.id, |tx| {
            tx.append(
                kinds::APPROVAL_REQUEST,
                &self.actor,
                json!({
                    "call_id": call.id,
                    "name": call.name,
                    "args": call.args,
                    "reason": reason,
                    "parent": call.parent,
                }),
            )?;
            tx.set_status(ConversationStatus::NeedsApproval)
        })?;
        answered
            .await
            .map_err(|_| anyhow!("the approval was abandoned"))
    }
}
