//! Screen tests: the real TUI against a real server, judged by what a terminal would show.

use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};

use nisse_client::Client;
use nisse_core::{Echo, Harness, HarnessOptions, NoHooks, Store};
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
        let harness = Harness::with_store(
            Store::open_in_memory().unwrap(),
            HarnessOptions {
                provider: Arc::new(Echo {
                    think: Duration::ZERO,
                }),
                hooks: Arc::new(NoHooks),
            },
        );
        let owner = Actor::Person {
            id: "owner".into(),
            name: "owner".into(),
        };
        let server = Server::new(harness, broadcast::channel(16).0, owner);
        let (client, notifications) = Client::new(server.connect_in_process());
        client.initialize("screen-test").await.unwrap();

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
                None,
                nisse_tui::Theme::NEON,
            )
            .await
            .unwrap();
        });
        Self { screen, keys }
    }

    fn type_line(&self, text: &str) {
        for typed in text.chars() {
            self.press(KeyCode::Char(typed));
        }
        self.press(KeyCode::Enter);
    }

    fn press(&self, code: KeyCode) {
        self.keys
            .send(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)))
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
