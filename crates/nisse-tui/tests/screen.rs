//! Screen tests: the real TUI against a real server, judged by what a terminal would show.

use std::{
    collections::BTreeMap,
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};

use nisse_client::Client;
use nisse_core::{
    Approval, Echo, Harness, HarnessOptions, HealthFuture, ModelsFuture, NoHooks, Provider,
    ProviderFuture, SignIn, Store, ToolCall, ToolOutcome, Turn, no_default_model, same_hooks,
};
use nisse_protocol::{
    Actor, AuthInteraction, AuthMethod, AuthResponse, ConversationStartParams, ModelInfo,
    ProviderHealth, ProviderStatus,
};
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

/// Each command the TUI handed the terminal to, with its environment.
type Ran = Arc<Mutex<Vec<(Vec<String>, BTreeMap<String, String>)>>>;

/// The terminal around the TUI: keys typed into it, and the commands and links it was handed.
struct FakeHost {
    events: mpsc::UnboundedReceiver<Event>,
    remote: bool,
    ran: Ran,
    opened: Arc<Mutex<Vec<String>>>,
}

impl nisse_tui::Host for FakeHost {
    async fn next_event(&mut self) -> Option<Event> {
        self.events.recv().await
    }

    async fn foreground(&mut self, command: &[String], env: &BTreeMap<String, String>) -> bool {
        self.ran
            .lock()
            .unwrap()
            .push((command.to_vec(), env.clone()));
        true
    }

    fn open(&mut self, url: &str) {
        self.opened.lock().unwrap().push(url.to_owned());
    }

    fn is_remote(&self) -> bool {
        self.remote
    }
}

struct Tui {
    screen: Screen,
    keys: mpsc::UnboundedSender<Event>,
    ran: Ran,
    opened: Arc<Mutex<Vec<String>>>,
    server: Arc<Server>,
    quit: tokio::task::JoinHandle<Result<(), String>>,
}

impl Tui {
    async fn start() -> Self {
        Self::with_model(
            "echo",
            Arc::new(Echo {
                think: Duration::ZERO,
            }),
        )
        .await
    }

    async fn with_model(name: &str, provider: Arc<dyn Provider>) -> Self {
        Self::with(vec![(name.into(), provider)], false).await
    }

    async fn with(providers: Vec<(String, Arc<dyn Provider>)>, remote: bool) -> Self {
        let harness = Harness::with_store(
            Store::open_in_memory().unwrap(),
            HarnessOptions {
                providers,
                hooks: same_hooks(Arc::new(NoHooks)),
                default_model: no_default_model(),
                agents: Default::default(),
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
        let (keys, events) = mpsc::unbounded_channel();
        let host = FakeHost {
            events,
            remote,
            ran: Arc::default(),
            opened: Arc::default(),
        };
        let (ran, opened) = (host.ran.clone(), host.opened.clone());
        let drawn = server.clone();
        let quit = tokio::spawn(async move {
            let _server = drawn;
            nisse_tui::drive(
                &mut terminal,
                host,
                client,
                notifications,
                nisse_tui::Open::New(ConversationStartParams {
                    title: None,
                    cwd: std::env::current_dir().unwrap(),
                    provider: None,
                    model: None,
                    effort: None,
                }),
                None,
                nisse_tui::Theme::NEON,
            )
            .await
            .map_err(|error| error.to_string())
        });
        Self {
            screen,
            keys,
            ran,
            opened,
            server,
            quit,
        }
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
    fn driver(&self) -> &str {
        "test"
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
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let call = ToolCall {
                id: "call-1".into(),
                name: "Bash".into(),
                args: serde_json::json!({ "command": "rm -rf build", "description": "Clean the build" }),
                parent: None,
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

/// Runs a script that reads a file, as a code-mode model does.
struct Scripting;

impl Provider for Scripting {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let (read, finish) = std::sync::mpsc::channel::<()>();
            let script = ToolCall {
                id: "script".into(),
                name: "exec".into(),
                args: serde_json::json!(
                    "const notes = await tools.Read({ file_path: \"notes.md\" });\ntext(notes.output);"
                ),
                parent: None,
            };
            let nested = ToolCall {
                id: "script/1".into(),
                name: "Read".into(),
                args: serde_json::json!({ "file_path": "notes.md" }),
                parent: Some("script".into()),
            };
            let (script, nested) = tokio::join!(
                turn.call_tool(script, Approval::NotNeeded, move |_| {
                    let _ = finish.recv();
                    ToolOutcome::ok(
                        "Script completed\nWall time 0.1 seconds\nOutput:\nwire the grid",
                    )
                }),
                async move {
                    let outcome = turn
                        .call_tool(nested, Approval::NotNeeded, |_| {
                            ToolOutcome::ok("     1\twire the grid")
                        })
                        .await;
                    drop(read);
                    outcome
                },
            );
            nested?;
            script?;
            turn.answer("The notes say to wire the grid.")
        })
    }
}

#[tokio::test]
async fn a_script_s_calls_show_inside_its_card() {
    let tui = Tui::with_model("scripting", Arc::new(Scripting)).await;
    tui.screen.shows(&["READY"]).await;
    tui.type_line("what do the notes say?");
    let screen = tui
        .screen
        .shows(&["The notes say to wire the grid.", "READY"])
        .await;
    insta::assert_snapshot!(without_conversation_id(&screen));
}

#[tokio::test]
async fn a_new_conversation_opens_on_the_splash() {
    let tui = Tui::start().await;
    let screen = tui.screen.shows(&["READY"]).await;
    insta::assert_snapshot!(without_conversation_id(&screen));
}

#[tokio::test]
async fn when_the_server_goes_away_the_tui_gives_the_terminal_back_and_says_to_reattach() {
    let tui = Tui::start().await;
    tui.screen.shows(&["READY"]).await;
    let closing = tui.server.clone();
    tokio::spawn(async move { closing.close(PATIENCE).await });

    let quit = tokio::time::timeout(PATIENCE, tui.quit)
        .await
        .expect("the TUI quit")
        .unwrap();

    assert_eq!(
        quit,
        Err("the server went away; run nisse again to reattach".into())
    );
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
    let tui = Tui::with_model(
        "thinking",
        Arc::new(Thinking {
            finish: finish.clone(),
        }),
    )
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
async fn the_status_bar_names_the_conversation_s_model_before_it_answers() {
    let tui = Tui::with_model(
        "thinking",
        Arc::new(Thinking {
            finish: Arc::new(Notify::new()),
        }),
    )
    .await;
    let screen = tui.screen.shows(&["READY"]).await;
    let status_bar = screen.lines().last().unwrap();
    assert!(status_bar.contains("thinking"), "{status_bar}");
}

#[tokio::test]
async fn ctrl_y_allows_the_call_waiting_for_approval() {
    let tui = Tui::with_model("asking", Arc::new(Asking)).await;
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
    let tui = Tui::with_model("asking", Arc::new(Asking)).await;
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

/// A provider account, as a person would find it: signed in or not, and how it signs in.
struct Account {
    driver: &'static str,
    health: Mutex<ProviderHealth>,
    methods: Vec<AuthMethod>,
}

impl Account {
    fn new(
        driver: &'static str,
        status: ProviderStatus,
        account: Option<&str>,
        methods: &[AuthMethod],
    ) -> Arc<Self> {
        Arc::new(Self {
            driver,
            health: Mutex::new(ProviderHealth {
                account: account.map(str::to_owned),
                ..ProviderHealth::new(status)
            }),
            methods: methods.to_vec(),
        })
    }

    fn named(self: &Arc<Self>) -> (String, Arc<dyn Provider>) {
        (self.driver.into(), self.clone())
    }
}

impl Provider for Account {
    fn driver(&self) -> &str {
        self.driver
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move { turn.answer("ok") })
    }

    fn health(&self, _refresh: bool) -> HealthFuture<'_> {
        Box::pin(async { self.health.lock().unwrap().clone() })
    }

    fn sign_in_methods(&self) -> Vec<AuthMethod> {
        self.methods.clone()
    }

    fn sign_in(&self, method: AuthMethod, mut flow: SignIn) -> ProviderFuture<'_> {
        Box::pin(async move {
            match method {
                AuthMethod::Terminal => flow.show(AuthInteraction::Terminal {
                    command: vec!["claude".into(), "auth".into(), "login".into()],
                    env: [("CLAUDE_CONFIG_DIR".into(), "/claude-work".into())].into(),
                }),
                AuthMethod::DeviceCode => flow.show(AuthInteraction::DeviceCode {
                    url: "https://auth.example/device".into(),
                    code: "WXYZ-1234".into(),
                }),
                AuthMethod::Browser => flow.show(AuthInteraction::Browser {
                    url: "https://auth.example/authorize?state=s".into(),
                }),
            }
            if let Some(AuthResponse::TerminalExited { success: true }) = flow.response().await {
                let mut health = self.health.lock().unwrap();
                health.status = ProviderStatus::Ready;
                health.account = Some("person@example.com · Claude Max".into());
            }
            Ok(())
        })
    }
}

fn two_accounts() -> Vec<(String, Arc<dyn Provider>)> {
    let claude = Account::new(
        "claude",
        ProviderStatus::SignedOut,
        None,
        &[AuthMethod::Terminal],
    );
    let openai = Account::new(
        "openai",
        ProviderStatus::Ready,
        Some("person@example.com · ChatGPT Plus"),
        &[AuthMethod::Browser, AuthMethod::DeviceCode],
    );
    vec![claude.named(), openai.named()]
}

#[tokio::test]
async fn the_splash_shows_each_provider_and_offers_to_sign_in_to_one_signed_out() {
    let tui = Tui::with(two_accounts(), false).await;

    let screen = tui
        .screen
        .shows(&[
            "claude",
            "signed out",
            "^L",
            "person@example.com · ChatGPT Plus",
        ])
        .await;

    insta::assert_snapshot!(without_conversation_id(&screen));
}

#[tokio::test]
async fn ctrl_l_hands_the_terminal_to_claude_codes_sign_in_and_the_splash_shows_the_account() {
    let tui = Tui::with(two_accounts(), false).await;
    tui.screen.shows(&["signed out", "^L"]).await;

    tui.chord(KeyCode::Char('l'), KeyModifiers::CONTROL);
    let screen = tui
        .screen
        .shows(&[
            "signed in to claude",
            "● claude  person@example.com · Claude Max",
        ])
        .await;

    assert_eq!(
        *tui.ran.lock().unwrap(),
        [(
            vec!["claude".to_owned(), "auth".into(), "login".into()],
            [("CLAUDE_CONFIG_DIR".to_owned(), "/claude-work".to_owned())].into()
        )]
    );
    let shown = tui.screen.shows(&["● claude"]).await;
    assert!(!shown.contains("signed out"), "{screen}\n{shown}");
}

#[tokio::test]
async fn over_ssh_a_sign_in_shows_a_device_code_until_esc_cancels_it() {
    let openai = Account::new(
        "openai",
        ProviderStatus::SignedOut,
        None,
        &[AuthMethod::Browser, AuthMethod::DeviceCode],
    );
    let tui = Tui::with(vec![openai.named()], true).await;
    tui.screen.shows(&["signed out", "^L"]).await;

    tui.chord(KeyCode::Char('l'), KeyModifiers::CONTROL);
    let waiting = tui
        .screen
        .shows(&["https://auth.example/device", "WXYZ-1234", "Esc"])
        .await;
    tui.press(KeyCode::Esc);
    tui.screen
        .shows(&["openai sign-in cancelled", "○ openai"])
        .await;

    assert!(tui.opened.lock().unwrap().is_empty());
    insta::assert_snapshot!("device_code", without_conversation_id(&waiting));
}

#[tokio::test]
async fn a_browser_sign_in_opens_the_browser_and_takes_the_address_it_ended_on() {
    let openai = Account::new(
        "openai",
        ProviderStatus::SignedOut,
        None,
        &[AuthMethod::Browser, AuthMethod::DeviceCode],
    );
    let tui = Tui::with(vec![openai.named()], false).await;
    tui.screen.shows(&["signed out", "^L"]).await;

    tui.chord(KeyCode::Char('l'), KeyModifiers::CONTROL);
    tui.screen
        .shows(&[
            "https://auth.example/authorize?state=s",
            "paste the address",
        ])
        .await;

    assert_eq!(
        *tui.opened.lock().unwrap(),
        ["https://auth.example/authorize?state=s"]
    );
}

/// Two models to choose from, the larger one with efforts, and it says which one answers.
struct Pair;

impl Provider for Pair {
    fn driver(&self) -> &str {
        "test"
    }

    fn models(&self, _refresh: bool) -> ModelsFuture<'_> {
        let model = |id: &str, name: &str, efforts: &[&str], description: &str| ModelInfo {
            id: id.into(),
            name: name.into(),
            description: Some(description.into()),
            efforts: efforts.iter().map(|effort| (*effort).to_owned()).collect(),
            default_effort: None,
            context_window: None,
            code_mode: false,
        };
        Box::pin(async move {
            vec![
                model("small", "Small", &[], "Quick and light"),
                model("large", "Large", &["low", "high"], "Slow and deep"),
            ]
        })
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            turn.answer(&format!(
                "I am {}, thinking {}",
                turn.model().unwrap_or("whatever"),
                turn.effort().unwrap_or("as usual")
            ))
        })
    }
}

#[tokio::test]
async fn the_model_picker_switches_the_conversation_to_the_model_and_effort_chosen() {
    let echo = Arc::new(Echo {
        think: Duration::ZERO,
    });
    let tui = Tui::with(
        vec![("echo".into(), echo), ("pair".into(), Arc::new(Pair))],
        false,
    )
    .await;
    tui.screen.shows(&["READY"]).await;

    tui.type_line("/model");
    let picker = tui.screen.shows(&["MODEL", "Large"]).await;
    for _ in 0..3 {
        tui.press(KeyCode::Down);
    }
    tui.press(KeyCode::Right);
    tui.press(KeyCode::Right);
    let chosen = tui.screen.shows(&["‹ high"]).await;
    tui.press(KeyCode::Enter);
    tui.screen.shows(&["large · high", "READY"]).await;
    tui.type_line("who are you?");
    let answered = tui
        .screen
        .shows(&["I am large, thinking high", "READY"])
        .await;

    insta::assert_snapshot!("picker", without_conversation_id(&picker));
    insta::assert_snapshot!("chosen", without_conversation_id(&chosen));
    insta::assert_snapshot!("switched", without_conversation_id(&answered));
}

/// Hands the cleanup to a subagent, which asks before it runs `rm`.
struct Delegating;

impl Provider for Delegating {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            if turn.lineage().is_some() {
                return Asking.run(turn).await;
            }
            let calls = [
                (
                    "spawn_agent",
                    serde_json::json!({ "task_name": "cleaner", "message": "Clean the build." }),
                ),
                ("wait_agent", serde_json::json!({ "timeout_ms": 60000 })),
            ];
            for (index, (name, args)) in calls.into_iter().enumerate() {
                let call = ToolCall {
                    id: format!("call-{index}"),
                    name: name.into(),
                    args,
                    parent: None,
                };
                turn.call_tool(call, Approval::NotNeeded, turn.run_agent_tool())
                    .await?;
            }
            turn.place_steers()?;
            turn.answer("The cleaner is done.")
        })
    }
}

#[tokio::test]
async fn a_subagent_s_card_shows_its_approval_and_ctrl_y_answers_it_from_the_parent() {
    let tui = Tui::with_model("delegating", Arc::new(Delegating)).await;
    tui.screen.shows(&["READY"]).await;
    tui.type_line("clean up, through a helper");
    let asking = tui
        .screen
        .shows(&[
            "◆ AGENT",
            "APPROVE BASH",
            "^Y allow · ^N deny",
            "WAIT_AGENT",
        ])
        .await;
    tui.chord(KeyCode::Char('y'), KeyModifiers::CONTROL);
    let done = tui
        .screen
        .shows(&["✓ DONE", "The cleaner is done.", "READY"])
        .await;

    insta::assert_snapshot!(
        "delegated_asking",
        steady(&without_conversation_id(&asking))
    );
    insta::assert_snapshot!("delegated_done", without_conversation_id(&done));
}

#[tokio::test]
async fn esc_stops_the_conversation_s_run() {
    let tui = Tui::with_model(
        "thinking",
        Arc::new(Thinking {
            finish: Arc::new(Notify::new()),
        }),
    )
    .await;
    tui.screen.shows(&["READY"]).await;
    tui.type_line("light the grid");
    tui.screen.shows(&["WORKING", "Esc to stop"]).await;
    tui.press(KeyCode::Esc);
    tui.screen.shows(&["Interrupted.", "READY"]).await;
}
