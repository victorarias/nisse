//! Wire tests: a real server driven as a protocol client.

use std::{path::Path, sync::Arc, time::Duration};

use nisse_client::Client;
use nisse_core::{
    Echo, Harness, HarnessOptions, Hooks, NoHooks, Provider, ProviderFuture, Store, Turn,
};
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
    provider: Arc<dyn Provider>,
    hooks: Arc<dyn Hooks>,
    ui: broadcast::Sender<UiChanged>,
) -> Arc<Server> {
    let harness = Harness::with_store(store, HarnessOptions { provider, hooks });
    harness.resume().unwrap();
    Server::new(harness, ui, owner())
}

fn echo() -> Arc<dyn Provider> {
    Arc::new(Echo {
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

impl Provider for Hanging {
    fn model(&self) -> &str {
        "hanging"
    }

    fn run<'a>(&'a self, _turn: &'a Turn) -> ProviderFuture<'a> {
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
  on("tool.call", { tool = "Bash" }, function(nisse, e, next)
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
async fn a_luau_extension_denies_a_tool_call_and_rewrites_a_prompt() {
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

#[tokio::test]
async fn a_hook_keeps_its_time_budget_while_a_slow_command_runs_inside_it() {
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
    let mut statuses = ui.subscribe();
    let server = start(Store::open_in_memory().unwrap(), echo(), Arc::new(host), ui);
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "!sleep 0.5; false").await;
    entries_until(&mut notifications, kinds::ASSISTANT).await;

    let UiChanged::Status { extension, text } = statuses.try_recv().unwrap() else {
        panic!("expected a status from the guard");
    };
    assert_eq!(
        (extension.as_str(), text.as_deref()),
        ("guard", Some("last command failed"))
    );
}

/// Asks to run each input as a shell command, streaming a few words before it does.
struct Careful;

impl Provider for Careful {
    fn model(&self) -> &str {
        "careful"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let transcript = turn.transcript()?;
            let command = transcript.last().unwrap().data["text"]
                .as_str()
                .unwrap()
                .to_owned();
            turn.stream("Let me");
            turn.stream("Let me run that.");
            tokio::time::sleep(nisse_core::LIVE_INTERVAL * 3).await;
            turn.say("Let me run that.")?;
            let call = nisse_core::ToolCall {
                id: format!("call-{command}"),
                name: "Bash".into(),
                args: serde_json::json!({ "command": command }),
            };
            let outcome = turn
                .call_tool(
                    call,
                    nisse_core::Approval::Ask,
                    nisse_core::run_builtin_tool,
                )
                .await?;
            turn.answer(outcome.denied.as_deref().unwrap_or(outcome.output.trim()))
        })
    }
}

async fn resolve(client: &Client, conversation: &Conversation, call_id: &str, allow: bool) -> bool {
    let result: nisse_protocol::ApprovalResolveResult = client
        .request(ClientRequest::ApprovalResolve(
            nisse_protocol::ApprovalResolveParams {
                conversation_id: conversation.id.clone(),
                call_id: call_id.into(),
                allow,
                reason: None,
            },
        ))
        .await
        .unwrap();
    result.accepted
}

#[tokio::test]
async fn a_call_waits_for_approval_and_only_the_first_answer_counts() {
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(Careful),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let (other, _) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "echo approved").await;
    let asked = until_entry(&mut notifications, kinds::APPROVAL_REQUEST).await;
    let first = resolve(&client, &conversation, "call-echo approved", true).await;
    let second = resolve(&other, &conversation, "call-echo approved", false).await;
    let answered = entries_until(&mut notifications, kinds::ASSISTANT).await;

    assert!(asked.iter().any(|notification| matches!(notification,
        ServerNotification::Status(changed) if changed.status == ConversationStatus::NeedsApproval)));
    assert!(first && !second);
    let approval = answered
        .iter()
        .find(|entry| entry.kind == kinds::APPROVAL)
        .unwrap();
    assert_eq!(
        (approval.data["allow"].as_bool(), &approval.author),
        (Some(true), &owner())
    );
    assert_eq!(answered.last().unwrap().data["text"], "approved");
}

#[tokio::test]
async fn a_declined_call_never_runs_and_the_model_hears_why() {
    let workspace = tempfile::tempdir().unwrap();
    let marker = workspace.path().join("made");
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(Careful),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;
    let command = format!("touch {}", marker.display());

    submit(&client, &conversation, &command).await;
    until_entry(&mut notifications, kinds::APPROVAL_REQUEST).await;
    resolve(&client, &conversation, &format!("call-{command}"), false).await;
    let answered = entries_until(&mut notifications, kinds::ASSISTANT).await;

    assert!(!marker.exists());
    assert_eq!(answered.last().unwrap().data["text"], "owner declined");
}

async fn until_idle(notifications: &mut UnboundedReceiver<ServerNotification>) {
    tokio::time::timeout(PATIENCE, async {
        loop {
            if let Some(ServerNotification::Status(changed)) = notifications.recv().await
                && changed.status == ConversationStatus::Idle
            {
                return;
            }
        }
    })
    .await
    .expect("the conversation went idle");
}

fn ask_to_run(command: &str) -> nisse_core::ToolCall {
    nisse_core::ToolCall {
        id: format!("call-{command}"),
        name: "Bash".into(),
        args: serde_json::json!({ "command": command }),
    }
}

/// Asks to run `first`, and gives up on it when told the model went away, as Claude does when
/// it exits mid-ask. Then it fails, or asks to run `second` and answers with its output.
struct GivesUp {
    gone: tokio::sync::Notify,
    second: Option<&'static str>,
}

impl Provider for GivesUp {
    fn model(&self) -> &str {
        "gives-up"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let first = turn.call_tool(
                ask_to_run("first"),
                nisse_core::Approval::Ask,
                nisse_core::run_builtin_tool,
            );
            tokio::select! {
                ran = first => { ran?; }
                () = self.gone.notified() => {}
            }
            let Some(second) = self.second else {
                anyhow::bail!("the model went away");
            };
            let outcome = turn
                .call_tool(
                    ask_to_run(second),
                    nisse_core::Approval::Ask,
                    nisse_core::run_builtin_tool,
                )
                .await?;
            turn.answer(outcome.output.trim())
        })
    }
}

#[tokio::test]
async fn an_approval_left_open_by_a_failed_run_is_closed_and_answering_it_keeps_the_conversation_idle()
 {
    let provider = Arc::new(GivesUp {
        gone: tokio::sync::Notify::new(),
        second: None,
    });
    let server = start(
        Store::open_in_memory().unwrap(),
        provider.clone(),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "go").await;
    until_entry(&mut notifications, kinds::APPROVAL_REQUEST).await;
    provider.gone.notify_one();
    let settled = until_entry(&mut notifications, kinds::ASSISTANT).await;
    until_idle(&mut notifications).await;
    let accepted = resolve(&client, &conversation, "call-first", true).await;
    let after = subscribe(&client, &conversation, 0).await;

    let ServerNotification::Committed(settle) = settled.last().unwrap() else {
        panic!("the run settled in a commit");
    };
    let result = settle
        .entries
        .iter()
        .find(|entry| entry.kind == kinds::TOOL_RESULT)
        .expect("the open call got its result as the run settled");
    assert_eq!(result.data["call_id"], "call-first");
    assert!(
        result.data["output"]
            .as_str()
            .unwrap()
            .starts_with("not run:")
    );
    assert!(!accepted);
    assert_eq!(after.conversation.status, ConversationStatus::Idle);
    assert!(
        !after
            .entries
            .iter()
            .any(|entry| entry.kind == kinds::APPROVAL)
    );
}

#[tokio::test]
async fn approving_the_live_call_resumes_work_while_the_call_its_run_abandoned_cannot_be_answered()
{
    let provider = Arc::new(GivesUp {
        gone: tokio::sync::Notify::new(),
        second: Some("echo second"),
    });
    let server = start(
        Store::open_in_memory().unwrap(),
        provider.clone(),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "go").await;
    until_entry(&mut notifications, kinds::APPROVAL_REQUEST).await;
    provider.gone.notify_one();
    until_entry(&mut notifications, kinds::APPROVAL_REQUEST).await;
    let live = resolve(&client, &conversation, "call-echo second", true).await;
    let abandoned = resolve(&client, &conversation, "call-first", true).await;
    let answered = until_entry(&mut notifications, kinds::ASSISTANT).await;

    let approved = answered
        .iter()
        .find_map(|notification| match notification {
            ServerNotification::Committed(commit)
                if commit
                    .entries
                    .iter()
                    .any(|entry| entry.kind == kinds::APPROVAL) =>
            {
                Some(commit)
            }
            _ => None,
        })
        .unwrap();
    assert!(live && !abandoned);
    assert_eq!(approved.status, Some(ConversationStatus::Working));
    assert_eq!(entries(&answered).last().unwrap().data["text"], "second");
}

#[test]
fn a_call_waiting_for_approval_when_nisse_restarts_is_not_run_and_the_model_hears_it() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nisse.sqlite");
    let marker = home.path().join("made");
    let command = format!("touch {}", marker.display());

    let crashed = tokio::runtime::Runtime::new().unwrap();
    let conversation = crashed.block_on(async {
        let server = start(
            Store::open(&path).unwrap(),
            Arc::new(Careful),
            Arc::new(NoHooks),
            broadcast::channel(16).0,
        );
        let (client, mut notifications) = connect(&server).await;
        let conversation = create(&client).await;
        subscribe(&client, &conversation, 0).await;
        submit(&client, &conversation, &command).await;
        until_entry(&mut notifications, kinds::APPROVAL_REQUEST).await;
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
        let mut entries = subscribe(&client, &conversation, 0).await.entries;
        let rerun_answered = |entries: &[Entry]| {
            entries
                .iter()
                .skip_while(|entry| entry.kind != kinds::TOOL_RESULT)
                .any(|entry| entry.kind == kinds::ASSISTANT)
        };
        while !rerun_answered(&entries) {
            entries.extend(entries_until(&mut notifications, kinds::ASSISTANT).await);
        }
        let accepted = resolve(&client, &conversation, &format!("call-{command}"), true).await;

        let result = entries
            .iter()
            .find(|entry| entry.kind == kinds::TOOL_RESULT)
            .unwrap();
        let output = result.data["output"].as_str().unwrap();
        assert!(output.starts_with("not run:"), "{output}");
        assert!(
            entries.last().unwrap().data["text"]
                .as_str()
                .unwrap()
                .contains(output)
        );
        assert!(!accepted);
        assert!(!marker.exists());
    });
}

#[tokio::test]
async fn streamed_text_shows_live_until_the_message_is_committed() {
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(Careful),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "true").await;
    let seen = until_entry(&mut notifications, kinds::ASSISTANT).await;

    let live: Vec<&str> = seen
        .iter()
        .filter_map(|notification| match notification {
            ServerNotification::Committed(commit) => commit.live.as_deref(),
            _ => None,
        })
        .collect();
    assert_eq!(live, ["Let me run that.", ""]);
}

/// Runs the calls its input lists, as JSON `[{"name", "args"}]`, with the built-in tools.
struct Scripted;

impl Provider for Scripted {
    fn model(&self) -> &str {
        "scripted"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let transcript = turn.transcript()?;
            let script = transcript.last().unwrap().data["text"].as_str().unwrap();
            let calls: Vec<serde_json::Value> = serde_json::from_str(script)?;
            for (index, call) in calls.into_iter().enumerate() {
                let call = nisse_core::ToolCall {
                    id: format!("call-{index}"),
                    name: call["name"].as_str().unwrap().into(),
                    args: call["args"].clone(),
                };
                let approval = nisse_core::approval_for(&call.name);
                turn.call_tool(call, approval, nisse_core::run_builtin_tool)
                    .await?;
            }
            turn.answer("done")
        })
    }
}

/// Runs `script` on the scripted model, allowing every call that asks, and returns what the
/// conversation committed until the answer.
async fn run_allowing(script: serde_json::Value) -> Vec<Entry> {
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(Scripted),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;
    submit(&client, &conversation, &script.to_string()).await;
    let mut seen = Vec::new();
    tokio::time::timeout(PATIENCE, async {
        while let Some(notification) = notifications.recv().await {
            for entry in entries(&[notification]) {
                if entry.kind == kinds::APPROVAL_REQUEST {
                    let call_id = entry.data["call_id"].as_str().unwrap();
                    resolve(&client, &conversation, call_id, true).await;
                }
                let answered = entry.kind == kinds::ASSISTANT;
                seen.push(entry);
                if answered {
                    return;
                }
            }
        }
    })
    .await
    .expect("the script was answered in time");
    seen
}

fn tool_results(entries: &[Entry]) -> Vec<(String, bool)> {
    entries
        .iter()
        .filter(|entry| entry.kind == kinds::TOOL_RESULT)
        .map(|entry| {
            (
                entry.data["output"].as_str().unwrap().to_owned(),
                entry.data["is_error"].as_bool().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_model_writes_edits_reads_and_greps_files_and_only_changes_ask_first() {
    let workspace = tempfile::tempdir().unwrap();
    let file = workspace.path().join("notes/todo.txt");
    let path = file.to_str().unwrap();
    let root = workspace.path().to_str().unwrap();

    let committed = run_allowing(serde_json::json!([
        { "name": "Write", "args": { "file_path": path, "content": "milk\neggs\nmilk\n" } },
        { "name": "Edit", "args": { "file_path": path, "old_string": "milk", "new_string": "tea" } },
        { "name": "Edit", "args": { "file_path": path, "old_string": "eggs\n", "new_string": "eggs\nbread\n" } },
        { "name": "Read", "args": { "file_path": path, "offset": 2 } },
        { "name": "Grep", "args": { "pattern": "^b", "path": root, "glob": "*.txt" } },
    ]))
    .await;

    let asked: Vec<&str> = committed
        .iter()
        .filter(|entry| entry.kind == kinds::APPROVAL_REQUEST)
        .map(|entry| entry.data["name"].as_str().unwrap())
        .collect();
    assert_eq!(asked, ["Write", "Edit", "Edit"]);
    let results = tool_results(&committed);
    assert!(results[1].1 && results[1].0.contains("appears 2 times"));
    assert_eq!(
        results[3],
        ("     2\teggs\n     3\tbread\n     4\tmilk\n".into(), false)
    );
    assert_eq!(results[4], (format!("{path}:3:bread"), false));
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "milk\neggs\nbread\nmilk\n"
    );
}

#[tokio::test]
async fn grep_skips_gitignored_hidden_and_binary_files() {
    let workspace = tempfile::tempdir().unwrap();
    let write = |name: &str, content: &[u8]| {
        let file = workspace.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    };
    write(".gitignore", b"target/\n*.log\n");
    write("src/main.rs", b"// gnome\n");
    write("src/lib.rs", b"// gnome\n");
    write("target/debug/out.rs", b"// gnome\n");
    write("build.log", b"gnome\n");
    write(".hidden/notes.rs", b"// gnome\n");
    write("logo.bin", b"gnome\0\x01");
    let root = workspace.path().to_str().unwrap();

    let committed = run_allowing(serde_json::json!([
        { "name": "Grep", "args": { "pattern": "gnome", "path": root } },
        { "name": "Grep", "args": { "pattern": "gnome", "path": root, "glob": "src/**/m*.rs" } },
    ]))
    .await;

    let results = tool_results(&committed);
    assert_eq!(
        results[0],
        (
            format!("{root}/src/lib.rs:1:// gnome\n{root}/src/main.rs:1:// gnome"),
            false
        )
    );
    assert_eq!(
        results[1],
        (format!("{root}/src/main.rs:1:// gnome"), false)
    );
}

#[tokio::test]
async fn a_command_that_leaves_a_server_running_returns_when_it_exits_not_as_a_timeout() {
    let committed = run_allowing(serde_json::json!([
        { "name": "Bash", "args": { "command": "sleep 60 & echo $!" } },
    ]))
    .await;

    let (output, is_error) = tool_results(&committed).remove(0);
    let started = output.trim();
    std::process::Command::new("kill")
        .arg(started)
        .status()
        .unwrap();
    assert!(!is_error && started.parse::<u32>().is_ok(), "{output}");
}

#[tokio::test]
async fn a_command_past_its_timeout_is_killed_with_what_it_started() {
    let committed = run_allowing(serde_json::json!([
        { "name": "Bash", "args": { "command": "sleep 60 & echo $!; sleep 60", "timeout": 200 } },
    ]))
    .await;

    let (output, is_error) = tool_results(&committed).remove(0);
    assert!(is_error && output.contains("timed out after 200 ms"));
    let started: u32 = output.lines().next().unwrap().parse().unwrap();
    #[cfg(target_os = "linux")]
    tokio::time::timeout(PATIENCE, async {
        let alive = || {
            std::fs::read_to_string(format!("/proc/{started}/stat"))
                .is_ok_and(|stat| !stat.contains(") Z ") && !stat.contains(") X "))
        };
        while alive() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the command's background process was killed");
}
