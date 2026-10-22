//! Nisse's terminal UI: a client of the app server that draws only when something changed.

mod gnome;
mod theme;
mod view;

use std::time::{Duration, Instant};

use anyhow::Result;
use nisse_client::Client;
use nisse_protocol::{
    Actor, ApprovalResolveParams, ApprovalResolveResult, ClientRequest, Conversation,
    ConversationCreateParams, ConversationReadResult, ConversationStatus, ConversationSubmitParams,
    ConversationSubmitResult, ConversationSubscribeParams, Entry, Input, ServerNotification,
    UiChanged, WhenBusy,
};
use ratatui::{
    Terminal,
    backend::Backend,
    crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
};
use tokio::sync::mpsc;

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
}

/// Takes over the process's terminal until the user quits.
pub async fn run(
    client: Client,
    notifications: mpsc::UnboundedReceiver<ServerNotification>,
    conversation_id: Option<String>,
    theme: Theme,
) -> Result<()> {
    let (keys, pressed) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        while let Ok(event) = event::read() {
            if keys.send(event).is_err() {
                break;
            }
        }
    });
    let mut terminal = ratatui::init();
    let outcome = drive(
        &mut terminal,
        pressed,
        client,
        notifications,
        conversation_id,
        theme,
    )
    .await;
    ratatui::restore();
    outcome
}

/// Draws on `terminal` and reads `pressed` until the user quits or `pressed` closes.
pub async fn drive<B: Backend>(
    terminal: &mut Terminal<B>,
    mut pressed: mpsc::UnboundedReceiver<Event>,
    client: Client,
    mut notifications: mpsc::UnboundedReceiver<ServerNotification>,
    conversation_id: Option<String>,
    theme: Theme,
) -> Result<()>
where
    B::Error: Send + Sync + 'static,
{
    let conversation = match conversation_id {
        Some(id) => {
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
        None => {
            client
                .request(ClientRequest::ConversationCreate(
                    ConversationCreateParams::default(),
                ))
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
    let model = last_model(&snapshot.entries).unwrap_or("echo").to_owned();
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
        error: None,
        model,
    };

    loop {
        terminal.draw(|frame| view::draw(frame, &app, &theme))?;
        let tick = app.next_tick();
        tokio::select! {
            event = pressed.recv() => match event {
                Some(event) => {
                    if app.on_event(event, &client).await? {
                        return Ok(());
                    }
                }
                None => return Ok(()),
            },
            Some(notification) = notifications.recv() => app.on_notification(notification),
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

    fn on_notification(&mut self, notification: ServerNotification) {
        match notification {
            ServerNotification::Committed(commit)
                if commit.conversation_id == self.conversation.id =>
            {
                if let Some(model) = last_model(&commit.entries) {
                    self.model = model.to_owned();
                }
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
    }

    /// Returns true when the user quits.
    async fn on_event(&mut self, event: Event, client: &Client) -> Result<bool> {
        let Event::Key(KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            ..
        }) = event
        else {
            return Ok(false);
        };
        if let (KeyCode::Char(answer @ ('y' | 'n')), KeyModifiers::NONE) = (code, modifiers)
            && self.input.is_empty()
            && let Some(call_id) = view::pending_approval(&self.entries)
        {
            let call_id = call_id.to_owned();
            self.resolve(client, call_id, answer == 'y').await;
            return Ok(false);
        }
        match (code, modifiers) {
            (KeyCode::Char('c' | 'd'), KeyModifiers::CONTROL) => return Ok(true),
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

fn last_model(entries: &[Entry]) -> Option<&str> {
    entries.iter().rev().find_map(|entry| match &entry.author {
        Actor::Model { model } => Some(model.as_str()),
        _ => None,
    })
}
