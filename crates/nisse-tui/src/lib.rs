//! Nisse's terminal UI: a client of the app server that draws only when something changed.

mod gnome;
mod host;
mod theme;
mod view;

use std::time::{Duration, Instant};

use anyhow::Result;
use nisse_client::Client;
use nisse_protocol::{
    ApprovalResolveParams, ApprovalResolveResult, AuthAccepted, AuthCancelParams, AuthInteraction,
    AuthMethod, AuthPhase, AuthRespondParams, AuthResponse, AuthStartParams, AuthState,
    ClientRequest, Conversation, ConversationReadResult, ConversationStartParams,
    ConversationStatus, ConversationSubmitParams, ConversationSubmitResult,
    ConversationSubscribeParams, Entry, Input, ProviderSnapshot, ProviderStatus,
    ProvidersListParams, ProvidersListResult, ServerNotification, UiChanged, WhenBusy,
};
use ratatui::{
    Terminal,
    backend::Backend,
    crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    widgets::Clear,
};
use tokio::sync::mpsc;

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
    scroll_back: u16,
    frame: usize,
    error: Option<String>,
    model: String,
    providers: Vec<ProviderSnapshot>,
    /// The newest sign-in any client runs, until it ends.
    sign_in: Option<AuthState>,
    /// The sign-in this client started, which it alone opens a browser or a terminal for.
    started: Option<String>,
    listed: mpsc::UnboundedSender<Vec<ProviderSnapshot>>,
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
    let model = conversation
        .model
        .clone()
        .unwrap_or_else(|| conversation.provider.clone());
    let (listed, mut lists) = mpsc::unbounded_channel();
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
        scroll_back: 0,
        frame: 0,
        error: notice,
        model,
        providers: Vec::new(),
        sign_in: None,
        started: None,
        listed,
    };
    app.list_providers(&client);

    loop {
        terminal.draw(|frame| view::draw(frame, &app, &theme))?;
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
                    self.entries.extend(commit.entries);
                    self.scroll_back = 0;
                }
            }
            ServerNotification::Status(changed)
                if changed.conversation_id == self.conversation.id =>
            {
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
            _ => {}
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
            && let Some(call_id) = view::pending_approval(&self.entries)
        {
            let call_id = call_id.to_owned();
            self.resolve(client, call_id, answer == 'y').await;
            return Ok(false);
        }
        match (code, modifiers) {
            (KeyCode::Char('c' | 'd'), KeyModifiers::CONTROL) => return Ok(true),
            (KeyCode::Char('l'), KeyModifiers::CONTROL) if self.sign_in.is_none() => {
                self.start_sign_in(client, host).await
            }
            (KeyCode::Esc, _) if self.sign_in.is_some() => self.cancel_sign_in(client).await,
            (KeyCode::Enter, _)
                if self.awaits_callback() && self.input.trim().starts_with("http") =>
            {
                let url = std::mem::take(&mut self.input).trim().to_owned();
                self.respond(client, AuthResponse::Callback { url }).await;
            }
            (KeyCode::Enter, _) if !self.input.trim().is_empty() => {
                let text = std::mem::take(&mut self.input);
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
            (KeyCode::PageUp, _) => self.scroll_back = self.scroll_back.saturating_add(10),
            (KeyCode::PageDown, _) => self.scroll_back = self.scroll_back.saturating_sub(10),
            (KeyCode::Char(typed), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                self.input.push(typed)
            }
            _ => {}
        }
        Ok(false)
    }

    async fn resolve(&mut self, client: &Client, call_id: String, allow: bool) {
        let resolved = client
            .request::<ApprovalResolveResult>(ClientRequest::ApprovalResolve(
                ApprovalResolveParams {
                    conversation_id: self.conversation.id.clone(),
                    call_id,
                    allow,
                    reason: None,
                },
            ))
            .await;
        self.error = resolved.err().map(|error| error.to_string());
    }
}
