//! Stack tests: the real `nisse` binary, driven over its socket, killed and restarted.

use std::{
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

use nisse_client::Client;
use nisse_protocol::{
    ClientRequest, Conversation, ConversationCreateParams, ConversationReadResult,
    ConversationSubmitParams, ConversationSubmitResult, ConversationSubscribeParams, Entry, Input,
    ServerNotification, WhenBusy, kinds,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Child,
    sync::mpsc::UnboundedReceiver,
};

const PATIENCE: Duration = Duration::from_secs(20);

async fn serve(home: &Path) -> Child {
    let mut child = tokio::process::Command::from({
        let mut command = Command::new(env!("CARGO_BIN_EXE_nisse"));
        command
            .arg("--home")
            .arg(home)
            .arg("--provider")
            .arg("echo")
            .arg("serve")
            .current_dir(home)
            .env("NISSE_ECHO_THINK_MS", "0")
            .stdin(Stdio::null())
            .stderr(Stdio::piped());
        command
    })
    .kill_on_drop(true)
    .spawn()
    .unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    tokio::time::timeout(PATIENCE, async {
        while let Some(line) = stderr.next_line().await.unwrap() {
            if line.starts_with("nisse: serving on") {
                return;
            }
        }
        panic!("nisse serve exited before serving");
    })
    .await
    .expect("nisse serve never started serving");
    child
}

async fn attach(home: &Path) -> (Client, UnboundedReceiver<ServerNotification>) {
    let (client, notifications) = Client::connect_unix(&home.join("nisse.sock"))
        .await
        .unwrap();
    client.initialize("stack-test").await.unwrap();
    (client, notifications)
}

async fn subscribe(client: &Client, conversation_id: &str) -> ConversationReadResult {
    client
        .request(ClientRequest::ConversationSubscribe(
            ConversationSubscribeParams {
                conversation_id: conversation_id.into(),
                since_seq: 0,
            },
        ))
        .await
        .unwrap()
}

async fn entries_until(
    notifications: &mut UnboundedReceiver<ServerNotification>,
    kind: &str,
) -> Vec<Entry> {
    let mut seen = Vec::new();
    tokio::time::timeout(PATIENCE, async {
        while let Some(notification) = notifications.recv().await {
            if let ServerNotification::Committed(commit) = notification {
                let done = commit.entries.iter().any(|entry| entry.kind == kind);
                seen.extend(commit.entries);
                if done {
                    return;
                }
            }
        }
        panic!("the server hung up before committing {kind}");
    })
    .await
    .unwrap_or_else(|_| panic!("no {kind} entry arrived"));
    seen
}

#[tokio::test]
async fn a_command_cut_off_by_sigkill_is_reported_interrupted_after_restart() {
    let home = tempfile::tempdir().unwrap();
    let mut first = serve(home.path()).await;
    let (client, mut notifications) = attach(home.path()).await;
    let conversation: Conversation = client
        .request(ClientRequest::ConversationCreate(
            ConversationCreateParams::default(),
        ))
        .await
        .unwrap();
    subscribe(&client, &conversation.id).await;
    let _: ConversationSubmitResult = client
        .request(ClientRequest::ConversationSubmit(
            ConversationSubmitParams {
                conversation_id: conversation.id.clone(),
                input: Input::Text {
                    text: "!sleep 10".into(),
                },
                request_id: "sleep".into(),
                when_busy: WhenBusy::FollowUp,
            },
        ))
        .await
        .unwrap();
    entries_until(&mut notifications, kinds::TOOL_CALL).await;
    first.kill().await.unwrap();

    let _second = serve(home.path()).await;
    let (client, mut notifications) = attach(home.path()).await;
    let mut entries = subscribe(&client, &conversation.id).await.entries;
    if !entries.iter().any(|entry| entry.kind == kinds::ASSISTANT) {
        entries.extend(entries_until(&mut notifications, kinds::ASSISTANT).await);
    }
    let kinds: Vec<&str> = entries.iter().map(|entry| entry.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            kinds::USER,
            kinds::TOOL_CALL,
            kinds::TOOL_RESULT,
            kinds::ASSISTANT
        ]
    );
    let result = &entries[2].data;
    assert_eq!(result["is_error"], true);
    assert!(
        result["output"]
            .as_str()
            .unwrap()
            .starts_with("interrupted:"),
        "{result}"
    );
}

#[tokio::test]
async fn a_second_server_on_one_home_refuses_to_start_and_the_first_keeps_serving() {
    let home = tempfile::tempdir().unwrap();
    let _first = serve(home.path()).await;

    let second = tokio::process::Command::new(env!("CARGO_BIN_EXE_nisse"))
        .arg("--home")
        .arg(home.path())
        .args(["--provider", "echo", "serve"])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let second = tokio::time::timeout(PATIENCE, second)
        .await
        .expect("the second server gave up in time")
        .unwrap();

    assert!(!second.status.success());
    let said = String::from_utf8_lossy(&second.stderr);
    assert!(said.contains("another nisse already serves"), "{said}");
    let (client, _notifications) = attach(home.path()).await;
    let _: Conversation = client
        .request(ClientRequest::ConversationCreate(
            ConversationCreateParams::default(),
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_client_attaches_to_the_server_an_exec_runs_in_its_own_process() {
    let home = tempfile::tempdir().unwrap();
    let release = home.path().join("release.fifo");
    assert!(
        Command::new("mkfifo")
            .arg(&release)
            .status()
            .unwrap()
            .success()
    );
    let mut exec = tokio::process::Command::from({
        let mut command = Command::new(env!("CARGO_BIN_EXE_nisse"));
        command
            .arg("--home")
            .arg(home.path())
            .args(["--provider", "echo", "exec"])
            .arg(format!("!cat {}", release.display()))
            .current_dir(home.path())
            .env("NISSE_ECHO_THINK_MS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        command
    })
    .kill_on_drop(true)
    .spawn()
    .unwrap();
    let mut printed = BufReader::new(exec.stdout.take().unwrap()).lines();
    tokio::time::timeout(PATIENCE, async {
        while let Some(line) = printed.next_line().await.unwrap() {
            if line.starts_with("⚡ Bash") {
                return;
            }
        }
        panic!("nisse exec ended before it ran the command");
    })
    .await
    .expect("nisse exec ran the command in time");

    let (client, _notifications) = attach(home.path()).await;
    let listed: nisse_protocol::ConversationListResult = client
        .request(ClientRequest::ConversationList(Default::default()))
        .await
        .unwrap();
    let released = tokio::task::spawn_blocking(move || std::fs::write(release, "done\n"));
    released.await.unwrap().unwrap();
    let ended = tokio::time::timeout(PATIENCE, exec.wait())
        .await
        .expect("nisse exec finished in time")
        .unwrap();

    assert_eq!(listed.conversations.len(), 1);
    assert!(ended.success());
}
