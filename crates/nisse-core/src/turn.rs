use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, anyhow};
use nisse_protocol::{
    Actor, Conversation, ConversationStatus, Entry, Lineage, ModelSelection, Seq, SubmissionStatus,
    kinds,
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use crate::{
    agents::{self, AgentType},
    harness::{Harness, is_steer, place_steers, tool_result},
    tools::{CallContext, ToolCall, ToolOutcome, ToolSpec},
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
    effort: Option<String>,
    lineage: Option<Lineage>,
    provider_changed: bool,
    actor: Actor,
    live: Arc<Mutex<Live>>,
    stopped: watch::Receiver<bool>,
}

#[derive(Default)]
struct Live {
    pending: Option<String>,
    flushing: bool,
}

impl Turn {
    pub(crate) fn new(
        harness: Harness,
        conversation: &Conversation,
        actor: Actor,
        provider_changed: bool,
        stopped: watch::Receiver<bool>,
    ) -> Self {
        Self {
            harness,
            conversation_id: conversation.id.clone(),
            cwd: conversation.cwd.clone(),
            model: conversation.selection.model.clone(),
            effort: conversation.selection.effort.clone(),
            lineage: conversation.lineage.clone(),
            provider_changed,
            actor,
            live: Arc::default(),
            stopped,
        }
    }

    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    /// Where the conversation comes from, when it is a subagent.
    pub fn lineage(&self) -> Option<&Lineage> {
        self.lineage.as_ref()
    }

    pub(crate) fn harness(&self) -> &Harness {
        &self.harness
    }

    pub(crate) fn actor(&self) -> &Actor {
        &self.actor
    }

    /// Returns once someone stops the run.
    pub async fn stopped(&self) {
        let mut stopped = self.stopped.clone();
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }

    /// The tools that start and steer subagents, for a provider whose model runs them: a
    /// subagent at the deepest level allowed starts none.
    pub fn agent_tools(&self, types: &[AgentType]) -> Vec<ToolSpec> {
        let may_spawn = agents::depth(self.lineage()) < self.harness.limits().max_depth;
        agents::tool_specs(types, may_spawn)
    }

    /// Runs an agent tool's call. Call it off the async runtime, as `call_tool` does.
    pub fn run_agent_tool(&self) -> impl FnOnce(ToolCall) -> ToolOutcome + Send + 'static {
        let turn = self.clone();
        let runtime = tokio::runtime::Handle::current();
        move |call| runtime.block_on(agents::run(&turn, &call))
    }

    /// Whether this conversation may start another subagent now, and why not.
    pub fn may_spawn(&self) -> Result<(), String> {
        let limits = self.harness.limits();
        if agents::depth(self.lineage()) >= limits.max_depth {
            return Err(format!(
                "agents nest at most {} deep here; do this task yourself",
                limits.max_depth
            ));
        }
        let conversation = self
            .harness
            .conversation(&self.conversation_id)
            .map_err(|error| format!("{error:#}"))?;
        let family = self
            .harness
            .family(&conversation)
            .map_err(|error| format!("{error:#}"))?;
        let store = self.harness.store();
        let mut live = 0;
        for agent in family.iter().filter(|agent| agent.lineage.is_some()) {
            let starting = store
                .open_submissions(&agent.id)
                .map_err(|error| format!("{error:#}"))?
                .iter()
                .any(|open| open.starts_a_run());
            if agent.status != ConversationStatus::Idle || starting {
                live += 1;
            }
        }
        if live >= limits.max_threads {
            return Err(format!(
                "{live} agents already run here, the most allowed; wait for one to finish"
            ));
        }
        Ok(())
    }

    /// Starts a subagent this run's provider runs itself, as Claude Code runs its own, for the
    /// call `call_id`: a conversation under this one that hears `prompt` from it. Its turn
    /// commits what the subagent does.
    pub fn start_hosted(
        &self,
        call_id: &str,
        title: &str,
        agent_type: Option<&str>,
        prompt: &str,
    ) -> Result<Turn> {
        let parent = self.harness.conversation(&self.conversation_id)?;
        let lineage = Lineage {
            parent: parent.id.clone(),
            root: parent
                .lineage
                .as_ref()
                .map_or_else(|| parent.id.clone(), |lineage| lineage.root.clone()),
            call_id: call_id.to_owned(),
            task: None,
            agent_type: agent_type.map(str::to_owned),
            hosted: true,
            forked_at: None,
        };
        let selection = ModelSelection {
            effort: None,
            ..parent.selection.clone()
        };
        let child = self
            .harness
            .start_child(&parent, title, selection, lineage, &self.actor)?;
        let author = Actor::Agent {
            conversation_id: parent.id.clone(),
        };
        self.harness.commit(&child.id, |tx| {
            tx.append(kinds::USER, &author, json!({ "text": prompt }))?;
            tx.set_status(ConversationStatus::Working)
        })?;
        Ok(Turn::new(
            self.harness.clone(),
            &child,
            self.actor.clone(),
            false,
            self.stopped.clone(),
        ))
    }

    /// The hosted subagent this turn commits for is done; `text` is its last word, committed
    /// unless it already said so.
    pub fn finish_hosted(&self, text: Option<&str>) -> Result<()> {
        let said = self.entries_since(0)?;
        let last = said
            .iter()
            .rev()
            .find(|entry| entry.kind == kinds::ASSISTANT)
            .and_then(|entry| entry.data["text"].as_str());
        self.settled_live(|tx, actor| {
            if let Some(text) = text.filter(|text| !text.trim().is_empty() && Some(*text) != last) {
                tx.append(kinds::ASSISTANT, actor, json!({ "text": text }))?;
            }
            tx.set_status(ConversationStatus::Idle)
        })
    }
    /// The conversation's directory: tools run here.
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// The model the conversation chose; absent when the provider picks.
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    /// The reasoning effort the conversation chose; absent for the model's own default.
    pub fn effort(&self) -> Option<&str> {
        self.effort.as_deref()
    }

    /// Another provider answered the conversation since this one last did: whatever this one
    /// kept of it, beyond its provider state, misses that part.
    pub fn provider_changed(&self) -> bool {
        self.provider_changed
    }

    /// What the model hears: the conversation, after whatever a subagent inherited from the
    /// conversations it was forked from.
    pub fn transcript(&self) -> Result<Vec<Entry>> {
        let store = self.harness.store();
        let mut inherited: Vec<Vec<Entry>> = Vec::new();
        let mut lineage = self.lineage.clone();
        while let Some(Lineage {
            parent,
            forked_at: Some(forked_at),
            ..
        }) = lineage
        {
            let mut before = store.entries(&parent, 0)?;
            before.retain(|entry| entry.seq < forked_at);
            inherited.push(before);
            lineage = store
                .conversation(&parent)?
                .and_then(|parent| parent.lineage);
        }
        let mut transcript: Vec<Entry> = inherited.into_iter().rev().flatten().collect();
        transcript.extend(store.entries(&self.conversation_id, 0)?);
        Ok(transcript)
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
        let context = CallContext {
            conversation_id: self.conversation_id.clone(),
            parent: self.lineage.as_ref().map(|lineage| lineage.parent.clone()),
        };
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
            hooks.tool_call(&context, call, &|call| {
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
