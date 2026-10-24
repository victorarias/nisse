//! Nisse's terminal UI: a client of the app server that draws only when something changed.

mod gnome;
mod host;
mod picker;
mod theme;
mod view;

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use anyhow::Result;
use nisse_client::Client;
use nisse_protocol::{
    ApprovalResolveParams, ApprovalResolveResult, AuthAccepted, AuthCancelParams, AuthInteraction,
    AuthMethod, AuthPhase, AuthRespondParams, AuthResponse, AuthStartParams, AuthState,
    ClientRequest, Commit, Conversation, ConversationInterruptParams, ConversationInterruptResult,
    ConversationReadResult, ConversationSelectModelParams, ConversationStartParams,
    ConversationStatus, ConversationSubmitParams, ConversationSubmitResult,
    ConversationSubscribeParams, Entry, Input, ModelSelection, ModelsListParams, ModelsListResult,
    ProviderModels, ProviderSnapshot, ProviderStatus, ProvidersListParams, ProvidersListResult,
    Seq, ServerNotification, StatusChanged, UiChanged, WhenBusy, kinds,
};
use ratatui::{
    Terminal,
    backend::Backend,
    crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    widgets::Clear,
};
use tokio::sync::mpsc;

use crate::picker::Picker;

pub use host::Host;
pub use theme::Theme;

const SPINNER_FRAME: Duration = Duration::from_millis(1000 / 12);
const TOAST_LIFETIME: Duration = Duration::from_secs(4);

pub struct App {
    conversation: Conversation,
    entries: Vec<Entry>,
    live: String,
    status: ConversationStatus,
    working_since: Option<Instant>,
    extension_status: Vec<(String, String)>,
    toast: Option<(String, Instant)>,
    input: String,
    scroll: view::Scroll,
    frame: usize,
    error: Option<String>,
    providers: Vec<ProviderSnapshot>,
    /// The newest sign-in any client runs, until it ends.
    sign_in: Option<AuthState>,
    /// The sign-in this client started, which it alone opens a browser or a terminal for.
    started: Option<String>,
    listed: mpsc::UnboundedSender<Vec<ProviderSnapshot>>,
    /// The `/model` picker, while it is open.
    picker: Option<Picker>,
    models: mpsc::UnboundedSender<Vec<ProviderModels>>,
    /// The subagents this conversation started, and theirs, by conversation id.
    subagents: HashMap<String, Subagent>,
    followed: mpsc::UnboundedSender<ConversationReadResult>,
}

/// A subagent as far as this client has heard: what it committed, and its status as of
/// `status_seq`.
struct Subagent {
    status: ConversationStatus,
    status_seq: Seq,
    entries: Vec<Entry>,
}

impl Subagent {
    fn on_snapshot(&mut self, snapshot: ConversationReadResult) {
        let later = std::mem::take(&mut self.entries)
            .into_iter()
            .filter(|entry| entry.seq > snapshot.seq);
        self.entries = snapshot.entries.into_iter().chain(later).collect();
        if snapshot.seq >= self.status_seq {
            self.status_seq = snapshot.seq;
            self.status = snapshot.conversation.status;
        }
    }

    fn on_commit(&mut self, commit: Commit) {
        let newest = self.entries.last().map_or(0, |entry| entry.seq);
        self.entries.extend(
            commit
                .entries
                .into_iter()
                .filter(|entry| entry.seq > newest),
        );
    }

    fn on_status(&mut self, changed: &StatusChanged) {
        if changed.seq >= self.status_seq {
            self.status_seq = changed.seq;
            self.status = changed.status;
        }
    }
}

/// Which conversation the TUI shows.
pub enum Open {
    Existing(String),
    New(ConversationStartParams),
}

/// Takes over the process's terminal until the user quits. A `notice` shows where errors do.
pub async fn run(
    client: Client,
    notifications: mpsc::UnboundedReceiver<ServerNotification>,
    open: Open,
    notice: Option<String>,
    theme: Theme,
) -> Result<()> {
    let mut terminal = ratatui::init();
    let outcome = drive(
        &mut terminal,
        host::Tty::new(),
        client,
        notifications,
        open,
        notice,
        theme,
    )
    .await;
    ratatui::restore();
    outcome
}

/// Draws on `terminal` and follows `host`'s events until the user quits or the host has no more.
pub async fn drive<B: Backend>(
    terminal: &mut Terminal<B>,
    mut host: impl Host,
    client: Client,
    mut notifications: mpsc::UnboundedReceiver<ServerNotification>,
    open: Open,
    notice: Option<String>,
    theme: Theme,
) -> Result<()>
where
    B::Error: Send + Sync + 'static,
{
    let conversation = match open {
        Open::Existing(id) => {
            client
                .request::<ConversationReadResult>(ClientRequest::ConversationRead(
                    nisse_protocol::ConversationReadParams {
                        conversation_id: id,
                        since_seq: 0,
                    },
                ))
                .await?
                .conversation
        }
        Open::New(start) => {
            client
                .request(ClientRequest::ConversationStart(start))
                .await?
        }
    };
    let snapshot: ConversationReadResult = client
        .request(ClientRequest::ConversationSubscribe(
            ConversationSubscribeParams {
                conversation_id: conversation.id.clone(),
                since_seq: 0,
            },
        ))
        .await?;
    let (listed, mut lists) = mpsc::unbounded_channel();
    let (models, mut model_lists) = mpsc::unbounded_channel();
    let (followed, mut follows) = mpsc::unbounded_channel();
    let mut app = App {
        status: snapshot.conversation.status,
        working_since: (snapshot.conversation.status == ConversationStatus::Working)
            .then(Instant::now),
        conversation,
        entries: snapshot.entries,
        live: snapshot.live,
        extension_status: Vec::new(),
        toast: None,
        input: String::new(),
        scroll: view::Scroll::default(),
        frame: 0,
        error: notice,
        providers: Vec::new(),
        sign_in: None,
        started: None,
        listed,
        picker: None,
        models,
        subagents: HashMap::new(),
        followed,
    };
    app.list_providers(&client);
    app.follow_subagents(&client);

    loop {
        let mut scroll = app.scroll;
        terminal.draw(|frame| scroll = view::draw(frame, &app, &theme))?;
        app.scroll = scroll;
        let tick = app.next_tick();
        tokio::select! {
            event = host.next_event() => match event {
                Some(event) => {
                    if app.on_event(event, &client, &host).await? {
                        return Ok(());
                    }
                }
                None => return Ok(()),
            },
            Some(notification) = notifications.recv() => {
                if let Some((command, env)) = app.on_notification(notification, &client, &mut host) {
                    let success = host.foreground(&command, &env).await;
                    terminal.draw(|frame| frame.render_widget(Clear, frame.area()))?;
                    app.respond(&client, AuthResponse::TerminalExited { success }).await;
                }
            }
            Some(providers) = lists.recv() => app.providers = providers,
            Some(snapshot) = follows.recv() => app.on_followed(snapshot, &client),
            Some(models) = model_lists.recv() => {
                if let Some(picker) = &mut app.picker {
                    picker.list(models, &app.conversation.selection);
                }
            }
            _ = sleep_until(tick) => app.on_tick(),
        }
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}

impl App {
    /// Only a running spinner or a fading toast needs time to pass; idle, the UI sleeps.
    fn next_tick(&self) -> Option<Instant> {
        let spinner = self.working_since.map(|_| Instant::now() + SPINNER_FRAME);
        let toast = self
            .toast
            .as_ref()
            .map(|(_, shown)| *shown + TOAST_LIFETIME);
        spinner.into_iter().chain(toast).min()
    }

    fn on_tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);
        if self
            .toast
            .as_ref()
            .is_some_and(|(_, shown)| shown.elapsed() >= TOAST_LIFETIME)
        {
            self.toast = None;
        }
    }

    /// Lists the providers in the background: checking them can take a few seconds.
    fn list_providers(&self, client: &Client) {
        let client = client.clone();
        let listed = self.listed.clone();
        tokio::spawn(async move {
            let request = ClientRequest::ProvidersList(ProvidersListParams::default());
            if let Ok(list) = client.request::<ProvidersListResult>(request).await {
                let _ = listed.send(list.providers);
            }
        });
    }

    /// Subscribes to each subagent a followed conversation started that this client does not
    /// follow yet.
    fn follow_subagents(&mut self, client: &Client) {
        let started: Vec<String> = std::iter::once(&self.entries)
            .chain(self.subagents.values().map(|subagent| &subagent.entries))
            .flatten()
            .filter(|entry| entry.kind == kinds::SUBAGENT)
            .filter_map(|entry| entry.data["conversation_id"].as_str())
            .filter(|id| !self.subagents.contains_key(*id))
            .map(str::to_owned)
            .collect();
        for conversation_id in started {
            self.subagents.insert(
                conversation_id.clone(),
                Subagent {
                    status_seq: 0,
                    status: ConversationStatus::Working,
                    entries: Vec::new(),
                },
            );
            let client = client.clone();
            let followed = self.followed.clone();
            tokio::spawn(async move {
                let request = ClientRequest::ConversationSubscribe(ConversationSubscribeParams {
                    conversation_id,
                    since_seq: 0,
                });
                if let Ok(snapshot) = client.request::<ConversationReadResult>(request).await {
                    let _ = followed.send(snapshot);
                }
            });
        }
    }

    fn on_followed(&mut self, snapshot: ConversationReadResult, client: &Client) {
        if let Some(subagent) = self.subagents.get_mut(&snapshot.conversation.id) {
            subagent.on_snapshot(snapshot);
            self.follow_subagents(client);
        }
    }

    /// The oldest approval waiting here, else in a subagent, as `(conversation, call)`.
    fn pending_approval(&self) -> Option<(&str, &str)> {
        if let Some(call_id) = view::pending_approval(&self.entries) {
            return Some((&self.conversation.id, call_id));
        }
        self.subagents.iter().find_map(|(id, subagent)| {
            view::pending_approval(&subagent.entries).map(|call_id| (id.as_str(), call_id))
        })
    }

    /// Lists every provider's models in the background, for the picker.
    fn list_models(&self, client: &Client) {
        let client = client.clone();
        let models = self.models.clone();
        tokio::spawn(async move {
            let request = ClientRequest::ModelsList(ModelsListParams::default());
            if let Ok(list) = client.request::<ModelsListResult>(request).await {
                let _ = models.send(list.providers);
            }
        });
    }

    async fn select_model(&mut self, client: &Client, selection: ModelSelection) {
        let selected = client
            .request::<Conversation>(ClientRequest::ConversationSelectModel(
                ConversationSelectModelParams {
                    conversation_id: self.conversation.id.clone(),
                    selection,
                },
            ))
            .await;
        match selected {
            Ok(conversation) => {
                self.conversation.selection = conversation.selection;
                self.error = None;
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    /// Returns true when the key went to the open picker.
    async fn on_picker_key(&mut self, code: KeyCode, client: &Client) -> bool {
        let Some(picker) = &mut self.picker else {
            return false;
        };
        match code {
            KeyCode::Up => picker.up(),
            KeyCode::Down => picker.down(),
            KeyCode::Left => picker.step_effort(false),
            KeyCode::Right | KeyCode::Tab => picker.step_effort(true),
            KeyCode::Esc => self.picker = None,
            KeyCode::Enter => {
                if let Some(selection) = picker.chosen() {
                    self.picker = None;
                    self.select_model(client, selection).await;
                }
            }
            _ => {}
        }
        true
    }

    /// The command to hand the terminal to, when this client's sign-in asks for one.
    fn on_notification(
        &mut self,
        notification: ServerNotification,
        client: &Client,
        host: &mut impl Host,
    ) -> Option<(Vec<String>, std::collections::BTreeMap<String, String>)> {
        match notification {
            ServerNotification::AuthState(state) => return self.on_sign_in(state, client, host),
            ServerNotification::Committed(commit)
                if commit.conversation_id == self.conversation.id =>
            {
                if let Some(live) = commit.live {
                    self.live = live;
                }
                if !commit.entries.is_empty() {
                    for entry in &commit.entries {
                        if entry.kind == kinds::MODEL
                            && let Ok(selection) = serde_json::from_value(entry.data.clone())
                        {
                            self.conversation.selection = selection;
                        }
                    }
                    self.entries.extend(commit.entries);
                    self.follow_subagents(client);
                }
            }
            ServerNotification::Committed(commit) => {
                if let Some(subagent) = self.subagents.get_mut(&commit.conversation_id) {
                    subagent.on_commit(commit);
                    self.follow_subagents(client);
                }
            }
            ServerNotification::Status(changed)
                if changed.conversation_id != self.conversation.id =>
            {
                if let Some(subagent) = self.subagents.get_mut(&changed.conversation_id) {
                    subagent.on_status(&changed);
                }
            }
            ServerNotification::Status(changed) => {
                self.status = changed.status;
                self.working_since = match changed.status {
                    ConversationStatus::Working => {
                        self.working_since.or_else(|| Some(Instant::now()))
                    }
                    _ => None,
                };
            }
            ServerNotification::UiChanged(UiChanged::Status { extension, text }) => {
                self.extension_status.retain(|(name, _)| *name != extension);
                if let Some(text) = text {
                    self.extension_status.push((extension, text));
                }
            }
            ServerNotification::UiChanged(UiChanged::Toast { extension, text }) => {
                self.toast = Some((format!("{extension}: {text}"), Instant::now()));
            }
        }
        None
    }

    fn on_sign_in(
        &mut self,
        state: AuthState,
        client: &Client,
        host: &mut impl Host,
    ) -> Option<(Vec<String>, std::collections::BTreeMap<String, String>)> {
        let ours = self.started.as_deref() == Some(state.flow_id.as_str());
        if state.phase.is_over() {
            let provider = &state.provider;
            match state.phase {
                AuthPhase::Succeeded => {
                    self.toast = Some((format!("signed in to {provider}"), Instant::now()))
                }
                AuthPhase::Cancelled => {
                    self.toast = Some((format!("{provider} sign-in cancelled"), Instant::now()))
                }
                _ => {
                    let why = state.message.as_deref().unwrap_or("it did not say why");
                    self.error = Some(format!("signing in to {provider} failed: {why}"));
                }
            }
            if self
                .sign_in
                .as_ref()
                .is_some_and(|shown| shown.flow_id == state.flow_id)
            {
                self.sign_in = None;
            }
            if ours {
                self.started = None;
            }
            self.list_providers(client);
            return None;
        }
        let interaction = state.interaction.clone();
        let first_shown = self
            .sign_in
            .as_ref()
            .is_none_or(|shown| shown.flow_id != state.flow_id || shown.interaction != interaction);
        self.sign_in = Some(state);
        if !ours || !first_shown {
            return None;
        }
        match interaction? {
            AuthInteraction::Browser { url } => {
                host.open(&url);
                None
            }
            AuthInteraction::Terminal { command, env } => Some((command, env)),
            AuthInteraction::DeviceCode { .. } => None,
        }
    }

    /// Signs in to the first provider that needs it.
    async fn start_sign_in(&mut self, client: &Client, host: &impl Host) {
        let Some(provider) = self
            .providers
            .iter()
            .find(|provider| provider.health.status == ProviderStatus::SignedOut)
        else {
            return;
        };
        let method = (host.is_remote() && provider.sign_in.contains(&AuthMethod::DeviceCode))
            .then_some(AuthMethod::DeviceCode);
        let started = client
            .request::<AuthState>(ClientRequest::AuthStart(AuthStartParams {
                provider: provider.id.clone(),
                method,
            }))
            .await;
        match started {
            Ok(state) => {
                self.started = Some(state.flow_id.clone());
                if self
                    .sign_in
                    .as_ref()
                    .is_none_or(|shown| shown.flow_id != state.flow_id)
                {
                    self.sign_in = Some(state);
                }
                self.error = None;
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    async fn respond(&mut self, client: &Client, response: AuthResponse) {
        let Some(state) = &self.sign_in else {
            return;
        };
        let answered = client
            .request::<AuthAccepted>(ClientRequest::AuthRespond(AuthRespondParams {
                provider: state.provider.clone(),
                flow_id: state.flow_id.clone(),
                response,
            }))
            .await;
        self.error = answered.err().map(|error| error.to_string());
    }

    async fn cancel_sign_in(&mut self, client: &Client) {
        let Some(state) = &self.sign_in else {
            return;
        };
        let cancelled = client
            .request::<AuthAccepted>(ClientRequest::AuthCancel(AuthCancelParams {
                provider: state.provider.clone(),
                flow_id: state.flow_id.clone(),
            }))
            .await;
        self.error = cancelled.err().map(|error| error.to_string());
    }

    /// Whether the sign-in on show waits for the address a browser ended on.
    fn awaits_callback(&self) -> bool {
        self.sign_in
            .as_ref()
            .is_some_and(|state| matches!(state.interaction, Some(AuthInteraction::Browser { .. })))
    }

    /// Returns true when the user quits.
    async fn on_event(&mut self, event: Event, client: &Client, host: &impl Host) -> Result<bool> {
        let Event::Key(KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            ..
        }) = event
        else {
            return Ok(false);
        };
        if let (KeyCode::Char(answer @ ('y' | 'n')), KeyModifiers::CONTROL) = (code, modifiers)
            && let Some((conversation_id, call_id)) = self.pending_approval()
        {
            let (conversation_id, call_id) = (conversation_id.to_owned(), call_id.to_owned());
            self.resolve(client, conversation_id, call_id, answer == 'y')
                .await;
            return Ok(false);
        }
        if let (KeyCode::Char('c' | 'd'), KeyModifiers::CONTROL) = (code, modifiers) {
            return Ok(true);
        }
        if self.on_picker_key(code, client).await {
            return Ok(false);
        }
        match (code, modifiers) {
            (KeyCode::Char('l'), KeyModifiers::CONTROL) if self.sign_in.is_none() => {
                self.start_sign_in(client, host).await
            }
            (KeyCode::Esc, _) if self.sign_in.is_some() => self.cancel_sign_in(client).await,
            (KeyCode::Esc, _) if self.status != ConversationStatus::Idle => {
                let interrupted = client
                    .request::<ConversationInterruptResult>(ClientRequest::ConversationInterrupt(
                        ConversationInterruptParams {
                            conversation_id: self.conversation.id.clone(),
                        },
                    ))
                    .await;
                self.error = interrupted.err().map(|error| error.to_string());
            }
            (KeyCode::Enter, _)
                if self.awaits_callback() && self.input.trim().starts_with("http") =>
            {
                let url = std::mem::take(&mut self.input).trim().to_owned();
                self.respond(client, AuthResponse::Callback { url }).await;
            }
            (KeyCode::Enter, _) if self.input.trim() == "/model" => {
                self.input.clear();
                self.picker = Some(Picker::loading());
                self.list_models(client);
            }
            (KeyCode::Enter, _) if !self.input.trim().is_empty() => {
                let text = std::mem::take(&mut self.input);
                self.scroll.follow();
                let sent = client
                    .request::<ConversationSubmitResult>(ClientRequest::ConversationSubmit(
                        ConversationSubmitParams {
                            conversation_id: self.conversation.id.clone(),
                            input: Input::Text { text },
                            request_id: uuid::Uuid::now_v7().to_string(),
                            when_busy: WhenBusy::FollowUp,
                        },
                    ))
                    .await;
                self.error = sent.err().map(|error| error.to_string());
            }
            (KeyCode::Backspace, _) => {
                self.input.pop();
            }
            (KeyCode::Char('u'), KeyModifiers::CONTROL) => self.input.clear(),
            (KeyCode::PageUp, _) => self.scroll.page_up(),
            (KeyCode::PageDown, _) => self.scroll.page_down(),
            (KeyCode::Char(typed), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                self.input.push(typed)
            }
            _ => {}
        }
        Ok(false)
    }

    async fn resolve(
        &mut self,
        client: &Client,
        conversation_id: String,
        call_id: String,
        allow: bool,
    ) {
        let resolved = client
            .request::<ApprovalResolveResult>(ClientRequest::ApprovalResolve(
                ApprovalResolveParams {
                    conversation_id,
                    call_id,
                    allow,
                    reason: None,
                },
            ))
            .await;
        self.error = resolved.err().map(|error| error.to_string());
    }
}
