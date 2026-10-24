//! `nisse exec` against a real server in process, with a scripted model.

use std::{sync::Arc, time::Duration};

use nisse_client::Client;
use nisse_core::{
    Approval, Harness, HarnessOptions, NoHooks, Provider, ProviderFuture, Store, ToolCall,
    ToolOutcome, Turn, same_hooks,
};
use nisse_protocol::{Actor, ConversationStartParams};
use nisse_server::Server;
use tokio::sync::broadcast;

const PATIENCE: Duration = Duration::from_secs(10);

struct Silent;

impl Provider for Silent {
    fn run<'a>(&'a self, _: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

struct TwoCommands;

impl Provider for TwoCommands {
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
    let harness = Harness::with_store(
        Store::open_in_memory().unwrap(),
        HarnessOptions {
            providers: vec![("test".into(), provider)],
            hooks: same_hooks(Arc::new(NoHooks)),
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
    tokio::time::timeout(
        PATIENCE,
        nisse::exec(
            &client,
            &mut notifications,
            ConversationStartParams {
                title: None,
                cwd: std::env::current_dir().unwrap(),
                provider: None,
                model: None,
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
    })
    .unwrap();
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn exec_returns_when_the_run_ends_without_an_answer() {
    let printed = exec(Arc::new(Silent), b"").await;
    assert!(printed.starts_with("> go\n"), "{printed}");
    assert!(printed.contains("conversation "), "{printed}");
}

#[tokio::test]
async fn every_piped_yes_allows_its_own_approval() {
    let printed = exec(Arc::new(TwoCommands), b"y\ny\n").await;
    assert!(printed.contains("ran make\n"), "{printed}");
    assert!(printed.contains("ran make install\n"), "{printed}");
    assert!(printed.contains("Built and installed."), "{printed}");
}
