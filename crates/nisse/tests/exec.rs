//! `nisse exec` against a real server in process, with a scripted model.

use std::{sync::Arc, time::Duration};

use nisse_client::Client;
use nisse_core::{
    Approval, Harness, HarnessOptions, NoHooks, Provider, ProviderFuture, Store, ToolCall,
    ToolOutcome, Turn, no_default_model, same_hooks,
};
use nisse_protocol::{Actor, ConversationStartParams};
use nisse_server::Server;
use tokio::sync::broadcast;

const PATIENCE: Duration = Duration::from_secs(10);

struct Silent;

impl Provider for Silent {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, _: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

struct Broken;

impl Provider for Broken {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, _: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async { anyhow::bail!("the model is unreachable") })
    }
}

struct TwoCommands;

impl Provider for TwoCommands {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            for (id, command) in [("first", "make"), ("second", "make install")] {
                let call = ToolCall {
                    id: id.into(),
                    name: "Bash".into(),
                    args: serde_json::json!({ "command": command }),
                    parent: None,
                };
                turn.call_tool(call, Approval::Ask, move |_| ToolOutcome {
                    output: format!("ran {command}\n"),
                    ..ToolOutcome::default()
                })
                .await?;
            }
            turn.answer("Built and installed.")
        })
    }
}

async fn exec(provider: Arc<dyn Provider>, stdin: &'static [u8]) -> String {
    let (printed, ran) = exec_ending(provider, stdin).await;
    ran.unwrap();
    printed
}

async fn exec_ending(
    provider: Arc<dyn Provider>,
    stdin: &'static [u8],
) -> (String, anyhow::Result<()>) {
    let harness = Harness::with_store(
        Store::open_in_memory().unwrap(),
        HarnessOptions {
            providers: vec![("test".into(), provider)],
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
    let (client, mut notifications) = Client::new(server.connect_in_process());
    client.initialize("exec-test").await.unwrap();
    let mut out = Vec::new();
    let ran = tokio::time::timeout(
        PATIENCE,
        nisse::exec(
            &client,
            &mut notifications,
            ConversationStartParams {
                title: None,
                cwd: std::env::current_dir().unwrap(),
                provider: None,
                model: None,
                effort: None,
            },
            "go".into(),
            stdin,
            &mut out,
        ),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "exec never returned; it printed:\n{}",
            String::from_utf8_lossy(&out)
        )
    });
    (String::from_utf8(out).unwrap(), ran)
}

#[tokio::test]
async fn exec_returns_when_the_run_ends_without_an_answer() {
    let printed = exec(Arc::new(Silent), b"").await;
    assert!(printed.starts_with("> go\n"), "{printed}");
    assert!(printed.contains("conversation "), "{printed}");
}

#[tokio::test]
async fn exec_fails_when_the_run_fails() {
    let (printed, ran) = exec_ending(Arc::new(Broken), b"").await;
    assert!(
        printed.contains("Model error: the model is unreachable"),
        "{printed}"
    );
    assert!(printed.contains("conversation "), "{printed}");
    assert!(ran.is_err(), "{printed}");
}

#[tokio::test]
async fn piped_denials_are_not_a_failed_run() {
    let printed = exec(Arc::new(TwoCommands), b"n\nn\n").await;
    assert!(printed.contains("Built and installed."), "{printed}");
}

#[tokio::test]
async fn every_piped_yes_allows_its_own_approval() {
    let printed = exec(Arc::new(TwoCommands), b"y\ny\n").await;
    assert!(printed.contains("ran make\n"), "{printed}");
    assert!(printed.contains("ran make install\n"), "{printed}");
    assert!(printed.contains("Built and installed."), "{printed}");
}
