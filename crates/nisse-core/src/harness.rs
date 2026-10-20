use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
};

use anyhow::{Result, anyhow};
use nisse_protocol::{
    Actor, Commit, Conversation, ConversationReadResult, ConversationStatus,
    ConversationSubmitParams, ConversationSubmitResult, Entry, Input, Seq, SubmissionStatus,
    WhenBusy, kinds,
};
use serde_json::json;
use tokio::sync::broadcast;

use crate::{
    model::{Model, ModelResponse},
    new_id,
    store::{Store, Submission, Tx},
    tools::{Hooks, ToolCall, ToolOutcome, run_builtin_tool},
};

const COMMIT_BACKLOG: usize = 4096;

pub struct HarnessOptions {
    pub model: Arc<dyn Model>,
    pub hooks: Arc<dyn Hooks>,
}

/// Runs conversations on a store. Every change is one store commit, published after it is stored.
#[derive(Clone)]
pub struct Harness {
    inner: Arc<Inner>,
}

struct Inner {
    store: Mutex<Store>,
    commits: broadcast::Sender<Commit>,
    running: Mutex<HashSet<String>>,
    model: Arc<dyn Model>,
    hooks: Arc<dyn Hooks>,
}

#[derive(Debug, thiserror::Error)]
pub enum SubmitError {
    #[error("no conversation {0}")]
    NotFound(String),
    #[error("the conversation is busy")]
    Busy,
    #[error("denied: {0}")]
    Denied(String),
    #[error(transparent)]
    Failed(#[from] anyhow::Error),
}

impl Harness {
    pub fn open(path: &Path, options: HarnessOptions) -> Result<Self> {
        Ok(Self::with_store(Store::open(path)?, options))
    }

    pub fn with_store(store: Store, options: HarnessOptions) -> Self {
        let (commits, _) = broadcast::channel(COMMIT_BACKLOG);
        Self {
            inner: Arc::new(Inner {
                store: Mutex::new(store),
                commits,
                running: Mutex::default(),
                model: options.model,
                hooks: options.hooks,
            }),
        }
    }

    /// Continues every run a previous process left unfinished.
    pub fn resume(&self) -> Result<()> {
        let unfinished = self.store().conversations_with_open_submissions()?;
        for conversation_id in unfinished {
            self.wake(&conversation_id);
        }
        Ok(())
    }

    pub fn create_conversation(
        &self,
        title: Option<String>,
        creator: &Actor,
    ) -> Result<Conversation> {
        self.commit(&new_id(), |tx| tx.create_conversation(title, creator))
    }

    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        self.store().conversations()
    }

    /// The conversation's entries after `since_seq`, and the newest commit they reflect.
    pub fn read(&self, conversation_id: &str, since_seq: Seq) -> Result<ConversationReadResult> {
        let store = self.store();
        let conversation = store
            .conversation(conversation_id)?
            .ok_or_else(|| anyhow!("no conversation {conversation_id}"))?;
        let entries = store.entries(conversation_id, since_seq)?;
        Ok(ConversationReadResult {
            conversation,
            entries,
            seq: store.head()?,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Commit> {
        self.inner.commits.subscribe()
    }

    pub async fn submit(
        &self,
        params: ConversationSubmitParams,
        author: Actor,
    ) -> Result<ConversationSubmitResult, SubmitError> {
        let conversation_id = params.conversation_id.clone();
        {
            let store = self.store();
            if store.conversation(&conversation_id)?.is_none() {
                return Err(SubmitError::NotFound(conversation_id));
            }
            if let Some(existing) =
                store.submission_by_request(&conversation_id, &params.request_id)?
            {
                return Ok(ConversationSubmitResult {
                    submission_id: existing.id,
                    status: existing.status,
                });
            }
        }

        let input = match params.input {
            Input::Text { text } => {
                let hooks = self.inner.hooks.clone();
                let text = tokio::task::spawn_blocking(move || hooks.prompt_submit(text))
                    .await
                    .map_err(|error| anyhow!(error))?
                    .map_err(SubmitError::Denied)?;
                Input::Text { text }
            }
            write @ Input::Write { .. } => write,
        };

        if let Input::Write { kind, data } = &input {
            let submission_id = self.commit(&conversation_id, |tx| {
                let id =
                    tx.insert_submission(&params.request_id, params.when_busy, &input, &author)?;
                tx.append(kind, &author, data.clone())?;
                tx.set_submission_status(&id, SubmissionStatus::Answered)?;
                Ok(id)
            })?;
            return Ok(ConversationSubmitResult {
                submission_id,
                status: SubmissionStatus::Answered,
            });
        }

        let is_busy = self
            .inner
            .running
            .lock()
            .expect("running lock")
            .contains(&conversation_id);
        if is_busy && params.when_busy == WhenBusy::Reject {
            return Err(SubmitError::Busy);
        }
        let submission_id = self.commit(&conversation_id, |tx| {
            tx.insert_submission(&params.request_id, params.when_busy, &input, &author)
        })?;
        self.wake(&conversation_id);
        Ok(ConversationSubmitResult {
            submission_id,
            status: SubmissionStatus::Queued,
        })
    }

    fn wake(&self, conversation_id: &str) {
        let is_new_run = self
            .inner
            .running
            .lock()
            .expect("running lock")
            .insert(conversation_id.to_owned());
        if is_new_run {
            let harness = self.clone();
            let conversation_id = conversation_id.to_owned();
            tokio::spawn(async move {
                if let Err(error) = harness.drain(&conversation_id).await {
                    eprintln!("nisse: run in {conversation_id} failed: {error:#}");
                    harness
                        .inner
                        .running
                        .lock()
                        .expect("running lock")
                        .remove(&conversation_id);
                }
            });
        }
    }

    async fn drain(&self, conversation_id: &str) -> Result<()> {
        loop {
            let next = self
                .store()
                .open_submissions(conversation_id)?
                .into_iter()
                .next();
            let Some(submission) = next else {
                let mut running = self.inner.running.lock().expect("running lock");
                if self.store().open_submissions(conversation_id)?.is_empty() {
                    running.remove(conversation_id);
                    self.commit(conversation_id, |tx| {
                        tx.set_status(ConversationStatus::Idle)
                    })?;
                    return Ok(());
                }
                continue;
            };
            self.answer(submission).await?;
        }
    }

    async fn answer(&self, submission: Submission) -> Result<()> {
        let conversation_id = submission.conversation_id.clone();
        if submission.status == SubmissionStatus::Queued {
            self.commit(&conversation_id, |tx| place(tx, &submission))?;
        } else {
            let entries = self.store().entries(&conversation_id, 0)?;
            self.commit(&conversation_id, |tx| {
                interrupt_dangling_tool_call(tx, &entries)
            })?;
        }

        let model_actor = Actor::Model {
            model: self.inner.model.name().to_owned(),
        };
        loop {
            let transcript = self.store().entries(&conversation_id, 0)?;
            let response = match self.inner.model.respond(&transcript).await {
                Ok(response) => response,
                Err(error) => {
                    self.commit(&conversation_id, |tx| {
                        tx.append(
                            kinds::ASSISTANT,
                            &model_actor,
                            json!({ "text": format!("Model error: {error:#}"), "is_error": true }),
                        )?;
                        tx.settle_placed(SubmissionStatus::Unanswered)
                    })?;
                    return Ok(());
                }
            };
            match response {
                ModelResponse::Text(text) => {
                    self.commit(&conversation_id, |tx| {
                        tx.append(kinds::ASSISTANT, &model_actor, json!({ "text": text }))?;
                        tx.settle_placed(SubmissionStatus::Answered)
                    })?;
                    return Ok(());
                }
                ModelResponse::ToolCall(call) => {
                    self.commit(&conversation_id, |tx| {
                        tx.append(kinds::TOOL_CALL, &model_actor, serde_json::to_value(&call)?)
                    })?;
                    let outcome = self.run_tool(call.clone()).await?;
                    let steers: Vec<Submission> = self
                        .store()
                        .open_submissions(&conversation_id)?
                        .into_iter()
                        .filter(|open| {
                            open.status == SubmissionStatus::Queued
                                && open.when_busy == WhenBusy::Steer
                        })
                        .collect();
                    self.commit(&conversation_id, |tx| {
                        tx.append(
                            kinds::TOOL_RESULT,
                            &Actor::System,
                            tool_result(&call, &outcome),
                        )?;
                        steers.iter().try_for_each(|steer| place(tx, steer))
                    })?;
                }
            }
        }
    }

    async fn run_tool(&self, call: ToolCall) -> Result<ToolOutcome> {
        let hooks = self.inner.hooks.clone();
        Ok(tokio::task::spawn_blocking(move || hooks.tool_call(call, &run_builtin_tool)).await?)
    }

    fn commit<T>(
        &self,
        conversation_id: &str,
        write: impl FnOnce(&mut Tx<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut store = self.store();
        let (value, commit) = store.commit(conversation_id, write)?;
        let _ = self.inner.commits.send(commit);
        Ok(value)
    }

    fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.inner.store.lock().expect("store lock")
    }
}

fn place(tx: &mut Tx<'_>, submission: &Submission) -> Result<()> {
    if let Input::Text { text } = &submission.input {
        tx.append(kinds::USER, &submission.author, json!({ "text": text }))?;
    }
    tx.set_submission_status(&submission.id, SubmissionStatus::Placed)?;
    tx.set_status(ConversationStatus::Working)
}

/// A tool call whose result never landed was cut off by a crash. It is not replay-safe, so the
/// model is told it was interrupted.
fn interrupt_dangling_tool_call(tx: &mut Tx<'_>, entries: &[Entry]) -> Result<()> {
    tx.set_status(ConversationStatus::Working)?;
    let Some(last) = entries.last() else {
        return Ok(());
    };
    if last.kind != kinds::TOOL_CALL {
        return Ok(());
    }
    let call: ToolCall = serde_json::from_value(last.data.clone())?;
    let outcome = ToolOutcome::error(
        "interrupted: nisse stopped while this ran; it may or may not have taken effect",
    );
    tx.append(
        kinds::TOOL_RESULT,
        &Actor::System,
        tool_result(&call, &outcome),
    )?;
    Ok(())
}

fn tool_result(call: &ToolCall, outcome: &ToolOutcome) -> serde_json::Value {
    json!({
        "call_id": call.id,
        "name": call.name,
        "output": outcome.output,
        "is_error": outcome.is_error,
        "denied": outcome.denied,
    })
}
