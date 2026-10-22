//! Provider tests: the Claude provider behind a real server, against a claude that replays a
//! recording of the real CLI. `NISSE_CLAUDE_LIVE=<path to claude>` runs the same scenarios
//! against the real CLI and records them over the fixtures.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use nisse_claude::{Claude, ClaudeOptions};
use nisse_client::Client;
use nisse_core::{Harness, HarnessOptions, Hooks, NoHooks, Store, ToolCall, ToolOutcome};
use nisse_protocol::{
    Actor, ApprovalResolveParams, ApprovalResolveResult, ClientRequest, Conversation,
    ConversationCreateParams, ConversationReadResult, ConversationStatus, ConversationSubmitParams,
    ConversationSubmitResult, ConversationSubscribeParams, Entry, Input, ServerNotification,
    WhenBusy, kinds,
};
use nisse_server::Server;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc::UnboundedReceiver};

const MODEL: &str = "claude-haiku-5-5";
const REPLAY_FIXTURE: &str = ".nisse-claude-replay.ndjson";

fn live_claude() -> Option<PathBuf> {
    std::env::var_os("NISSE_CLAUDE_LIVE").map(PathBuf::from)
}

fn patience() -> Duration {
    if live_claude().is_some() {
        Duration::from_secs(180)
    } else {
        Duration::from_secs(10)
    }
}

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("{name}.ndjson"))
}

/// A workspace for one scenario, and the claude it talks to: the replay of its fixture, or the
/// real CLI recording a new one.
struct Scenario {
    name: &'static str,
    workspace: tempfile::TempDir,
    recordings: tempfile::TempDir,
}

impl Scenario {
    fn new(name: &'static str) -> Self {
        let workspace = tempfile::tempdir().unwrap();
        if live_claude().is_none() {
            std::fs::copy(fixture_path(name), workspace.path().join(REPLAY_FIXTURE))
                .unwrap_or_else(|error| panic!("the fixture {name} is missing: {error}"));
        }
        Self {
            name,
            workspace,
            recordings: tempfile::tempdir().unwrap(),
        }
    }

    fn claude(&self) -> Arc<Claude> {
        let live = live_claude();
        Arc::new(Claude::new(ClaudeOptions {
            binary: live
                .clone()
                .unwrap_or_else(|| env!("CARGO_BIN_EXE_nisse-claude-replay").into()),
            cwd: self.workspace.path().to_path_buf(),
            model: Some(MODEL.into()),
            record: live.map(|_| self.recordings.path().to_path_buf()),
        }))
    }

    fn start(&self, store: Store, hooks: Arc<dyn Hooks>) -> Arc<Server> {
        let harness = Harness::with_store(
            store,
            HarnessOptions {
                provider: self.claude(),
                hooks,
            },
        );
        harness.resume().unwrap();
        Server::new(harness, broadcast::channel(16).0, owner())
    }

    /// In a live run, keeps what the real CLI did as this scenario's fixture.
    fn keep_recording(&self, conversation: &Conversation) {
        if live_claude().is_none() {
            return;
        }
        let recorded = std::fs::read_to_string(
            self.recordings
                .path()
                .join(format!("{}.ndjson", conversation.id)),
        )
        .unwrap();
        let mut lines = recorded.lines();
        let mut start: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        start["scenario"] = self.name.into();
        start["metadata"]["model"] = MODEL.into();
        let mut fixture = start.to_string();
        for line in lines {
            fixture.push('\n');
            fixture.push_str(line);
        }
        fixture.push('\n');
        std::fs::write(fixture_path(self.name), fixture).unwrap();
    }
}

fn owner() -> Actor {
    Actor::Person {
        id: "owner".into(),
        name: "owner".into(),
    }
}

/// A client watching one conversation: every entry it was shown and the newest status.
struct Watch {
    client: Client,
    notifications: UnboundedReceiver<ServerNotification>,
    conversation: Conversation,
    entries: Vec<Entry>,
    status: ConversationStatus,
}

impl Watch {
    async fn new_conversation(server: &Arc<Server>) -> Self {
        let (client, notifications) = Client::new(server.connect_in_process());
        client.initialize("claude-test").await.unwrap();
        let conversation: Conversation = client
            .request(ClientRequest::ConversationCreate(
                ConversationCreateParams::default(),
            ))
            .await
            .unwrap();
        Self::attach(client, notifications, conversation).await
    }

    async fn existing(server: &Arc<Server>, conversation: Conversation) -> Self {
        let (client, notifications) = Client::new(server.connect_in_process());
        client.initialize("claude-test").await.unwrap();
        Self::attach(client, notifications, conversation).await
    }

    async fn attach(
        client: Client,
        notifications: UnboundedReceiver<ServerNotification>,
        conversation: Conversation,
    ) -> Self {
        let snapshot: ConversationReadResult = client
            .request(ClientRequest::ConversationSubscribe(
                ConversationSubscribeParams {
                    conversation_id: conversation.id.clone(),
                    since_seq: 0,
                },
            ))
            .await
            .unwrap();
        Self {
            client,
            notifications,
            status: snapshot.conversation.status,
            conversation,
            entries: snapshot.entries,
        }
    }

    async fn submit(&self, text: &str, when_busy: WhenBusy) {
        let _: ConversationSubmitResult = self
            .client
            .request(ClientRequest::ConversationSubmit(
                ConversationSubmitParams {
                    conversation_id: self.conversation.id.clone(),
                    input: Input::Text { text: text.into() },
                    request_id: text.into(),
                    when_busy,
                },
            ))
            .await
            .unwrap();
    }

    async fn resolve(&self, call_id: &str, allow: bool) {
        let resolved: ApprovalResolveResult = self
            .client
            .request(ClientRequest::ApprovalResolve(ApprovalResolveParams {
                conversation_id: self.conversation.id.clone(),
                call_id: call_id.into(),
                allow,
                reason: None,
            }))
            .await
            .unwrap();
        assert!(resolved.accepted, "the approval was still waiting");
    }

    async fn until(&mut self, what: &str, done: impl Fn(&Self) -> bool) {
        let waited = tokio::time::timeout(patience(), async {
            while !done(self) {
                match self.notifications.recv().await {
                    Some(ServerNotification::Committed(commit)) => {
                        self.entries.extend(commit.entries);
                        if let Some(status) = commit.status {
                            self.status = status;
                        }
                    }
                    Some(ServerNotification::Status(changed)) => self.status = changed.status,
                    Some(_) => {}
                    None => panic!("the server hung up"),
                }
            }
        })
        .await;
        assert!(
            waited.is_ok(),
            "waited in vain for {what}; entries: {:#?}",
            self.entries
                .iter()
                .map(|entry| (&entry.kind, &entry.data))
                .collect::<Vec<_>>()
        );
    }

    async fn until_kind(&mut self, kind: &'static str) -> Entry {
        self.until(kind, |watch| watch.has(kind)).await;
        self.last(kind).clone()
    }

    async fn until_idle(&mut self) {
        self.until("the conversation to go idle", |watch| {
            watch.status == ConversationStatus::Idle && watch.has(kinds::ASSISTANT)
        })
        .await;
    }

    fn has(&self, kind: &str) -> bool {
        self.entries.iter().any(|entry| entry.kind == kind)
    }

    fn last(&self, kind: &str) -> &Entry {
        self.entries
            .iter()
            .rev()
            .find(|entry| entry.kind == kind)
            .unwrap_or_else(|| panic!("no {kind} entry"))
    }

    fn kinds(&self) -> Vec<&str> {
        self.entries
            .iter()
            .map(|entry| entry.kind.as_str())
            .collect()
    }

    fn final_text(&self) -> &str {
        self.last(kinds::ASSISTANT).data["text"]
            .as_str()
            .unwrap_or_default()
    }
}

#[tokio::test]
async fn claude_answers_a_prompt_with_one_committed_message() {
    let scenario = Scenario::new("text");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server).await;

    watch
        .submit("Reply with exactly: fixture text ok", WhenBusy::FollowUp)
        .await;
    watch.until_idle().await;

    assert_eq!(watch.kinds(), [kinds::USER, kinds::ASSISTANT]);
    assert_eq!(watch.final_text(), "fixture text ok");
    assert_eq!(
        watch.last(kinds::ASSISTANT).author,
        Actor::Model {
            model: MODEL.into()
        }
    );
    scenario.keep_recording(&watch.conversation);
}

#[tokio::test]
async fn claude_reads_a_file_with_its_own_read_tool_and_nisse_commits_the_call() {
    let scenario = Scenario::new("read");
    std::fs::write(
        scenario.workspace.path().join("notes.txt"),
        "the gnome lives under the floor\n",
    )
    .unwrap();
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server).await;

    watch
        .submit(
            "Use the Read tool to read notes.txt, then reply with where the gnome lives, in three words.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_idle().await;

    let call = watch.last(kinds::TOOL_CALL);
    assert_eq!(call.data["name"], "Read");
    assert!(
        call.data["args"]["file_path"]
            .as_str()
            .unwrap()
            .ends_with("notes.txt")
    );
    let result = watch.last(kinds::TOOL_RESULT);
    assert_eq!(result.data["call_id"], call.data["id"]);
    assert_eq!(result.data["is_error"], false);
    assert!(
        result.data["output"]
            .as_str()
            .unwrap()
            .contains("the gnome lives under the floor")
    );
    assert!(watch.final_text().to_lowercase().contains("floor"));
    scenario.keep_recording(&watch.conversation);
}

#[tokio::test]
async fn bash_waits_for_a_person_to_approve_and_then_runs() {
    let scenario = Scenario::new("bash_allowed");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server).await;

    watch
        .submit(
            "Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made",
            WhenBusy::FollowUp,
        )
        .await;
    let request = watch.until_kind(kinds::APPROVAL_REQUEST).await;
    watch
        .until("the conversation to need approval", |watch| {
            watch.status == ConversationStatus::NeedsApproval
        })
        .await;
    assert_eq!(request.data["name"], "Bash");
    assert_eq!(request.data["args"]["command"], "touch made.txt");
    assert!(
        !watch.has(kinds::TOOL_RESULT),
        "the call ran before approval"
    );

    watch
        .resolve(request.data["call_id"].as_str().unwrap(), true)
        .await;
    watch.until_idle().await;

    assert_eq!(
        watch.kinds(),
        [
            kinds::USER,
            kinds::TOOL_CALL,
            kinds::APPROVAL_REQUEST,
            kinds::APPROVAL,
            kinds::TOOL_RESULT,
            kinds::ASSISTANT
        ]
    );
    assert_eq!(watch.last(kinds::TOOL_RESULT).data["is_error"], false);
    assert_eq!(watch.final_text(), "made");
    if live_claude().is_some() {
        assert!(scenario.workspace.path().join("made.txt").exists());
    }
    scenario.keep_recording(&watch.conversation);
}

#[tokio::test]
async fn a_declined_bash_call_never_runs_and_claude_hears_why() {
    let scenario = Scenario::new("bash_declined");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server).await;

    watch
        .submit(
            "Run the bash command `touch declined.txt` with the Bash tool. If it is not allowed, reply with exactly: declined",
            WhenBusy::FollowUp,
        )
        .await;
    let request = watch.until_kind(kinds::APPROVAL_REQUEST).await;
    watch
        .resolve(request.data["call_id"].as_str().unwrap(), false)
        .await;
    watch.until_idle().await;

    let result = watch.last(kinds::TOOL_RESULT);
    assert_eq!(result.data["is_error"], true);
    assert_eq!(result.data["denied"], "owner declined");
    assert_eq!(watch.final_text(), "declined");
    assert!(!scenario.workspace.path().join("declined.txt").exists());
    scenario.keep_recording(&watch.conversation);
}

/// A stand-in for a Luau `tool.call` hook: no `touch` through Bash.
struct NoTouching;

impl Hooks for NoTouching {
    fn tool_call(
        &self,
        call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        let command = call.args["command"].as_str().unwrap_or_default();
        if call.name == "Bash" && command.contains("touch") {
            return ToolOutcome::denied("guard: no touching");
        }
        engine(call)
    }
}

#[tokio::test]
async fn a_hook_denies_bash_before_claude_runs_it_and_claude_hears_the_reason() {
    let scenario = Scenario::new("bash_hook_denied");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoTouching));
    let mut watch = Watch::new_conversation(&server).await;

    watch
        .submit(
            "Run the bash command `touch guarded.txt` with the Bash tool. If it is blocked, reply with only the reason it gave, word for word.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_idle().await;

    assert!(!watch.has(kinds::APPROVAL_REQUEST));
    let result = watch.last(kinds::TOOL_RESULT);
    assert_eq!(result.data["denied"], "guard: no touching");
    assert!(
        watch.final_text().contains("no touching"),
        "claude answered: {}",
        watch.final_text()
    );
    assert!(!scenario.workspace.path().join("guarded.txt").exists());
    scenario.keep_recording(&watch.conversation);
}

/// A stand-in for a Luau `tool.call` hook that rewrites what Bash runs.
struct Rewrite;

impl Hooks for Rewrite {
    fn tool_call(
        &self,
        mut call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        if call.name == "Bash" && call.args["command"] == "echo original" {
            call.args["command"] = "echo rewritten".into();
        }
        engine(call)
    }
}

#[tokio::test]
async fn claude_runs_bash_with_the_arguments_a_hook_rewrote() {
    let scenario = Scenario::new("bash_hook_rewritten");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(Rewrite));
    let mut watch = Watch::new_conversation(&server).await;

    watch
        .submit(
            "Run the bash command `echo original` with the Bash tool, then reply with its output only.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_idle().await;

    assert_eq!(
        watch.last(kinds::TOOL_CALL).data["args"]["command"],
        "echo original"
    );
    let result = watch.last(kinds::TOOL_RESULT);
    assert_eq!(result.data["output"], "rewritten");
    assert_eq!(result.data["is_error"], false);
    scenario.keep_recording(&watch.conversation);
}

#[tokio::test]
async fn a_steer_sent_during_a_tool_reaches_claude_in_the_same_run() {
    let scenario = Scenario::new("steer");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server).await;

    watch
        .submit(
            "Run the bash command `touch steered.txt` with the Bash tool, then reply with exactly: done",
            WhenBusy::FollowUp,
        )
        .await;
    let request = watch.until_kind(kinds::APPROVAL_REQUEST).await;
    watch
        .submit("Also end your reply with the word BANANA.", WhenBusy::Steer)
        .await;
    watch
        .resolve(request.data["call_id"].as_str().unwrap(), true)
        .await;
    watch
        .until("an answer that heard the steer", |watch| {
            watch.status == ConversationStatus::Idle
                && watch.has(kinds::ASSISTANT)
                && watch.final_text().contains("BANANA")
        })
        .await;

    let kinds = watch.kinds();
    let result_at = kinds.iter().position(|kind| *kind == kinds::TOOL_RESULT);
    let steer_at = watch
        .entries
        .iter()
        .position(|entry| entry.data["text"] == "Also end your reply with the word BANANA.");
    assert!(
        steer_at > result_at,
        "the steer joined after the tool round"
    );
    assert_eq!(kinds.iter().filter(|kind| **kind == kinds::USER).count(), 2);
    scenario.keep_recording(&watch.conversation);
}

const LONG_COMMAND: &str = "touch started.txt && python3 -c 'import time; time.sleep(120)'";

#[test]
fn a_run_killed_mid_tool_resumes_claudes_session_where_nisse_last_committed() {
    let scenario = Scenario::new("resume_after_kill");
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nisse.sqlite");

    let crashed = tokio::runtime::Runtime::new().unwrap();
    let conversation = crashed.block_on(async {
        let server = scenario.start(Store::open(&path).unwrap(), Arc::new(NoHooks));
        let mut watch = Watch::new_conversation(&server).await;
        watch
            .submit(
                &format!(
                    "Run the bash command `{LONG_COMMAND}` with the Bash tool. If the call is cut off or interrupted, do not run anything again; reply with exactly: resumed ok"
                ),
                WhenBusy::FollowUp,
            )
            .await;
        let request = watch.until_kind(kinds::APPROVAL_REQUEST).await;
        watch
            .resolve(request.data["call_id"].as_str().unwrap(), true)
            .await;
        watch.until_kind(kinds::APPROVAL).await;
        if live_claude().is_some() {
            let started = scenario.workspace.path().join("started.txt");
            let ran = tokio::time::timeout(patience(), async {
                while !started.exists() {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            });
            ran.await.expect("the command started");
        }
        watch.conversation.clone()
    });
    crashed.shutdown_background();

    let reopened = tokio::runtime::Runtime::new().unwrap();
    reopened.block_on(async {
        let server = scenario.start(Store::open(&path).unwrap(), Arc::new(NoHooks));
        let mut watch = Watch::existing(&server, conversation).await;
        watch
            .until("the resumed answer", |watch| {
                watch.status == ConversationStatus::Idle && watch.has(kinds::ASSISTANT)
            })
            .await;

        let result = watch.last(kinds::TOOL_RESULT);
        assert!(
            result.data["output"]
                .as_str()
                .unwrap()
                .starts_with("interrupted:")
        );
        assert_eq!(watch.final_text(), "resumed ok");
        assert_eq!(
            watch
                .kinds()
                .iter()
                .filter(|kind| **kind == kinds::TOOL_CALL)
                .count(),
            1,
            "claude ran the cut-off call again"
        );
        scenario.keep_recording(&watch.conversation);
    });
}
