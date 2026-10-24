//! Stack tests: the real `nisse` binary, driven over its socket, killed and restarted.

use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

use nisse_client::Client;
use nisse_protocol::{
    ClientRequest, Conversation, ConversationListResult, ConversationReadResult,
    ConversationStartParams, ConversationSubmitParams, ConversationSubmitResult,
    ConversationSubscribeParams, Entry, Input, ServerNotification, ServerStopParams,
    ServerStopResult, WhenBusy, kinds,
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

async fn start(client: &Client, home: &Path) -> Conversation {
    client
        .request(ClientRequest::ConversationStart(ConversationStartParams {
            title: None,
            cwd: home.to_owned(),
            provider: Some("echo".into()),
            model: None,
        }))
        .await
        .unwrap()
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
    let conversation = start(&client, home.path()).await;
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
    start(&client, home.path()).await;
}

async fn next_line(lines: &mut tokio::io::Lines<impl tokio::io::AsyncBufRead + Unpin>) -> String {
    tokio::time::timeout(PATIENCE, lines.next_line())
        .await
        .expect("the line came in time")
        .unwrap()
        .unwrap_or_default()
}

/// Waits until no process holds the home, which is when its server has exited.
async fn until_released(home: &Path) {
    let lock = std::fs::File::open(home.join("nisse.lock")).unwrap();
    tokio::time::timeout(
        PATIENCE,
        tokio::task::spawn_blocking(move || lock.lock().unwrap()),
    )
    .await
    .expect("the server exited in time")
    .unwrap();
}

/// Asks the home's server to exit, and waits until it has.
async fn stop(home: &Path) {
    let (client, _notifications) = attach(home).await;
    let _: ServerStopResult = client
        .request(ClientRequest::ServerStop(ServerStopParams {}))
        .await
        .unwrap();
    drop(client);
    until_released(home).await;
}

#[tokio::test]
async fn a_client_with_no_server_starts_one_that_works_in_its_directory_and_exits_once_unneeded() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();

    let exec = tokio::time::timeout(
        PATIENCE,
        nisse(home.path())
            .args(["exec", "!pwd"])
            .current_dir(project.path())
            .env("NISSE_IDLE_GRACE_MS", "200")
            .output(),
    )
    .await
    .expect("nisse exec finished in time")
    .unwrap();
    assert!(
        exec.status.success(),
        "{}",
        String::from_utf8_lossy(&exec.stderr)
    );
    until_released(home.path()).await;

    let printed = String::from_utf8_lossy(&exec.stdout);
    let project = project.path().canonicalize().unwrap();
    assert!(
        printed.contains(&format!("The command ran:\n{}", project.display())),
        "{printed}"
    );
    let log = std::fs::read_to_string(home.path().join("nisse.log")).unwrap();
    assert!(log.contains("nisse: nothing to do; exiting"), "{log}");
}

#[tokio::test]
async fn clients_started_at_once_share_the_one_server_they_start() {
    let home = tempfile::tempdir().unwrap();

    let execs = (0..4).map(|n| {
        nisse(home.path())
            .args(["exec", &format!("hi {n}")])
            .env("NISSE_IDLE_GRACE_MS", "5000")
            .output()
    });
    let finished = tokio::time::timeout(PATIENCE, futures_util::future::join_all(execs))
        .await
        .expect("every exec finished in time");

    for (n, exec) in finished.into_iter().enumerate() {
        let exec = exec.unwrap();
        assert!(
            exec.status.success(),
            "{}",
            String::from_utf8_lossy(&exec.stderr)
        );
        assert!(String::from_utf8_lossy(&exec.stdout).contains(&format!("You said: hi {n}")));
    }
    let (client, _notifications) = attach(home.path()).await;
    let listed: ConversationListResult = client
        .request(ClientRequest::ConversationList(Default::default()))
        .await
        .unwrap();
    assert_eq!(listed.conversations.len(), 4);
    let log = std::fs::read_to_string(home.path().join("nisse.log")).unwrap();
    assert_eq!(log.matches("nisse: serving on").count(), 1, "{log}");
    stop(home.path()).await;
}

#[tokio::test]
async fn serve_restart_takes_over_once_the_running_server_s_work_settles() {
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

    let mut restart = nisse(home.path())
        .args(["serve", "--restart"])
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut said = BufReader::new(restart.stderr.take().unwrap()).lines();
    let waiting = next_line(&mut said).await;
    release.write_all(b"done\n").unwrap();
    let rest: Vec<String> = tokio::time::timeout(PATIENCE, async {
        let mut rest = Vec::new();
        while let Some(line) = printed.next_line().await.unwrap() {
            rest.push(line);
        }
        rest
    })
    .await
    .expect("nisse exec finished in time");
    let serving = next_line(&mut said).await;

    assert_eq!(
        waiting,
        "nisse: waiting for the running server's work to settle"
    );
    assert!(rest.contains(&"done".to_owned()), "{rest:?}");
    assert!(exec.wait().await.unwrap().success());
    assert!(serving.starts_with("nisse: serving on"), "{serving}");
    let (client, _notifications) = attach(home.path()).await;
    let listed: ConversationListResult = client
        .request(ClientRequest::ConversationList(Default::default()))
        .await
        .unwrap();
    assert_eq!(listed.conversations.len(), 1);
    restart.kill().await.unwrap();
}
