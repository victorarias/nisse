//! Screen tests: the real TUI against a real server, judged by what a terminal would show.

use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};

use nisse_client::Client;
use nisse_core::{
    Approval, Echo, Harness, HarnessOptions, NoHooks, Provider, ProviderFuture, Store, ToolCall,
    ToolOutcome, Turn,
};
use nisse_protocol::Actor;
use nisse_server::Server;
use ratatui::{
    Terminal, TerminalOptions, Viewport,
    backend::CrosstermBackend,
    crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers},
    layout::Rect,
};
use tokio::sync::{Notify, broadcast, mpsc};

const WIDTH: u16 = 80;
const HEIGHT: u16 = 24;
const PATIENCE: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct Screen {
    parser: Arc<Mutex<vt100::Parser>>,
    painted: Arc<Notify>,
}

impl Write for Screen {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.parser.lock().unwrap().process(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.painted.notify_waiters();
        Ok(())
    }
}

impl Screen {
    fn contents(&self) -> String {
        self.parser.lock().unwrap().screen().contents()
    }

    async fn shows(&self, wanted: &[&str]) -> String {
        tokio::time::timeout(PATIENCE, async {
            loop {
                let painted = self.painted.notified();
                tokio::pin!(painted);
                painted.as_mut().enable();
                let contents = self.contents();
                if wanted.iter().all(|text| contents.contains(text)) {
                    return contents;
                }
                painted.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("screen never showed {wanted:?}:\n{}", self.contents()))
    }
}

struct Tui {
    screen: Screen,
    keys: mpsc::UnboundedSender<Event>,
}

impl Tui {
    async fn start() -> Self {
        Self::with_model(Arc::new(Echo {
            think: Duration::ZERO,
        }))
        .await
    }

    async fn with_model(provider: Arc<dyn Provider>) -> Self {
        let harness = Harness::with_store(
            Store::open_in_memory().unwrap(),
            HarnessOptions {
                provider,
                hooks: Arc::new(NoHooks),
            },
        );
        let owner = Actor::Person {
            id: "owner".into(),
            name: "owner".into(),
        };
        let server = Server::new(harness, broadcast::channel(16).0, owner);
        let (client, notifications) = Client::new(server.connect_in_process());
        let hello = client.initialize("screen-test").await.unwrap();

        let screen = Screen {
            parser: Arc::new(Mutex::new(vt100::Parser::new(HEIGHT, WIDTH, 0))),
            painted: Arc::default(),
        };
        let mut terminal = Terminal::with_options(
            CrosstermBackend::new(screen.clone()),
            TerminalOptions {
                viewport: Viewport::Fixed(Rect::new(0, 0, WIDTH, HEIGHT)),
            },
        )
        .unwrap();
        let (keys, pressed) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let _server = server;
            nisse_tui::drive(
                &mut terminal,
                pressed,
                client,
                notifications,
                hello.model,
                None,
                nisse_tui::Theme::NEON,
            )
            .await
            .unwrap();
        });
        Self { screen, keys }
    }

    fn type_line(&self, text: &str) {
        self.type_text(text);
        self.press(KeyCode::Enter);
    }

    fn type_text(&self, text: &str) {
        for typed in text.chars() {
            self.press(KeyCode::Char(typed));
        }
    }

    fn press(&self, code: KeyCode) {
        self.chord(code, KeyModifiers::NONE);
    }

    fn chord(&self, code: KeyCode, modifiers: KeyModifiers) {
        self.keys
            .send(Event::Key(KeyEvent::new(code, modifiers)))
            .unwrap();
    }
}

fn without_conversation_id(screen: &str) -> String {
    let mut lines: Vec<String> = screen
        .lines()
        .map(|line| line.trim_end().to_owned())
        .collect();
    if let Some(header) = lines.first_mut()
        && let Some(at) = header.find("conversation ")
    {
        header.replace_range(at.., "conversation [id]");
    }
    lines.join("\n")
}

const SPINNER: [char; 8] = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

fn steady(screen: &str) -> String {
    let still: String = screen
        .chars()
        .map(|cell| if SPINNER.contains(&cell) { '⣿' } else { cell })
        .collect();
    let clock = still.find("WORKING").and_then(|at| {
        still[at..]
            .find(|cell: char| cell.is_ascii_digit())
            .map(|offset| at + offset)
    });
    match clock {
        Some(clock) => format!("{}00:00:00{}", &still[..clock], &still[clock + 8..]),
        None => still,
    }
}

struct Thinking {
    finish: Arc<Notify>,
}

impl Provider for Thinking {
    fn model(&self) -> &str {
        "thinking"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            turn.stream("Tracing the neon");
            turn.stream("Tracing the neon grid, one wire at a time");
            self.finish.notified().await;
            turn.answer("The grid is lit.")
        })
    }
}

struct Asking;

impl Provider for Asking {
    fn model(&self) -> &str {
        "asking"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let call = ToolCall {
                id: "call-1".into(),
                name: "Bash".into(),
                args: serde_json::json!({ "command": "rm -rf build", "description": "Clean the build" }),
            };
            let outcome = turn
                .call_tool(call, Approval::Ask, |_| ToolOutcome {
                    output: "removed build\n".into(),
                    ..ToolOutcome::default()
                })
                .await?;
            turn.answer(&format!("Done: {}", outcome.output.trim()))
        })
    }
}

#[tokio::test]
async fn a_new_conversation_opens_on_the_splash() {
    let tui = Tui::start().await;
    let screen = tui.screen.shows(&["READY"]).await;
    insta::assert_snapshot!(without_conversation_id(&screen));
}

#[tokio::test]
async fn a_command_and_its_output_appear_in_the_transcript() {
    let tui = Tui::start().await;
    tui.screen.shows(&["READY"]).await;
    tui.type_line("!echo neon");
    let screen = tui.screen.shows(&["The command ran:", "READY"]).await;
    insta::assert_snapshot!(without_conversation_id(&screen));
}

#[tokio::test]
async fn the_model_s_unfinished_message_shows_live_until_it_is_committed() {
    let finish = Arc::new(Notify::new());
    let tui = Tui::with_model(Arc::new(Thinking {
        finish: finish.clone(),
    }))
    .await;
    tui.screen.shows(&["READY"]).await;
    tui.type_line("light the grid");
    let streaming = tui
        .screen
        .shows(&["Tracing the neon grid, one wire at a time▍"])
        .await;
    finish.notify_one();
    let answered = tui.screen.shows(&["The grid is lit.", "READY"]).await;

    insta::assert_snapshot!("streaming", steady(&without_conversation_id(&streaming)));
    insta::assert_snapshot!("answered", without_conversation_id(&answered));
}

#[tokio::test]
async fn the_status_bar_names_the_server_s_model_before_it_answers() {
    let tui = Tui::with_model(Arc::new(Thinking {
        finish: Arc::new(Notify::new()),
    }))
    .await;
    let screen = tui.screen.shows(&["READY"]).await;
    let status_bar = screen.lines().last().unwrap();
    assert!(status_bar.contains("thinking"), "{status_bar}");
}

#[tokio::test]
async fn ctrl_y_allows_the_call_waiting_for_approval() {
    let tui = Tui::with_model(Arc::new(Asking)).await;
    tui.screen.shows(&["READY"]).await;
    tui.type_line("clean up");
    let asking = tui
        .screen
        .shows(&["APPROVE BASH", "^Y allow · ^N deny", "APPROVAL"])
        .await;
    tui.chord(KeyCode::Char('y'), KeyModifiers::CONTROL);
    let allowed = tui
        .screen
        .shows(&["ALLOWED by owner", "Done: removed build", "READY"])
        .await;

    insta::assert_snapshot!("asking", without_conversation_id(&asking));
    insta::assert_snapshot!("allowed", without_conversation_id(&allowed));
}

#[tokio::test]
async fn a_message_typed_while_a_call_waits_for_approval_does_not_answer_it() {
    let tui = Tui::with_model(Arc::new(Asking)).await;
    tui.screen.shows(&["READY"]).await;
    tui.type_line("clean up");
    tui.screen.shows(&["APPROVE BASH", "APPROVAL"]).await;
    tui.type_text("yes, but keep the logs");
    let typed = tui.screen.shows(&["❯ yes, but keep the logs▍"]).await;
    assert!(typed.contains("^Y allow · ^N deny"), "{typed}");
    assert!(!typed.contains("ALLOWED"), "{typed}");

    tui.chord(KeyCode::Char('n'), KeyModifiers::CONTROL);
    let denied = tui.screen.shows(&["DENIED", "READY"]).await;
    assert!(denied.contains("❯ yes, but keep the logs▍"), "{denied}");
}
