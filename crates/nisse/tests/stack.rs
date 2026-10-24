//! Stack tests: the real `nisse` binary, driven over its socket, killed and restarted.

use std::{
    io::Write,
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

fn nisse(home: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_nisse"));
    command
        .arg("--home")
        .arg(home)
        .args(["--provider", "echo"])
        .current_dir(home)
        .env("NISSE_ECHO_THINK_MS", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn serve(home: &Path) -> Child {
    serve_until(home, "nisse: serving on").await
}

/// Starts `nisse serve` on the home and waits until it says `said`.
async fn serve_until(home: &Path, said: &str) -> Child {
    let mut child = nisse(home)
        .arg("serve")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    tokio::time::timeout(PATIENCE, async {
        while let Some(line) = stderr.next_line().await.unwrap() {
            if line.starts_with(said) {
                return;
            }
        }
        panic!("nisse serve exited before it said {said:?}");
    })
    .await
    .unwrap_or_else(|_| panic!("nisse serve never said {said:?}"));
    tokio::spawn(async move { while let Ok(Some(_)) = stderr.next_line().await {} });
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

    let second = tokio::time::timeout(PATIENCE, nisse(home.path()).arg("serve").output())
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

const SLOW_TO_LOAD: &str = r#"
nisse.log("loading")
local sum = 0
for i = 1, 5000000 do
  sum += i
end
return function(on)
  on("prompt.submit", function(nisse, e, next)
    return next(e)
  end)
end
"#;

#[tokio::test]
async fn a_client_started_while_the_server_loads_its_extensions_waits_for_it() {
    let home = tempfile::tempdir().unwrap();
    let extension = home.path().join("extensions").join("slow");
    std::fs::create_dir_all(&extension).unwrap();
    std::fs::write(extension.join("init.luau"), SLOW_TO_LOAD).unwrap();
    let _server = serve_until(home.path(), "nisse: extension slow: loading").await;

    let exec = tokio::time::timeout(PATIENCE, nisse(home.path()).args(["exec", "hi"]).output())
        .await
        .expect("nisse exec finished in time")
        .unwrap();

    assert!(
        exec.status.success(),
        "{}",
        String::from_utf8_lossy(&exec.stderr)
    );
    assert!(String::from_utf8_lossy(&exec.stdout).contains("You said: hi"));
}

#[tokio::test]
async fn a_second_client_on_the_home_an_exec_runs_stops_and_points_to_nisse_serve() {
    let home = tempfile::tempdir().unwrap();
    let fifo = home.path().join("release.fifo");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let mut release = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&fifo)
        .unwrap();
    let mut exec = nisse(home.path())
        .arg("exec")
        .arg(format!("!timeout 20 head -n1 {}", fifo.display()))
        .stdout(Stdio::piped())
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

    let second = tokio::time::timeout(PATIENCE, nisse(home.path()).args(["exec", "hi"]).output())
        .await
        .expect("the second client gave up in time")
        .unwrap();
    release.write_all(b"done\n").unwrap();
    let ended = tokio::time::timeout(PATIENCE, exec.wait())
        .await
        .expect("nisse exec finished in time")
        .unwrap();

    assert!(!second.status.success());
    let said = String::from_utf8_lossy(&second.stderr);
    assert!(said.contains("use `nisse serve` to share it"), "{said}");
    assert!(ended.success());
}
