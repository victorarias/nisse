use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{Result, anyhow};
use nisse_protocol::{
    Actor, ApprovalResolveParams, Commit, Conversation, ConversationReadResult,
    ConversationSelectModelParams, ConversationStartParams, ConversationStatus,
    ConversationSubmitParams, ConversationSubmitResult, Entry, Input, ModelSelection, Seq, Skill,
    SubmissionStatus, WhenBusy, kinds,
};
use serde_json::json;
use tokio::sync::{broadcast, oneshot, watch};

use crate::{
    new_id,
    provider::Provider,
    store::{NewConversation, Store, Submission, Tx},
    tools::{Hooks, ToolCall, ToolOutcome},
    turn::{Decision, Turn},
    workspace::{attach, named_skills},
};

const COMMIT_BACKLOG: usize = 4096;
const RESERVED_KINDS: &str = "nisse.";

type Approvals = HashMap<(String, String), oneshot::Sender<Decision>>;

/// Loads the extensions that apply in a directory.
pub type LoadHooks = Arc<dyn Fn(&Path) -> Result<Arc<dyn Hooks>> + Send + Sync>;

/// The model configured for new conversations in a directory, such as a project's
/// `.nisse/config.toml` sets.
pub type DefaultModel = Arc<dyn Fn(&Path) -> Result<Option<ModelSelection>> + Send + Sync>;

pub struct HarnessOptions {
    /// Every provider a conversation can name; the first answers when nothing else chooses.
    pub providers: Vec<(String, Arc<dyn Provider>)>,
    pub hooks: LoadHooks,
    pub default_model: DefaultModel,
}

/// The same extensions in every directory.
pub fn same_hooks(hooks: Arc<dyn Hooks>) -> LoadHooks {
    Arc::new(move |_| Ok(hooks.clone()))
}

/// No configured model anywhere: new conversations take the last selection, else the first
/// provider's default.
pub fn no_default_model() -> DefaultModel {
    Arc::new(|_| Ok(None))
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
    runs: watch::Sender<usize>,
    approvals: Mutex<Approvals>,
    providers: Vec<(String, Arc<dyn Provider>)>,
    load_hooks: LoadHooks,
    hooks: Mutex<HashMap<PathBuf, Arc<dyn Hooks>>>,
    default_model: DefaultModel,
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("{0} is not an absolute path to a directory")]
    NotADirectory(String),
    #[error("no provider named {name}; this server has {known}")]
    UnknownProvider { name: String, known: String },
    #[error("loading extensions: {0:#}")]
    Extensions(anyhow::Error),
    #[error("reading the default model: {0:#}")]
    DefaultModel(anyhow::Error),
    #[error("no conversation {0}")]
    NotFound(String),
    #[error(transparent)]
    Failed(#[from] anyhow::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum SubmitError {
    #[error("no conversation {0}")]
    NotFound(String),
    #[error("the conversation is busy")]
    Busy,
    #[error("denied: {0}")]
    Denied(String),
    #[error("only Nisse writes {0} entries")]
    ReservedKind(String),
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
                runs: watch::Sender::new(0),
                approvals: Mutex::default(),
                providers: options.providers,
                load_hooks: options.hooks,
                hooks: Mutex::default(),
                default_model: options.default_model,
            }),
        }
    }

    /// How many conversations have a run going; it changes as runs start and settle.
    pub fn runs(&self) -> watch::Receiver<usize> {
        self.inner.runs.subscribe()
    }

    /// Continues every run a previous process left unfinished.
    pub fn resume(&self) -> Result<()> {
        let unfinished = self.store().conversations_with_open_submissions()?;
        for conversation_id in unfinished {
            self.wake(&conversation_id);
        }
        Ok(())
    }

    /// Starts a conversation in the client's directory, with the model it chose, or else the
    /// default one. The directory's extensions load first, so a broken one fails the start
    /// instead of the first run.
    pub async fn start_conversation(
        &self,
        params: ConversationStartParams,
        creator: &Actor,
    ) -> Result<Conversation, StartError> {
        if !params.cwd.is_absolute() || !params.cwd.is_dir() {
            return Err(StartError::NotADirectory(params.cwd.display().to_string()));
        }
        let harness = self.clone();
        let cwd = params.cwd.clone();
        let configured = tokio::task::spawn_blocking(move || {
            harness.hooks(&cwd).map_err(StartError::Extensions)?;
            (harness.inner.default_model)(&cwd).map_err(StartError::DefaultModel)
        })
        .await
        .map_err(|error| anyhow!(error))??;
        let default = match configured {
            Some(configured) => configured,
            None => match self.store().last_selection()? {
                Some(last) if self.provider(&last.provider).is_some() => last,
                _ => ModelSelection {
                    provider: self
                        .inner
                        .providers
                        .first()
                        .map_or_else(String::new, |(name, _)| name.clone()),
                    model: None,
                    effort: None,
                },
            },
        };
        let mut selection = chosen(default, params.provider, params.model, params.effort);
        let provider = self.known_provider(&selection.provider)?;
        if selection.model.is_none() {
            selection.model = provider.default_model().map(str::to_owned);
        }
        let start = NewConversation {
            title: params.title,
            creator: creator.clone(),
            cwd: params.cwd,
            selection,
        };
        Ok(self.commit(&new_id(), |tx| tx.create_conversation(start))?)
    }

    /// Switches the conversation's model from its next run on. Anyone in it sees who switched,
    /// and when, in its `nisse.model` entry; choosing the model it already has commits nothing.
    pub fn select_model(
        &self,
        params: ConversationSelectModelParams,
        author: &Actor,
    ) -> Result<Conversation, StartError> {
        let mut selection = params.selection;
        let provider = self.known_provider(&selection.provider)?;
        if selection.model.is_none() {
            selection.model = provider.default_model().map(str::to_owned);
        }
        let Some(mut conversation) = self.store().conversation(&params.conversation_id)? else {
            return Err(StartError::NotFound(params.conversation_id));
        };
        if conversation.selection == selection {
            return Ok(conversation);
        }
        self.commit(&conversation.id, |tx| {
            tx.append(kinds::MODEL, author, serde_json::to_value(&selection)?)?;
            tx.set_selection(&selection)
        })?;
        conversation.selection = selection;
        Ok(conversation)
    }

    fn known_provider(&self, name: &str) -> Result<Arc<dyn Provider>, StartError> {
        self.provider(name)
            .ok_or_else(|| StartError::UnknownProvider {
                name: name.to_owned(),
                known: self
                    .inner
                    .providers
                    .iter()
                    .map(|(name, _)| name.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            })
    }

    /// Every provider a conversation can name, the default first.
    pub fn providers(&self) -> &[(String, Arc<dyn Provider>)] {
        &self.inner.providers
    }

    fn provider(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner
            .providers
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, provider)| provider.clone())
    }

    /// The extensions for `cwd`, loaded the first time a conversation there needs them. Loading
    /// runs extension code, so call this off the async runtime.
    pub(crate) fn hooks(&self, cwd: &Path) -> Result<Arc<dyn Hooks>> {
        let mut loaded = self.inner.hooks.lock().expect("hooks lock");
        if let Some(hooks) = loaded.get(cwd) {
            return Ok(hooks.clone());
        }
        let hooks = (self.inner.load_hooks)(cwd)?;
        loaded.insert(cwd.to_owned(), hooks.clone());
        Ok(hooks)
    }

    /// The skills input in the conversation can name, read from their folders now.
    pub fn skills(&self, conversation_id: &str) -> Result<Vec<Skill>> {
        let conversation = self
            .store()
            .conversation(conversation_id)?
            .ok_or_else(|| anyhow!("no conversation {conversation_id}"))?;
        Ok(self.skills_in(&conversation))
    }

    fn skills_in(&self, conversation: &Conversation) -> Vec<Skill> {
        self.provider(&conversation.selection.provider)
            .map(|provider| provider.skills(&conversation.cwd))
            .unwrap_or_default()
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
            live: store.live(conversation_id)?,
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
        if let Input::Write { kind, .. } = &params.input
            && kind.starts_with(RESERVED_KINDS)
        {
            return Err(SubmitError::ReservedKind(kind.clone()));
        }
        let conversation = {
            let store = self.store();
            let Some(conversation) = store.conversation(&conversation_id)? else {
                return Err(SubmitError::NotFound(conversation_id));
            };
            if let Some(existing) =
                store.submission_by_request(&conversation_id, &params.request_id)?
            {
                return Ok(ConversationSubmitResult {
                    submission_id: existing.id,
                    status: existing.status,
                });
            }
            conversation
        };

        let (input, skills) = match params.input {
            Input::Text { text } => {
                let harness = self.clone();
                let cwd = conversation.cwd.clone();
                let text = tokio::task::spawn_blocking(move || {
                    harness.hooks(&cwd).map(|hooks| hooks.prompt_submit(text))
                })
                .await
                .map_err(|error| anyhow!(error))??
                .map_err(SubmitError::Denied)?;
                let harness = self.clone();
                let named = text.clone();
                let skills = tokio::task::spawn_blocking(move || {
                    named_skills(&named, &harness.skills_in(&conversation))
                        .into_iter()
                        .filter_map(attach)
                        .collect::<Vec<_>>()
                })
                .await
                .map_err(|error| anyhow!(error))?;
                (Input::Text { text }, skills)
            }
            write @ Input::Write { .. } => (write, Vec::new()),
        };

        if let Input::Write { kind, data } = &input {
            let submitted = self.commit(&conversation_id, |tx| {
                if let Some(earlier) = tx.submission_by_request(&params.request_id)? {
                    return Ok(earlier);
                }
                let id = tx.insert_submission(
                    &params.request_id,
                    params.when_busy,
                    &input,
                    &[],
                    &author,
                )?;
                tx.append(kind, &author, data.clone())?;
                tx.set_submission_status(&id, SubmissionStatus::Answered)?;
                Ok(ConversationSubmitResult {
                    submission_id: id,
                    status: SubmissionStatus::Answered,
                })
            })?;
            return Ok(submitted);
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
        let submitted = self.commit(&conversation_id, |tx| {
            if let Some(earlier) = tx.submission_by_request(&params.request_id)? {
                return Ok(earlier);
            }
            Ok(ConversationSubmitResult {
                submission_id: tx.insert_submission(
                    &params.request_id,
                    params.when_busy,
                    &input,
                    &skills,
                    &author,
                )?,
                status: SubmissionStatus::Queued,
            })
        })?;
        self.wake(&conversation_id);
        Ok(submitted)
    }

    fn wake(&self, conversation_id: &str) {
        let is_new_run = {
            let mut running = self.inner.running.lock().expect("running lock");
            let is_new_run = running.insert(conversation_id.to_owned());
            self.inner.runs.send_replace(running.len());
            is_new_run
        };
        if is_new_run {
            let harness = self.clone();
            let conversation_id = conversation_id.to_owned();
            tokio::spawn(async move {
                if let Err(error) = harness.drain(&conversation_id).await {
                    eprintln!("nisse: run in {conversation_id} failed: {error:#}");
                    let mut running = harness.inner.running.lock().expect("running lock");
                    let idle = harness.commit(&conversation_id, |tx| {
                        tx.set_status(ConversationStatus::Idle)
                    });
                    if let Err(error) = idle {
                        eprintln!("nisse: could not mark {conversation_id} idle: {error:#}");
                    }
                    running.remove(&conversation_id);
                    harness.inner.runs.send_replace(running.len());
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
                    self.inner.runs.send_replace(running.len());
                    return Ok(());
                }
                continue;
            };
            self.answer(submission).await?;
        }
    }

    async fn answer(&self, submission: Submission) -> Result<()> {
        let conversation_id = submission.conversation_id.clone();
        let (began, conversation, provider_changed) = self.commit(&conversation_id, |tx| {
            if submission.status == SubmissionStatus::Queued {
                place(tx, &submission)?;
            } else {
                tx.set_status(ConversationStatus::Working)?;
                tx.set_live("")?;
                close_dangling_calls(tx, Cutoff::Restart, 0)?;
            }
            let provider_changed = tx.claim_provider_state()?;
            Ok((tx.seq(), tx.conversation()?, provider_changed))
        })?;

        let selection = &conversation.selection;
        let actor = Actor::Model {
            model: selection
                .model
                .clone()
                .unwrap_or_else(|| selection.provider.clone()),
        };
        let provider = self.provider(&selection.provider);
        let turn = Turn::new(self.clone(), &conversation, actor, provider_changed);
        let ran = match provider {
            Some(provider) => provider.run(&turn).await,
            None => Err(anyhow!(
                "this server has no provider named {}",
                selection.provider
            )),
        };
        let mut approvals = self.approvals();
        approvals.retain(|(asked_in, _), _| *asked_in != conversation_id);
        turn.settled_live(|tx, actor| {
            close_dangling_calls(tx, Cutoff::RunEnded, began)?;
            match &ran {
                Ok(()) => tx.settle_placed(SubmissionStatus::Answered),
                Err(error) => {
                    tx.append(
                        kinds::ASSISTANT,
                        actor,
                        json!({ "text": format!("Model error: {error:#}"), "is_error": true }),
                    )?;
                    tx.settle_placed(SubmissionStatus::Unanswered)
                }
            }
        })
    }

    /// Answers an approval its run still waits for. The first answer wins; later ones, and
    /// answers to asks the run gave up on, are not accepted.
    pub fn resolve(&self, params: ApprovalResolveParams, author: Actor) -> Result<bool> {
        let key = (params.conversation_id.clone(), params.call_id.clone());
        let mut approvals = self.approvals();
        let Some(waiter) = approvals.remove(&key).filter(|waiter| !waiter.is_closed()) else {
            return Ok(false);
        };
        let still_waiting = approvals.iter().any(|((asked_in, _), other)| {
            *asked_in == params.conversation_id && !other.is_closed()
        });
        self.commit(&params.conversation_id, |tx| {
            tx.append(
                kinds::APPROVAL,
                &author,
                json!({ "call_id": params.call_id, "allow": params.allow, "reason": params.reason }),
            )?;
            if !still_waiting {
                tx.set_status(ConversationStatus::Working)?;
            }
            Ok(())
        })?;
        drop(approvals);
        let decision = if params.allow {
            Decision::Allow
        } else {
            let who = match &author {
                Actor::Person { name, .. } => name.clone(),
                _ => "someone".into(),
            };
            Decision::Deny(params.reason.unwrap_or_else(|| format!("{who} declined")))
        };
        let _ = waiter.send(decision);
        Ok(true)
    }

    /// Commits the request and keeps its waiter until it is answered or its run settles.
    pub(crate) fn ask(
        &self,
        conversation_id: &str,
        call_id: &str,
        request: impl FnOnce(&mut Tx<'_>) -> Result<()>,
    ) -> Result<oneshot::Receiver<Decision>> {
        let mut approvals = self.approvals();
        self.commit(conversation_id, request)?;
        let (answer, answered) = oneshot::channel();
        approvals.insert((conversation_id.to_owned(), call_id.to_owned()), answer);
        Ok(answered)
    }

    fn approvals(&self) -> std::sync::MutexGuard<'_, Approvals> {
        self.inner.approvals.lock().expect("approvals lock")
    }

    pub(crate) fn commit<T>(
        &self,
        conversation_id: &str,
        write: impl FnOnce(&mut Tx<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut store = self.store();
        let (value, commit) = store.commit(conversation_id, write)?;
        let _ = self.inner.commits.send(commit);
        Ok(value)
    }

    pub(crate) fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.inner.store.lock().expect("store lock")
    }
}

/// The default selection with what a client chose laid over it. A provider other than the
/// default's starts from that provider's defaults, and a model of its own from that model's.
fn chosen(
    default: ModelSelection,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> ModelSelection {
    match (provider, model) {
        (Some(provider), model) if provider != default.provider => ModelSelection {
            provider,
            model,
            effort,
        },
        (_, Some(model)) => ModelSelection {
            provider: default.provider,
            model: Some(model),
            effort,
        },
        (_, None) => ModelSelection {
            effort: effort.or(default.effort),
            ..default
        },
    }
}

fn place(tx: &mut Tx<'_>, submission: &Submission) -> Result<()> {
    if let Input::Text { text } = &submission.input {
        let mut data = json!({ "text": text });
        if !submission.skills.is_empty() {
            data["skills"] = serde_json::to_value(&submission.skills)?;
        }
        tx.append(kinds::USER, &submission.author, data)?;
    }
    tx.set_submission_status(&submission.id, SubmissionStatus::Placed)?;
    tx.set_status(ConversationStatus::Working)
}

pub(crate) fn is_steer(open: &Submission) -> bool {
    open.status == SubmissionStatus::Queued && open.when_busy == WhenBusy::Steer
}

pub(crate) fn place_steers(tx: &mut Tx<'_>) -> Result<()> {
    let steers: Vec<Submission> = tx
        .open_submissions()?
        .into_iter()
        .filter(is_steer)
        .collect();
    steers.iter().try_for_each(|steer| place(tx, steer))
}

#[derive(Clone, Copy)]
enum Cutoff {
    Restart,
    RunEnded,
}

impl Cutoff {
    fn not_run(self) -> &'static str {
        match self {
            Self::Restart => "not run: nisse restarted before this call was approved",
            Self::RunEnded => "not run: the run ended before this call was approved",
        }
    }

    fn interrupted(self) -> &'static str {
        match self {
            Self::Restart => {
                "interrupted: nisse stopped while this ran; it may or may not have taken effect"
            }
            Self::RunEnded => {
                "interrupted: the run ended while this ran; it may or may not have taken effect"
            }
        }
    }
}

/// Gives every call after `since` left without a result one, marked `cut_off`, so no client
/// offers it and the model hears how it ended. One that was still waiting for approval never
/// ran; any other is not replay-safe, so the model is told it was interrupted.
fn close_dangling_calls(tx: &mut Tx<'_>, cutoff: Cutoff, since: Seq) -> Result<()> {
    let entries = tx.entries_since(since)?;
    let call_ids = |kind: &str| -> HashSet<String> {
        entries
            .iter()
            .filter(|entry| entry.kind == kind)
            .filter_map(|entry| entry.data["call_id"].as_str().map(str::to_owned))
            .collect()
    };
    let finished = call_ids(kinds::TOOL_RESULT);
    let asked = call_ids(kinds::APPROVAL_REQUEST);
    let approved_or_denied = call_ids(kinds::APPROVAL);
    let mut dangling: Vec<ToolCall> = Vec::new();
    for entry in &entries {
        let call = match entry.kind.as_str() {
            kinds::TOOL_CALL => serde_json::from_value(entry.data.clone())?,
            kinds::APPROVAL_REQUEST => ToolCall {
                id: entry.data["call_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                name: entry.data["name"].as_str().unwrap_or_default().to_owned(),
                args: entry.data["args"].clone(),
                parent: entry.data["parent"].as_str().map(str::to_owned),
            },
            _ => continue,
        };
        if !finished.contains(&call.id) && dangling.iter().all(|seen| seen.id != call.id) {
            dangling.push(call);
        }
    }
    for call in dangling {
        let waited_for_approval =
            asked.contains(&call.id) && !approved_or_denied.contains(&call.id);
        let outcome = ToolOutcome::error(if waited_for_approval {
            cutoff.not_run().to_owned()
        } else {
            with_nested_results(cutoff.interrupted(), &call.id, &entries)
        });
        let mut result = tool_result(&call, &outcome);
        result["cut_off"] = true.into();
        tx.append(kinds::TOOL_RESULT, &Actor::System, result)?;
    }
    Ok(())
}

/// `interrupted`, followed by the results of the calls `parent` made that finished, so the model
/// knows what a cut-off script already did.
pub fn with_nested_results(interrupted: &str, parent: &str, entries: &[Entry]) -> String {
    let nested: Vec<String> = entries
        .iter()
        .filter(|entry| entry.kind == kinds::TOOL_RESULT && entry.data["parent"] == parent)
        .map(|result| {
            format!(
                "- {} ({}): {}",
                result.data["name"].as_str().unwrap_or_default(),
                if result.data["is_error"] == true {
                    "failed"
                } else {
                    "done"
                },
                result.data["output"]
                    .as_str()
                    .unwrap_or_default()
                    .trim_end()
            )
        })
        .collect();
    if nested.is_empty() {
        return interrupted.to_owned();
    }
    format!(
        "{interrupted}\nThe calls it made that finished:\n{}",
        nested.join("\n")
    )
}

pub(crate) fn tool_result(call: &ToolCall, outcome: &ToolOutcome) -> serde_json::Value {
    let mut result = json!({
        "call_id": call.id,
        "name": call.name,
        "output": outcome.output,
        "is_error": outcome.is_error,
        "denied": outcome.denied,
    });
    if let Some(parent) = &call.parent {
        result["parent"] = parent.clone().into();
    }
    result
}
