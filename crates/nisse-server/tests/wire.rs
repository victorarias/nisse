//! Wire tests: a real server driven as a protocol client.

use std::{path::Path, sync::Arc, time::Duration};

use nisse_client::Client;
use nisse_core::{
    DefaultModel, Echo, Harness, HarnessOptions, Hooks, Limits, NoHooks, Provider, ProviderFuture,
    Store, Turn, no_default_model, same_hooks,
};
use nisse_lua::LuaHost;
use nisse_protocol::{
    Actor, ClientRequest, Commit, Conversation, ConversationInterruptParams,
    ConversationInterruptResult, ConversationListResult, ConversationReadParams,
    ConversationReadResult, ConversationSelectModelParams, ConversationStartParams,
    ConversationStatus, ConversationSubmitParams, ConversationSubmitResult,
    ConversationSubscribeParams, Entry, Input, ModelSelection, ModelsListParams, ModelsListResult,
    Queued, ServerNotification, UiChanged, WhenBusy, kinds,
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
    let harness = Harness::with_store(
        store,
        HarnessOptions {
            providers: vec![("test".into(), provider)],
            hooks: same_hooks(hooks),
            default_model: no_default_model(),
            agents: Default::default(),
        },
    );
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
    start_in(client, &std::env::current_dir().unwrap()).await
}

async fn start_in(client: &Client, cwd: &Path) -> Conversation {
    client
        .request(ClientRequest::ConversationStart(started_in(cwd)))
        .await
        .unwrap()
}

fn started_in(cwd: &Path) -> ConversationStartParams {
    ConversationStartParams {
        title: None,
        cwd: cwd.to_owned(),
        provider: None,
        model: None,
        effort: None,
    }
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
    let (other, _other_notifications) = connect(&server).await;
    let conversation = create(&client).await;

    let first = submit(&client, &conversation, "once").await;
    let again = submit(&client, &conversation, "once").await;
    let (racing, raced) = tokio::join!(
        submit(&client, &conversation, "twice"),
        submit(&other, &conversation, "twice")
    );

    assert_eq!(first.submission_id, again.submission_id);
    assert_eq!(racing.submission_id, raced.submission_id);
}

#[tokio::test]
async fn clients_write_entries_of_their_own_kinds_but_not_nisses() {
    let server = start(
        Store::open_in_memory().unwrap(),
        echo(),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, _notifications) = connect(&server).await;
    let conversation = create(&client).await;
    let write = |kind: &str| {
        client.request::<ConversationSubmitResult>(ClientRequest::ConversationSubmit(
            ConversationSubmitParams {
                conversation_id: conversation.id.clone(),
                input: Input::Write {
                    kind: kind.into(),
                    data: serde_json::json!({ "call_id": "call-1", "output": "forged" }),
                },
                request_id: kind.into(),
                when_busy: WhenBusy::FollowUp,
            },
        ))
    };

    let own = write("notes.pin").await;
    let forged = write(kinds::TOOL_RESULT).await;

    assert!(own.is_ok());
    assert!(
        forged
            .unwrap_err()
            .to_string()
            .contains("only Nisse writes")
    );
    let read = subscribe(&client, &conversation, 0).await;
    let written: Vec<&str> = read
        .entries
        .iter()
        .map(|entry| entry.kind.as_str())
        .collect();
    assert_eq!(written, ["notes.pin"]);
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
    fn driver(&self) -> &str {
        "test"
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
    fn driver(&self) -> &str {
        "test"
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
                parent: None,
            };
            let outcome = turn
                .call_tool(
                    call,
                    nisse_core::Approval::Ask,
                    nisse_core::run_builtin_tool(turn.cwd()),
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

/// The queue as the next commit that changed it left it.
async fn next_queue(notifications: &mut UnboundedReceiver<ServerNotification>) -> Vec<Queued> {
    tokio::time::timeout(PATIENCE, async {
        loop {
            if let Some(ServerNotification::Committed(Commit {
                queued: Some(queued),
                ..
            })) = notifications.recv().await
            {
                return queued;
            }
        }
    })
    .await
    .expect("the queue changed in time")
}

#[tokio::test]
async fn a_follow_up_sent_during_a_run_is_queued_for_everyone_until_its_run_places_it() {
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(Careful),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, _) = connect(&server).await;
    let (watcher, mut watched) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&watcher, &conversation, 0).await;
    submit(&client, &conversation, "echo first").await;
    until_entry(&mut watched, kinds::APPROVAL_REQUEST).await;

    let follow_up = submit(&client, &conversation, "echo second").await;
    let queued = next_queue(&mut watched).await;
    let (late, _) = connect(&server).await;
    let read_late = read(&late, &conversation.id).await;
    resolve(&client, &conversation, "call-echo first", true).await;
    let placed = until_entry(&mut watched, kinds::USER).await;

    let expected = vec![Queued {
        submission_id: follow_up.submission_id,
        author: owner(),
        input: Input::Text {
            text: "echo second".into(),
        },
        when_busy: WhenBusy::FollowUp,
    }];
    assert_eq!(queued, expected);
    assert_eq!(read_late.queued, expected);
    let Some(ServerNotification::Committed(placing)) = placed.last() else {
        unreachable!("until_entry ends on a commit");
    };
    assert_eq!(placing.entries[0].data["text"], "echo second");
    assert_eq!(placing.queued, Some(Vec::new()));
    assert!(read(&late, &conversation.id).await.queued.is_empty());
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
        parent: None,
    }
}

/// Asks to run `first`, and gives up on it when told the model went away, as Claude does when
/// it exits mid-ask. Then it fails, or asks to run `second` and answers with its output.
struct GivesUp {
    gone: tokio::sync::Notify,
    second: Option<&'static str>,
}

impl Provider for GivesUp {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let first = turn.call_tool(
                ask_to_run("first"),
                nisse_core::Approval::Ask,
                nisse_core::run_builtin_tool(turn.cwd()),
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
                    nisse_core::run_builtin_tool(turn.cwd()),
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

/// Runs a script that makes one call, which finishes, and then never finishes itself.
struct StuckScript;

impl Provider for StuckScript {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let call = |id: &str, name: &str, parent: Option<&str>| nisse_core::ToolCall {
                id: id.into(),
                name: name.into(),
                args: serde_json::json!("await tools.Bash({ command: 'echo made it' })"),
                parent: parent.map(str::to_owned),
            };
            let script = turn.call_tool(
                call("script", "exec", None),
                nisse_core::Approval::NotNeeded,
                |_| loop {
                    std::thread::park();
                },
            );
            let nested = turn.call_tool(
                call("script/1", "Bash", Some("script")),
                nisse_core::Approval::NotNeeded,
                |_| nisse_core::ToolOutcome::ok("made it\n"),
            );
            let (script, nested) = tokio::join!(script, nested);
            nested?;
            script?;
            Ok(())
        })
    }
}

#[test]
fn a_script_cut_off_by_a_restart_is_closed_with_the_results_of_the_calls_it_made() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nisse.sqlite");

    let crashed = tokio::runtime::Runtime::new().unwrap();
    let conversation = crashed.block_on(async {
        let server = start(
            Store::open(&path).unwrap(),
            Arc::new(StuckScript),
            Arc::new(NoHooks),
            broadcast::channel(16).0,
        );
        let (client, mut notifications) = connect(&server).await;
        let conversation = create(&client).await;
        subscribe(&client, &conversation, 0).await;
        submit(&client, &conversation, "run the script").await;
        entries_until(&mut notifications, kinds::TOOL_RESULT).await;
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
        while !entries.iter().any(|entry| entry.kind == kinds::ASSISTANT) {
            entries.extend(entries_until(&mut notifications, kinds::ASSISTANT).await);
        }

        let script = entries
            .iter()
            .find(|entry| entry.kind == kinds::TOOL_RESULT && entry.data["call_id"] == "script")
            .unwrap();
        assert_eq!(
            script.data["output"],
            "interrupted: nisse stopped while this ran; it may or may not have taken effect\n\
             The calls it made that finished:\n\
             - Bash (done): made it"
        );
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
    fn driver(&self) -> &str {
        "test"
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
                    parent: None,
                };
                let approval = nisse_core::approval_for(&call.name);
                turn.call_tool(call, approval, nisse_core::run_builtin_tool(turn.cwd()))
                    .await?;
            }
            turn.answer("done")
        })
    }
}

/// Runs `script` on the scripted model, allowing every call that asks, and returns what the
/// conversation committed until the answer.
async fn run_allowing(script: serde_json::Value) -> Vec<Entry> {
    run_allowing_through(Arc::new(NoHooks), script).await
}

async fn run_allowing_through(hooks: Arc<dyn Hooks>, script: serde_json::Value) -> Vec<Entry> {
    run_allowing_in(&std::env::current_dir().unwrap(), hooks, script).await
}

async fn run_allowing_in(
    cwd: &Path,
    hooks: Arc<dyn Hooks>,
    script: serde_json::Value,
) -> Vec<Entry> {
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(Scripted),
        hooks,
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = start_in(&client, cwd).await;
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
async fn a_hook_rewrites_a_calls_arguments_but_cannot_swap_in_a_tool_that_needs_approval() {
    let workspace = tempfile::tempdir().unwrap();
    let notes = workspace.path().join("notes.txt");
    std::fs::write(&notes, "asked for\n").unwrap();
    let instead = workspace.path().join("instead.txt");
    std::fs::write(&instead, "rewritten\n").unwrap();
    let swapped = workspace.path().join("swapped");
    let root = tempfile::tempdir().unwrap();
    extension(
        root.path(),
        "swap",
        &format!(
            r#"
return function(on)
  on("tool.call", {{ tool = "Read" }}, function(nisse, e, next)
    return next({{ tool = "Bash", id = "elsewhere", args = {{ file_path = "{}", command = "touch {}" }} }})
  end)
end
"#,
            instead.display(),
            swapped.display()
        ),
    );
    let hooks = LuaHost::load(&[root.path().to_path_buf()], Arc::new(|_| {})).unwrap();

    let committed = run_allowing_through(
        Arc::new(hooks),
        serde_json::json!([{ "name": "Read", "args": { "file_path": notes } }]),
    )
    .await;

    assert!(
        !committed
            .iter()
            .any(|entry| entry.kind == kinds::APPROVAL_REQUEST)
    );
    assert!(!swapped.exists(), "the hook ran Bash");
    let result = committed
        .iter()
        .find(|entry| entry.kind == kinds::TOOL_RESULT)
        .unwrap();
    assert_eq!(result.data["call_id"], "call-0");
    assert_eq!(result.data["output"], "     1\trewritten\n");
}

#[tokio::test]
async fn grep_matches_end_of_line_anchors_in_unix_and_windows_files() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("unix.rs"),
        "fn main()\nfn main() {}\n",
    )
    .unwrap();
    std::fs::write(workspace.path().join("windows.rs"), "fn main()\r\n").unwrap();
    let root = workspace.path().to_str().unwrap();

    let committed = run_allowing(serde_json::json!([
        { "name": "Grep", "args": { "pattern": "main\\(\\)$", "path": root } },
    ]))
    .await;

    assert_eq!(
        tool_results(&committed)[0],
        (
            format!("{root}/unix.rs:1:fn main()\n{root}/windows.rs:1:fn main()"),
            false
        )
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
    let started: i32 = output.lines().next().unwrap().parse().unwrap();
    #[cfg(target_os = "linux")]
    ends(started).await;
}

/// Waits, with a deadline, for a process this test did not start to end.
#[cfg(target_os = "linux")]
async fn ends(pid: i32) {
    use rustix::{
        event::{PollFd, PollFlags, Timespec, poll},
        process::{Pid, PidfdFlags, pidfd_open},
    };
    let Ok(pidfd) = pidfd_open(Pid::from_raw(pid).unwrap(), PidfdFlags::empty()) else {
        return;
    };
    let deadline = Timespec {
        tv_sec: PATIENCE.as_secs() as i64,
        tv_nsec: 0,
    };
    let ready = tokio::task::spawn_blocking(move || {
        poll(&mut [PollFd::new(&pidfd, PollFlags::IN)], Some(&deadline))
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(ready, 1, "process {pid} kept running");
}

/// Asks to run two commands at once, the way models issue parallel tool calls.
struct TwoAtOnce;

impl Provider for TwoAtOnce {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let call = |id: &str| nisse_core::ToolCall {
                id: id.into(),
                name: "Bash".into(),
                args: serde_json::json!({ "command": format!("echo {id}") }),
                parent: None,
            };
            let (first, second) = tokio::join!(
                turn.call_tool(
                    call("first"),
                    nisse_core::Approval::Ask,
                    nisse_core::run_builtin_tool(turn.cwd())
                ),
                turn.call_tool(
                    call("second"),
                    nisse_core::Approval::Ask,
                    nisse_core::run_builtin_tool(turn.cwd())
                ),
            );
            turn.answer(&format!(
                "{} {}",
                first?.output.trim(),
                second?.output.trim()
            ))
        })
    }
}

#[tokio::test]
async fn a_luau_hook_waiting_on_one_approval_does_not_hold_up_a_parallel_call() {
    let root = tempfile::tempdir().unwrap();
    extension(root.path(), "guard", GUARD);
    let host = LuaHost::load(&[root.path().to_path_buf()], Arc::new(|_| {})).unwrap();
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(TwoAtOnce),
        Arc::new(host),
        broadcast::channel(16).0,
    );
    let (client, mut notifications) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&client, &conversation, 0).await;

    submit(&client, &conversation, "go").await;
    let mut asked = Vec::new();
    while asked.len() < 2 {
        asked.extend(
            entries_until(&mut notifications, kinds::APPROVAL_REQUEST)
                .await
                .into_iter()
                .filter(|entry| entry.kind == kinds::APPROVAL_REQUEST),
        );
    }
    resolve(&client, &conversation, "second", true).await;
    resolve(&client, &conversation, "first", true).await;
    let answered = entries_until(&mut notifications, kinds::ASSISTANT).await;

    assert_eq!(answered.last().unwrap().data["text"], "first second");
}

#[tokio::test]
async fn tools_run_in_the_conversation_s_directory_and_resolve_relative_paths_there() {
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir(project.path().join("src")).unwrap();
    std::fs::write(project.path().join("src/lib.rs"), "fn answer() {}\n").unwrap();

    let committed = run_allowing_in(
        project.path(),
        Arc::new(NoHooks),
        serde_json::json!([
            { "name": "Write", "args": { "file_path": "notes.txt", "content": "tea\n" } },
            { "name": "Edit", "args": { "file_path": "notes.txt", "old_string": "tea", "new_string": "milk" } },
            { "name": "Read", "args": { "file_path": "notes.txt" } },
            { "name": "Grep", "args": { "pattern": "answer" } },
            { "name": "Grep", "args": { "pattern": "answer", "path": "src" } },
            { "name": "Bash", "args": { "command": "pwd" } },
        ]),
    )
    .await;

    let results = tool_results(&committed);
    assert_eq!(results[2], ("     1\tmilk\n".into(), false));
    assert_eq!(results[3], ("src/lib.rs:1:fn answer() {}".into(), false));
    assert_eq!(results[4], ("src/lib.rs:1:fn answer() {}".into(), false));
    assert_eq!(
        results[5].0.trim(),
        project.path().canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(project.path().join("notes.txt")).unwrap(),
        "milk\n"
    );
}

/// Answers with the model its conversation chose.
struct NamesItsModel;

impl Provider for NamesItsModel {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let model = turn.model().unwrap_or("unnamed");
            turn.answer(&match turn.effort() {
                Some(effort) => format!("I am {model}, thinking {effort}"),
                None => format!("I am {model}"),
            })
        })
    }
}

#[tokio::test]
async fn each_conversation_keeps_the_provider_and_model_it_started_with() {
    let harness = Harness::with_store(
        Store::open_in_memory().unwrap(),
        HarnessOptions {
            providers: vec![
                ("echo".into(), echo()),
                ("named".into(), Arc::new(NamesItsModel)),
            ],
            hooks: same_hooks(Arc::new(NoHooks)),
            default_model: no_default_model(),
            agents: Default::default(),
        },
    );
    let server = Server::new(harness, broadcast::channel(16).0, owner());
    let (client, mut notifications) = connect(&server).await;
    let cwd = std::env::current_dir().unwrap();
    let start = |provider: Option<&str>, model: Option<&str>| {
        let client = client.clone();
        let mut params = started_in(&cwd);
        params.provider = provider.map(str::to_owned);
        params.model = model.map(str::to_owned);
        async move {
            client
                .request::<Conversation>(ClientRequest::ConversationStart(params))
                .await
        }
    };

    let by_default = start(None, None).await.unwrap();
    let chosen = start(Some("named"), Some("tiny")).await.unwrap();
    let unknown = start(Some("nobody"), None).await.unwrap_err();
    subscribe(&client, &chosen, 0).await;
    submit(&client, &chosen, "who are you?").await;
    let answered = entries_until(&mut notifications, kinds::ASSISTANT).await;

    assert_eq!(
        (
            by_default.selection.provider.as_str(),
            by_default.selection.model.as_deref()
        ),
        ("echo", Some("echo"))
    );
    assert_eq!(
        (
            chosen.selection.provider.as_str(),
            chosen.selection.model.as_deref()
        ),
        ("named", Some("tiny"))
    );
    let answer = answered.last().unwrap();
    assert_eq!(answer.data["text"], "I am tiny");
    assert_eq!(
        answer.author,
        Actor::Model {
            model: "tiny".into()
        }
    );
    assert!(
        unknown
            .to_string()
            .contains("no provider named nobody; this server has echo, named"),
        "{unknown}"
    );
    let listed: ConversationListResult = client
        .request(ClientRequest::ConversationList(Default::default()))
        .await
        .unwrap();
    assert_eq!(listed.conversations.len(), 2);
}

#[tokio::test]
async fn a_conversation_needs_an_absolute_directory_that_exists() {
    let server = start(
        Store::open_in_memory().unwrap(),
        echo(),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let (client, _notifications) = connect(&server).await;

    for cwd in ["relative/dir", "/no/such/directory"] {
        let refused = client
            .request::<Conversation>(ClientRequest::ConversationStart(started_in(Path::new(cwd))))
            .await
            .unwrap_err();
        assert!(
            refused
                .to_string()
                .contains(&format!("{cwd} is not an absolute path to a directory")),
            "{refused}"
        );
    }
}

const SHOUT: &str = r#"
return function(on)
  on("prompt.submit", function(nisse, e, next)
    return next({ text = e.text:upper() })
  end)
end
"#;

#[tokio::test]
async fn a_project_s_extensions_apply_only_to_conversations_in_that_project() {
    let loud = tempfile::tempdir().unwrap();
    let quiet = tempfile::tempdir().unwrap();
    extension(&loud.path().join(".nisse/extensions"), "shout", SHOUT);
    let harness = Harness::with_store(
        Store::open_in_memory().unwrap(),
        HarnessOptions {
            providers: vec![("echo".into(), echo())],
            hooks: Arc::new(|cwd: &Path| -> anyhow::Result<Arc<dyn Hooks>> {
                Ok(Arc::new(LuaHost::load(
                    &[cwd.join(".nisse/extensions")],
                    Arc::new(|_| {}),
                )?))
            }),
            default_model: no_default_model(),
            agents: Default::default(),
        },
    );
    let server = Server::new(harness, broadcast::channel(16).0, owner());
    let (client, mut notifications) = connect(&server).await;

    let mut heard = Vec::new();
    for project in [&loud, &quiet] {
        let conversation = start_in(&client, project.path()).await;
        subscribe(&client, &conversation, 0).await;
        submit(&client, &conversation, "hello").await;
        heard.push(
            entries_until(&mut notifications, kinds::ASSISTANT).await[0].data["text"].clone(),
        );
    }

    assert_eq!(heard, ["HELLO", "hello"]);
}

/// Holds its run open until `done` is notified.
struct UntilReleased {
    done: Arc<tokio::sync::Notify>,
}

impl Provider for UntilReleased {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            self.done.notified().await;
            turn.answer("released")
        })
    }
}

#[tokio::test(start_paused = true)]
async fn the_server_is_needed_while_a_client_is_attached_or_a_run_goes_on_and_not_after() {
    let grace = Duration::from_secs(30);
    let done = Arc::new(tokio::sync::Notify::new());
    let server = start(
        Store::open_in_memory().unwrap(),
        Arc::new(UntilReleased { done: done.clone() }),
        Arc::new(NoHooks),
        broadcast::channel(16).0,
    );
    let unneeded = {
        let server = server.clone();
        tokio::spawn(async move {
            server.until_idle(grace).await;
            tokio::time::Instant::now()
        })
    };
    let (client, notifications) = connect(&server).await;
    let conversation = create(&client).await;
    submit(&client, &conversation, "take your time").await;
    drop((client, notifications));
    tokio::time::sleep(grace * 10).await;
    assert!(
        !unneeded.is_finished(),
        "the server let go of a running run"
    );

    let released = tokio::time::Instant::now();
    done.notify_one();
    let gone_at = tokio::time::timeout(grace * 2, unneeded)
        .await
        .expect("the server let go once the run settled")
        .unwrap();

    assert!(
        gone_at >= released + grace,
        "it waited out the grace period first"
    );
}

fn echo_and_named(default_model: DefaultModel) -> Arc<Server> {
    let harness = Harness::with_store(
        Store::open_in_memory().unwrap(),
        HarnessOptions {
            providers: vec![
                ("echo".into(), echo()),
                ("named".into(), Arc::new(NamesItsModel)),
            ],
            hooks: same_hooks(Arc::new(NoHooks)),
            default_model,
            agents: Default::default(),
        },
    );
    Server::new(harness, broadcast::channel(16).0, owner())
}

fn selection(provider: &str, model: Option<&str>, effort: Option<&str>) -> ModelSelection {
    ModelSelection {
        provider: provider.into(),
        model: model.map(str::to_owned),
        effort: effort.map(str::to_owned),
    }
}

async fn select(
    client: &Client,
    conversation: &Conversation,
    selection: ModelSelection,
) -> anyhow::Result<Conversation> {
    client
        .request(ClientRequest::ConversationSelectModel(
            ConversationSelectModelParams {
                conversation_id: conversation.id.clone(),
                selection,
            },
        ))
        .await
}

#[tokio::test]
async fn a_switched_model_answers_from_the_next_run_and_everyone_sees_who_switched() {
    let server = echo_and_named(no_default_model());
    let (client, _notifications) = connect(&server).await;
    let (watcher, mut watched) = connect(&server).await;
    let conversation = create(&client).await;
    subscribe(&watcher, &conversation, 0).await;

    let tiny = selection("named", Some("tiny"), Some("high"));
    let switched = select(&client, &conversation, tiny.clone()).await.unwrap();
    let again = select(&client, &conversation, tiny.clone()).await.unwrap();
    let unknown = select(&client, &conversation, selection("nobody", None, None))
        .await
        .unwrap_err();
    submit(&client, &conversation, "who are you?").await;
    let seen = entries_until(&mut watched, kinds::ASSISTANT).await;

    assert_eq!(
        conversation.selection,
        selection("echo", Some("echo"), None)
    );
    assert_eq!(switched.selection, tiny);
    assert_eq!(again.selection, tiny);
    assert!(
        unknown
            .to_string()
            .contains("no provider named nobody; this server has echo, named"),
        "{unknown}"
    );
    let kinds: Vec<&str> = seen.iter().map(|entry| entry.kind.as_str()).collect();
    assert_eq!(kinds, [kinds::MODEL, kinds::USER, kinds::ASSISTANT]);
    assert_eq!(seen[0].author, owner());
    assert_eq!(
        serde_json::from_value::<ModelSelection>(seen[0].data.clone()).unwrap(),
        tiny
    );
    assert_eq!(seen[2].data["text"], "I am tiny, thinking high");
    let read: ConversationReadResult = client
        .request(ClientRequest::ConversationRead(ConversationReadParams {
            conversation_id: conversation.id.clone(),
            since_seq: 0,
        }))
        .await
        .unwrap();
    assert_eq!(read.conversation.selection, tiny);
}

#[tokio::test]
async fn a_new_conversation_takes_the_configured_model_else_the_last_one_chosen() {
    let configured = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let project = configured.path().to_owned();
    let server = echo_and_named(Arc::new(move |cwd: &Path| {
        Ok((cwd == project).then(|| selection("named", Some("tiny"), Some("low"))))
    }));
    let (client, _notifications) = connect(&server).await;
    let start = |cwd: &Path, provider: Option<&str>, model: Option<&str>| {
        let client = client.clone();
        let mut params = started_in(cwd);
        params.provider = provider.map(str::to_owned);
        params.model = model.map(str::to_owned);
        async move {
            client
                .request::<Conversation>(ClientRequest::ConversationStart(params))
                .await
                .unwrap()
                .selection
        }
    };

    let before_any_choice = start(elsewhere.path(), None, None).await;
    let in_the_project = start(configured.path(), None, None).await;
    let first = start_in(&client, elsewhere.path()).await;
    select(
        &client,
        &first,
        selection("named", Some("big"), Some("max")),
    )
    .await
    .unwrap();
    let after_a_choice = start(elsewhere.path(), None, None).await;
    let still_in_the_project = start(configured.path(), None, None).await;
    let another_provider = start(elsewhere.path(), Some("echo"), None).await;
    let another_model = start(elsewhere.path(), None, Some("small")).await;

    assert_eq!(before_any_choice, selection("echo", Some("echo"), None));
    assert_eq!(
        in_the_project,
        selection("named", Some("tiny"), Some("low"))
    );
    assert_eq!(after_a_choice, selection("named", Some("big"), Some("max")));
    assert_eq!(
        still_in_the_project,
        selection("named", Some("tiny"), Some("low"))
    );
    assert_eq!(another_provider, selection("echo", Some("echo"), None));
    assert_eq!(another_model, selection("named", Some("small"), None));
}

#[tokio::test]
async fn models_list_names_each_provider_s_models_and_its_default() {
    let server = echo_and_named(no_default_model());
    let (client, _notifications) = connect(&server).await;

    let listed: ModelsListResult = client
        .request(ClientRequest::ModelsList(ModelsListParams::default()))
        .await
        .unwrap();

    let summary: Vec<(&str, Option<&str>, Vec<&str>)> = listed
        .providers
        .iter()
        .map(|provider| {
            (
                provider.provider.as_str(),
                provider.default_model.as_deref(),
                provider
                    .models
                    .iter()
                    .map(|model| model.id.as_str())
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("echo", Some("echo"), vec!["echo"]),
            ("named", None, vec![])
        ]
    );
}

/// Runs the subagent calls its input lists, as JSON `[{"name", "args"}]`, and answers with
/// their outputs, one per line. Any other input is a task: it answers `finished <task>`, and
/// works on `hang` until stopped.
struct Delegates;

impl Provider for Delegates {
    fn driver(&self) -> &str {
        "test"
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(async move {
            let transcript = turn.transcript()?;
            let input = transcript
                .iter()
                .rev()
                .find(|entry| entry.kind == kinds::USER)
                .unwrap();
            let text = input.data["text"].as_str().unwrap().to_owned();
            if text == "hang" {
                return std::future::pending().await;
            }
            let Ok(calls) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else {
                return turn.answer(&format!("finished {text}"));
            };
            let mut outputs = Vec::new();
            for (index, call) in calls.into_iter().enumerate() {
                let call = nisse_core::ToolCall {
                    id: format!("call-{index}"),
                    name: call["name"].as_str().unwrap().into(),
                    args: call["args"].clone(),
                    parent: None,
                };
                let outcome = turn
                    .call_tool(call, nisse_core::Approval::NotNeeded, turn.run_agent_tool())
                    .await?;
                outputs.push(outcome.output);
            }
            turn.answer(&outputs.join("\n"))
        })
    }
}

fn delegating(agents: Limits) -> Arc<Server> {
    delegating_through(agents, Arc::new(NoHooks))
}

fn delegating_through(agents: Limits, hooks: Arc<dyn Hooks>) -> Arc<Server> {
    let harness = Harness::with_store(
        Store::open_in_memory().unwrap(),
        HarnessOptions {
            providers: vec![("test".into(), Arc::new(Delegates))],
            hooks: same_hooks(hooks),
            default_model: no_default_model(),
            agents,
        },
    );
    Server::new(harness, broadcast::channel(16).0, owner())
}

fn spawn(task_name: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "name": "spawn_agent",
        "args": { "task_name": task_name, "message": message, "fork_turns": "none" }
    })
}

fn wait() -> serde_json::Value {
    serde_json::json!({ "name": "wait_agent", "args": { "timeout_ms": 10000 } })
}

async fn read(client: &Client, conversation_id: &str) -> ConversationReadResult {
    client
        .request(ClientRequest::ConversationRead(ConversationReadParams {
            conversation_id: conversation_id.into(),
            since_seq: 0,
        }))
        .await
        .unwrap()
}

async fn children(client: &Client, parent: &Conversation) -> Vec<Conversation> {
    let listed: ConversationListResult = client
        .request(ClientRequest::ConversationList(Default::default()))
        .await
        .unwrap();
    listed
        .conversations
        .into_iter()
        .filter(|conversation| {
            conversation
                .lineage
                .as_ref()
                .is_some_and(|lineage| lineage.parent == parent.id)
        })
        .collect()
}

/// Waits for the conversation to work on what was just submitted, and then go idle.
async fn until_done(
    notifications: &mut UnboundedReceiver<ServerNotification>,
    conversation_id: &str,
) {
    until_status(notifications, conversation_id, ConversationStatus::Working).await;
    until_status(notifications, conversation_id, ConversationStatus::Idle).await;
}

async fn until_status(
    notifications: &mut UnboundedReceiver<ServerNotification>,
    conversation_id: &str,
    status: ConversationStatus,
) {
    tokio::time::timeout(PATIENCE, async {
        while let Some(notification) = notifications.recv().await {
            if matches!(&notification, ServerNotification::Status(changed)
                if changed.conversation_id == conversation_id && changed.status == status)
            {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{conversation_id} went {status:?} in time"));
}

fn answer(entries: &[Entry]) -> &str {
    entries
        .iter()
        .rev()
        .find(|entry| entry.kind == kinds::ASSISTANT)
        .and_then(|entry| entry.data["text"].as_str())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_spawned_agent_works_in_a_conversation_under_its_parent_and_its_answer_reaches_it() {
    let server = delegating(Limits::default());
    let (client, mut notifications) = connect(&server).await;
    let parent = create(&client).await;

    let script = serde_json::json!([spawn("scout", "look around"), wait()]);
    submit(&client, &parent, &script.to_string()).await;
    until_done(&mut notifications, &parent.id).await;

    let [child] = &children(&client, &parent).await[..] else {
        panic!("one child: {:#?}", read(&client, &parent.id).await.entries);
    };
    let lineage = child.lineage.as_ref().unwrap();
    assert_eq!(lineage.root, parent.id);
    assert_eq!(lineage.task.as_deref(), Some("/root/scout"));
    let child_read = read(&client, &child.id).await;
    assert_eq!(answer(&child_read.entries), "finished look around");
    let parent_read = read(&client, &parent.id).await;
    let card = parent_read
        .entries
        .iter()
        .find(|entry| entry.kind == kinds::SUBAGENT)
        .expect("the parent shows its subagent");
    assert_eq!(card.data["conversation_id"], child.id);
    let answers = answer(&parent_read.entries);
    assert!(
        answers.contains("\"task_name\":\"/root/scout\""),
        "{answers}"
    );
    assert!(answers.contains("Wait completed."), "{answers}");
    let final_answer = parent_read
        .entries
        .iter()
        .find(|entry| entry.kind == kinds::USER && entry.data["mail"]["type"] == "final_answer")
        .expect("the child's answer reached its parent");
    assert_eq!(final_answer.data["text"], "finished look around");
    assert_eq!(final_answer.data["mail"]["sender"], "/root/scout");
}

#[tokio::test]
async fn interrupting_a_conversation_stops_its_subagents_too() {
    let server = delegating(Limits::default());
    let (client, mut notifications) = connect(&server).await;
    let parent = create(&client).await;
    let script = serde_json::json!([
        spawn("sleeper", "hang"),
        { "name": "wait_agent", "args": { "timeout_ms": 3_600_000 } }
    ]);
    submit(&client, &parent, &script.to_string()).await;
    let child = tokio::time::timeout(PATIENCE, async {
        loop {
            if let Some(ServerNotification::Status(changed)) = notifications.recv().await
                && changed.conversation_id != parent.id
                && changed.status == ConversationStatus::Working
            {
                return changed.conversation_id;
            }
        }
    })
    .await
    .expect("the subagent started working in time");

    let interrupted: ConversationInterruptResult = client
        .request(ClientRequest::ConversationInterrupt(
            ConversationInterruptParams {
                conversation_id: parent.id.clone(),
            },
        ))
        .await
        .unwrap();
    assert!(interrupted.interrupted);
    until_status(&mut notifications, &parent.id, ConversationStatus::Idle).await;

    let parent_read = read(&client, &parent.id).await;
    let child_read = read(&client, &child).await;
    assert_eq!(child_read.conversation.status, ConversationStatus::Idle);
    for entries in [&parent_read.entries, &child_read.entries] {
        let last = entries
            .iter()
            .rev()
            .find(|entry| entry.kind == kinds::ASSISTANT)
            .unwrap();
        assert_eq!(last.data["interrupted"], true, "{entries:#?}");
    }
}

#[tokio::test]
async fn a_subagent_at_the_depth_limit_cannot_spawn_its_own() {
    let server = delegating(Limits::default());
    let (client, mut notifications) = connect(&server).await;
    let parent = create(&client).await;
    let nested = serde_json::json!([spawn("grandchild", "anything")]).to_string();
    let script = serde_json::json!([spawn("child", &nested), wait()]);

    submit(&client, &parent, &script.to_string()).await;
    until_done(&mut notifications, &parent.id).await;

    let [child] = &children(&client, &parent).await[..] else {
        panic!("one child");
    };
    let child_read = read(&client, &child.id).await;
    let refused = child_read
        .entries
        .iter()
        .find(|entry| entry.kind == kinds::TOOL_RESULT)
        .unwrap();
    assert_eq!(refused.data["is_error"], true);
    assert!(
        refused.data["output"]
            .as_str()
            .unwrap()
            .contains("at most 1 deep"),
        "{}",
        refused.data["output"]
    );
    assert!(children(&client, child).await.is_empty());
}

#[tokio::test]
async fn a_spawn_past_the_thread_limit_is_refused_while_the_others_run() {
    let server = delegating(Limits {
        max_depth: 1,
        max_threads: 1,
    });
    let (client, mut notifications) = connect(&server).await;
    let parent = create(&client).await;
    let script = serde_json::json!([
        spawn("first", "hang"),
        spawn("second", "anything"),
        { "name": "interrupt_agent", "args": { "target": "first" } }
    ]);

    submit(&client, &parent, &script.to_string()).await;
    until_done(&mut notifications, &parent.id).await;

    let outputs = answer(&read(&client, &parent.id).await.entries).to_owned();
    let lines: Vec<&str> = outputs.lines().collect();
    assert!(lines[1].contains("the most allowed"), "{outputs}");
    assert_eq!(children(&client, &parent).await.len(), 1);
}

const ROOT_LISTS: &str = r#"
return function(on)
  on("tool.call", { tool = "list_agents" }, function(nisse, e, next)
    if e.conversation.parent then
      return { deny = "only " .. e.conversation.parent .. " lists agents" }
    end
    return next(e)
  end)
end
"#;

#[tokio::test]
async fn a_hook_knows_a_subagent_s_call_by_its_parent_and_can_deny_it() {
    let extensions = tempfile::tempdir().unwrap();
    extension(extensions.path(), "root-lists", ROOT_LISTS);
    let hooks = LuaHost::load(&[extensions.path().to_owned()], Arc::new(|_| {})).unwrap();
    let server = delegating_through(Limits::default(), Arc::new(hooks));
    let (client, mut notifications) = connect(&server).await;
    let parent = create(&client).await;
    let list = serde_json::json!({ "name": "list_agents", "args": {} });
    let script = serde_json::json!([
        spawn("child", &serde_json::json!([list]).to_string()),
        wait(),
        list
    ]);

    submit(&client, &parent, &script.to_string()).await;
    until_done(&mut notifications, &parent.id).await;

    let [child] = &children(&client, &parent).await[..] else {
        panic!("one child");
    };
    let child_answer = answer(&read(&client, &child.id).await.entries).to_owned();
    assert_eq!(child_answer, format!("only {} lists agents", parent.id));
    let parent_answer = answer(&read(&client, &parent.id).await.entries).to_owned();
    assert!(
        parent_answer.contains("\"agent_name\":\"/root/child\""),
        "{parent_answer}"
    );
}
