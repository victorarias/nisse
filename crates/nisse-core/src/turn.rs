use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, anyhow};
use nisse_protocol::{Actor, ConversationStatus, Entry, SubmissionStatus, kinds};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::{
    harness::{Harness, place_steers, tool_result},
    tools::{ToolCall, ToolOutcome},
};

/// Streamed text is committed at most this often, so a crash loses at most this much of it.
pub const LIVE_INTERVAL: Duration = Duration::from_millis(100);

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
    actor: Actor,
    live: Arc<Mutex<Live>>,
}

#[derive(Default)]
struct Live {
    pending: Option<String>,
    flushing: bool,
}

impl Turn {
    pub(crate) fn new(harness: Harness, conversation_id: String, actor: Actor) -> Self {
        Self {
            harness,
            conversation_id,
            actor,
            live: Arc::default(),
        }
    }

    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    pub fn transcript(&self) -> Result<Vec<Entry>> {
        self.harness.store().entries(&self.conversation_id, 0)
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
        self.settled_live(|tx, actor| {
            tx.append(kinds::ASSISTANT, actor, json!({ "text": text }))?;
            Ok(())
        })
    }

    /// The model's final message: it answers every input the run placed.
    pub fn answer(&self, text: &str) -> Result<()> {
        self.settled_live(|tx, actor| {
            tx.append(kinds::ASSISTANT, actor, json!({ "text": text }))?;
            tx.settle_placed(SubmissionStatus::Answered)
        })
    }

    fn settled_live<T>(
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
    /// approval, then commits its result together with any steers that arrived meanwhile.
    pub async fn call_tool<F>(
        &self,
        call: ToolCall,
        approval: Approval,
        run: F,
    ) -> Result<ToolOutcome>
    where
        F: FnOnce(ToolCall) -> ToolOutcome + Send + 'static,
    {
        self.settled_live(|tx, actor| {
            tx.append(kinds::TOOL_CALL, actor, serde_json::to_value(&call)?)?;
            Ok(())
        })?;
        let hooks = self.harness.hooks();
        let committed_call = call.clone();
        let (asks, mut asked) = mpsc::unbounded_channel::<(ToolCall, oneshot::Sender<Decision>)>();
        let mut ran = tokio::task::spawn_blocking(move || {
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
            place_steers(tx)
        })?;
        Ok(outcome)
    }

    /// Asks the people in the conversation whether `call` may run, and waits for the first answer.
    pub async fn ask(&self, call: &ToolCall, reason: Option<String>) -> Result<Decision> {
        let (answer, answered) = oneshot::channel();
        self.harness
            .wait_for_approval(&self.conversation_id, &call.id, answer);
        self.harness.commit(&self.conversation_id, |tx| {
            tx.append(
                kinds::APPROVAL_REQUEST,
                &self.actor,
                json!({ "call_id": call.id, "name": call.name, "args": call.args, "reason": reason }),
            )?;
            tx.set_status(ConversationStatus::NeedsApproval)
        })?;
        answered
            .await
            .map_err(|_| anyhow!("the approval was abandoned"))
    }
}
