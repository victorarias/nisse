//! Wire tests: a real server driven as a protocol client.

use std::{path::Path, sync::Arc, time::Duration};

use nisse_client::Client;
use nisse_core::{EchoModel, Harness, HarnessOptions, Hooks, Model, ModelFuture, NoHooks, Store};
use nisse_lua::LuaHost;
use nisse_protocol::{
    Actor, ClientRequest, Conversation, ConversationCreateParams, ConversationReadResult,
    ConversationStatus, ConversationSubmitParams, ConversationSubmitResult,
    ConversationSubscribeParams, Entry, Input, ServerNotification, UiChanged, WhenBusy, kinds,
};
use nisse_server::Server;
use tokio::sync::{broadcast, mpsc::UnboundedReceiver};

const PATIENCE: Duration = Duration::from_secs(10);

fn owner() -> Actor {
    Actor::Person {
        id: "owner".into(),
        name: "owner".into(),
    }
}

fn start(
    store: Store,
    model: Arc<dyn Model>,
    hooks: Arc<dyn Hooks>,
    ui: broadcast::Sender<UiChanged>,
) -> Arc<Server> {
    let harness = Harness::with_store(store, HarnessOptions { model, hooks });
    harness.resume().unwrap();
    Server::new(harness, ui, owner())
}

fn echo() -> Arc<dyn Model> {
    Arc::new(EchoModel {
        think: Duration::ZERO,
    })
}

async fn connect(server: &Arc<Server>) -> (Client, UnboundedReceiver<ServerNotification>) {
    let (client, notifications) = Client::new(server.connect_in_process());
    client.initialize("wire-test").await.unwrap();
    (client, notifications)
}

async fn create(client: &Client) -> Conversation {
    client
        .request(ClientRequest::ConversationCreate(
            ConversationCreateParams::default(),
        ))
        .await
        .unwrap()
}

async fn submit(
    client: &Client,
    conversation: &Conversation,
    text: &str,
) -> ConversationSubmitResult {
    client
        .request(ClientRequest::ConversationSubmit(
            ConversationSubmitParams {
                conversation_id: conversation.id.clone(),
                input: Input::Text { text: text.into() },
                request_id: text.into(),
                when_busy: WhenBusy::FollowUp,
            },
        ))
        .await
        .unwrap()
}

async fn subscribe(
    client: &Client,
    conversation: &Conversation,
    since_seq: i64,
) -> ConversationReadResult {
    client
        .request(ClientRequest::ConversationSubscribe(
            ConversationSubscribeParams {
                conversation_id: conversation.id.clone(),
                since_seq,
            },
        ))
        .await
        .unwrap()
}

/// Every notification up to and including the commit that carries an entry of `kind`.
async fn until_entry(
    notifications: &mut UnboundedReceiver<ServerNotification>,
    kind: &str,
) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    tokio::time::timeout(PATIENCE, async {
        while let Some(notification) = notifications.recv().await {
            let done = matches!(&notification, ServerNotification::Committed(commit)
                if commit.entries.iter().any(|entry| entry.kind == kind));
            seen.push(notification);
            if done {
                return;
            }
        }
    })
    .await
    .expect("the entry arrived in time");
    seen
}

fn entries(notifications: &[ServerNotification]) -> Vec<Entry> {
    notifications
        .iter()
        .filter_map(|notification| match notification {
            ServerNotification::Committed(commit) => Some(commit.entries.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

async fn entries_until(
    notifications: &mut UnboundedReceiver<ServerNotification>,
    kind: &str,
) -> Vec<Entry> {
    entries(&until_entry(notifications, kind).await)
}

#[tokio::test]
async fn an_input_is_answered_and_the_conversation_goes_idle() {
    let server = start(
        Store::open_in_memory().unwrap(),
        echo(),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "hello").await;
    let entries = entries_until(&mut notifications, kinds::ASSISTANT).await;

    let kinds: Vec<&str> = entries.iter().map(|entry| entry.kind.as_str()).collect();
    assert_eq!(kinds, [kinds::USER, kinds::ASSISTANT]);
    assert_eq!(entries[0].author, owner());
    assert_eq!(entries[1].data["text"], "You said: hello");
    let idle = tokio::time::timeout(PATIENCE, async {
        loop {
            if let Some(ServerNotification::Status(changed)) = notifications.recv().await
                && changed.status == ConversationStatus::Idle
            {
                return;
            }
        }
    });
    idle.await.expect("the conversation went idle");
}

#[tokio::test]
async fn a_retried_request_id_returns_the_first_submission() {
    let server = start(
        Store::open_in_memory().unwrap(),
        echo(),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, _notifications) = connect(&server).await;
    let conversation = create(&client).await;

    let first = submit(&client, &conversation, "once").await;
    let again = submit(&client, &conversation, "once").await;

    assert_eq!(first.submission_id, again.submission_id);
}

#[tokio::test]
async fn subscribing_since_a_seq_replays_only_later_commits() {
    let server = start(
        Store::open_in_memory().unwrap(),
        echo(),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;
    submit(&client, &conversation, "first").await;
    let first = entries_until(&mut notifications, kinds::ASSISTANT).await;
    submit(&client, &conversation, "second").await;
    entries_until(&mut notifications, kinds::ASSISTANT).await;

    let (late, _) = connect(&server).await;
    let replay = subscribe(&late, &conversation, first.last().unwrap().seq).await;

    let texts: Vec<&str> = replay
        .entries
        .iter()
        .filter_map(|entry| entry.data["text"].as_str())
        .collect();
    assert_eq!(texts, ["second", "You said: second"]);
}

struct Hanging;

impl Model for Hanging {
    fn name(&self) -> &str {
        "hanging"
    }

    fn respond<'a>(&'a self, _transcript: &'a [Entry]) -> ModelFuture<'a> {
        Box::pin(std::future::pending())
    }
}

#[test]
fn a_run_cut_off_by_a_crash_is_answered_after_reopening() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nisse.sqlite");

    let crashed = tokio::runtime::Runtime::new().unwrap();
    let conversation = crashed.block_on(async {
        let server = start(
            Store::open(&path).unwrap(),
            Arc::new(Hanging),
            Arc::new(NoHooks),
            broadcast::channel(16).0,
        );
        let (client, mut notifications) = connect(&server).await;
        let conversation = create(&client).await;
        subscribe(&client, &conversation, 0).await;
        submit(&client, &conversation, "survive this").await;
        entries_until(&mut notifications, kinds::USER).await;
        conversation
    });
    crashed.shutdown_background();

    let reopened = tokio::runtime::Runtime::new().unwrap();
    reopened.block_on(async {
        let server = start(
            Store::open(&path).unwrap(),
            echo(),
            Arc::new(NoHooks),
            broadcast::channel(16).0,
        );
        let (client, mut notifications) = connect(&server).await;
        let snapshot = subscribe(&client, &conversation, 0).await;
        let mut entries = snapshot.entries;
        if !entries.iter().any(|entry| entry.kind == kinds::ASSISTANT) {
            entries.extend(entries_until(&mut notifications, kinds::ASSISTANT).await);
        }
        let texts: Vec<&str> = entries
            .iter()
            .filter_map(|entry| entry.data["text"].as_str())
            .collect();
        assert_eq!(texts, ["survive this", "You said: survive this"]);
    });
}

fn extension(root: &Path, name: &str, source: &str) {
    std::fs::create_dir_all(root.join(name)).unwrap();
    std::fs::write(root.join(name).join("init.luau"), source).unwrap();
}

const GUARD: &str = r#"
return function(on)
  on("tool.call", { tool = "bash" }, function(nisse, e, next)
    if e.args.command:match("^rm ") then
      return { deny = "guard: no rm here" }
    end
    local ran = next(e)
    nisse.ui.status(ran.is_error and "last command failed" or nil)
    return ran
  end)
  on("prompt.submit", function(nisse, e, next)
    return next({ text = e.text:gsub("please ", "") })
  end)
end
"#;

#[tokio::test]
async fn a_lua_extension_denies_a_tool_call_and_rewrites_a_prompt() {
    let root = tempfile::tempdir().unwrap();
    extension(root.path(), "guard", GUARD);
    let ui = broadcast::channel(16).0;
    let sink = ui.clone();
    let host = LuaHost::load(
        &[root.path().to_path_buf()],
        Arc::new(move |changed| {
            let _ = sink.send(changed);
        }),
    )
    .unwrap();
    let server = start(Store::open_in_memory().unwrap(), echo(), Arc::new(host), ui);
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "!rm -rf /tmp/nothing").await;
    let denied = entries_until(&mut notifications, kinds::ASSISTANT).await;
    submit(&client, &conversation, "please !false").await;
    let failed = until_entry(&mut notifications, kinds::ASSISTANT).await;

    let result = denied
        .iter()
        .find(|entry| entry.kind == kinds::TOOL_RESULT)
        .unwrap();
    assert_eq!(result.data["denied"], "guard: no rm here");
    assert_eq!(entries(&failed)[0].data["text"], "!false");
    let mut heard = failed.into_iter();
    let status = tokio::time::timeout(PATIENCE, async {
        loop {
            let notification = match heard.next() {
                Some(notification) => notification,
                None => notifications
                    .recv()
                    .await
                    .expect("the server stays connected"),
            };
            if let ServerNotification::UiChanged(UiChanged::Status { extension, text }) =
                notification
            {
                return (extension, text);
            }
        }
    });
    assert_eq!(
        status.await.unwrap(),
        ("guard".to_owned(), Some("last command failed".to_owned()))
    );
}
