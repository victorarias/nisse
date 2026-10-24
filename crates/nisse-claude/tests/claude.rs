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
use nisse_core::{
    Echo, Harness, HarnessOptions, Hooks, NoHooks, Provider, Store, ToolCall, ToolOutcome,
    no_default_model, same_hooks,
};
use nisse_protocol::{
    Actor, ApprovalResolveParams, ApprovalResolveResult, AuthAccepted, AuthInteraction, AuthMethod,
    AuthPhase, AuthRespondParams, AuthResponse, AuthStartParams, AuthState, ClientRequest,
    Conversation, ConversationReadResult, ConversationSelectModelParams, ConversationStartParams,
    ConversationStatus, ConversationSubmitParams, ConversationSubmitResult,
    ConversationSubscribeParams, Entry, Input, ModelSelection, ModelsListParams, ModelsListResult,
    ProviderSnapshot, ProviderStatus, ProvidersListParams, ProvidersListResult, ServerNotification,
    WhenBusy, kinds,
};
use nisse_server::Server;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc::UnboundedReceiver};

const MODEL: &str = "claude-haiku-5-5";
const LARGER_MODEL: &str = "claude-sonnet-5-5";
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
        let mut options = ClaudeOptions::new(
            live.clone()
                .unwrap_or_else(|| env!("CARGO_BIN_EXE_nisse-claude-replay").into()),
        );
        options.record = live.map(|_| self.recordings.path().to_path_buf());
        Arc::new(Claude::new(options))
    }

    fn start(&self, store: Store, hooks: Arc<dyn Hooks>) -> Arc<Server> {
        serve(store, self.claude(), hooks)
    }

    /// Deletes the transcripts the real CLI keeps of this workspace's sessions, as Claude Code's
    /// own cleanup of old transcripts does. A replayed claude keeps none.
    fn forget_claude_sessions(&self) {
        if live_claude().is_none() {
            return;
        }
        let config = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap()).join(".claude"));
        let project: String = self
            .workspace
            .path()
            .to_string_lossy()
            .chars()
            .map(|char| {
                if char.is_ascii_alphanumeric() {
                    char
                } else {
                    '-'
                }
            })
            .collect();
        std::fs::remove_dir_all(config.join("projects").join(project)).unwrap();
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

fn serve(store: Store, claude: Arc<Claude>, hooks: Arc<dyn Hooks>) -> Arc<Server> {
    serve_providers(store, vec![("claude".into(), claude)], hooks)
}

fn serve_providers(
    store: Store,
    providers: Vec<(String, Arc<dyn Provider>)>,
    hooks: Arc<dyn Hooks>,
) -> Arc<Server> {
    let harness = Harness::with_store(
        store,
        HarnessOptions {
            providers,
            hooks: same_hooks(hooks),
            default_model: no_default_model(),
        },
    );
    harness.resume().unwrap();
    Server::new(harness, broadcast::channel(16).0, owner())
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
    async fn new_conversation(server: &Arc<Server>, cwd: &Path, model: Option<&str>) -> Self {
        let (client, notifications) = Client::new(server.connect_in_process());
        client.initialize("claude-test").await.unwrap();
        let conversation: Conversation = client
            .request(ClientRequest::ConversationStart(ConversationStartParams {
                title: None,
                cwd: cwd.to_owned(),
                provider: None,
                model: model.map(str::to_owned),
                effort: None,
            }))
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
            "waited in vain for {what}; status {:?}, entries: {:#?}",
            self.status,
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

    /// Until the conversation is idle after its `answers`th answer.
    async fn until_answers(&mut self, answers: usize) {
        self.until("the answer and the conversation to go idle", |watch| {
            watch.status == ConversationStatus::Idle && watch.count(kinds::ASSISTANT) >= answers
        })
        .await;
    }

    fn count(&self, kind: &str) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.kind == kind)
            .count()
    }

    async fn select(&self, provider: &str, model: Option<&str>, effort: Option<&str>) {
        let _: Conversation = self
            .client
            .request(ClientRequest::ConversationSelectModel(
                ConversationSelectModelParams {
                    conversation_id: self.conversation.id.clone(),
                    selection: ModelSelection {
                        provider: provider.into(),
                        model: model.map(str::to_owned),
                        effort: effort.map(str::to_owned),
                    },
                },
            ))
            .await
            .unwrap();
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
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

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
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

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
async fn claude_runs_a_project_skill_with_its_skill_tool_and_nisse_commits_the_call() {
    let scenario = Scenario::new("skill");
    let skill = scenario.workspace.path().join(".claude/skills/gnome-facts");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: gnome-facts\ndescription: Facts about the gnome. Use when asked about the gnome.\n---\n\nReply with exactly: the gnome lives under the floor\n",
    )
    .unwrap();
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

    watch
        .submit(
            "Use the Skill tool to run the gnome-facts skill, then do what it says.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_idle().await;

    let call = watch.last(kinds::TOOL_CALL);
    assert_eq!(call.data["name"], "Skill");
    assert_eq!(call.data["args"]["skill"], "gnome-facts");
    let result = watch.last(kinds::TOOL_RESULT);
    assert_eq!(result.data["call_id"], call.data["id"]);
    assert_eq!(result.data["is_error"], false);
    assert_eq!(watch.final_text(), "the gnome lives under the floor");
    scenario.keep_recording(&watch.conversation);
}

#[tokio::test]
async fn bash_waits_for_a_person_to_approve_and_then_runs() {
    let scenario = Scenario::new("bash_allowed");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

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
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

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
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

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
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

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
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

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

const LONG_COMMAND: &str =
    "echo started > started.fifo && python3 -c 'import time; time.sleep(120)'";

#[test]
fn a_run_killed_mid_tool_resumes_claudes_session_where_nisse_last_committed() {
    let scenario = Scenario::new("resume_after_kill");
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nisse.sqlite");

    let started = scenario.workspace.path().join("started.fifo");
    let made = std::process::Command::new("mkfifo")
        .arg(&started)
        .status()
        .unwrap();
    assert!(made.success());

    let crashed = tokio::runtime::Runtime::new().unwrap();
    let (conversation, command_started) = crashed.block_on(async {
        let server = scenario.start(Store::open(&path).unwrap(), Arc::new(NoHooks));
        let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;
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
        let command_started = live_claude().is_none() || {
            let ran = tokio::task::spawn_blocking(move || std::fs::read_to_string(started));
            matches!(
                tokio::time::timeout(patience(), ran).await,
                Ok(Ok(Ok(said))) if said == "started\n"
            )
        };
        (watch.conversation.clone(), command_started)
    });
    crashed.shutdown_background();
    assert!(command_started, "the command started in time");

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

#[tokio::test]
async fn every_tool_a_subagent_calls_gets_its_result() {
    let scenario = Scenario::new("subagent");
    std::fs::write(
        scenario.workspace.path().join("notes.txt"),
        "the gnome lives under the floor\n",
    )
    .unwrap();
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

    watch
        .submit(
            "Use the Task tool to start a general-purpose subagent that reads notes.txt with the \
             Read tool and reports where the gnome lives. Do not read it yourself. Then reply \
             with where the gnome lives, in three words.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_idle().await;

    let calls: Vec<&Entry> = watch
        .entries
        .iter()
        .filter(|entry| entry.kind == kinds::TOOL_CALL)
        .collect();
    assert!(
        calls.iter().any(|call| call.data["name"] == "Read"),
        "the subagent read nothing; calls: {calls:#?}"
    );
    for call in &calls {
        let result = watch.entries.iter().find(|entry| {
            entry.kind == kinds::TOOL_RESULT && entry.data["call_id"] == call.data["id"]
        });
        assert!(
            result.is_some(),
            "the {} call never got a result",
            call.data["name"]
        );
    }
    let read = watch
        .entries
        .iter()
        .find(|entry| entry.kind == kinds::TOOL_RESULT && entry.data["name"] == "Read")
        .unwrap();
    assert!(
        read.data["output"]
            .as_str()
            .unwrap()
            .contains("the gnome lives under the floor")
    );
    assert!(watch.final_text().to_lowercase().contains("floor"));
    scenario.keep_recording(&watch.conversation);
}

const REMEMBER: &str = "Remember the word PLUM. Reply with exactly: noted";
const RECALL: &str = "Which word did I ask you to remember? Reply with that word only.";

impl Watch {
    fn remembered_plum(&self) -> bool {
        self.final_text().to_lowercase().contains("plum")
    }

    fn no_model_errors(&self) -> bool {
        !self
            .entries
            .iter()
            .any(|entry| entry.kind == kinds::ASSISTANT && entry.data["is_error"] == true)
    }

    async fn until_answered(&mut self, answers: usize) {
        self.until("the answer", |watch| {
            watch.status == ConversationStatus::Idle
                && watch
                    .entries
                    .iter()
                    .filter(|entry| entry.kind == kinds::ASSISTANT)
                    .count()
                    == answers
        })
        .await;
    }
}

/// The claude processes this test process started that work in `workspace`.
fn claudes_working_in(workspace: &Path) -> Vec<i32> {
    let workspace = workspace.canonicalize().unwrap();
    std::fs::read_dir("/proc/self/task")
        .unwrap()
        .flatten()
        .filter_map(|task| std::fs::read_to_string(task.path().join("children")).ok())
        .flat_map(|children| {
            children
                .split_whitespace()
                .filter_map(|pid| pid.parse().ok())
                .collect::<Vec<i32>>()
        })
        .filter(|pid| {
            std::fs::read_link(format!("/proc/{pid}/cwd")).is_ok_and(|cwd| cwd == workspace)
        })
        .collect()
}

/// Kills a claude this test process started, and returns once it has exited, leaving it for
/// Nisse to reap.
async fn kill(pid: i32) {
    use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, kill_process_group, waitid};
    let pid = Pid::from_raw(pid).expect("a claude's pid");
    kill_process_group(pid, Signal::KILL).unwrap();
    let exited = tokio::task::spawn_blocking(move || {
        waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
        )
    });
    tokio::time::timeout(patience(), exited)
        .await
        .expect("the killed claude exited")
        .unwrap()
        .unwrap();
}

/// Waits, with a deadline, for a process this test did not start to end.
async fn ends(pid: i32) {
    use rustix::{
        event::{PollFd, PollFlags, Timespec, poll},
        process::{Pid, PidfdFlags, pidfd_open},
    };
    let Ok(pidfd) = pidfd_open(Pid::from_raw(pid).unwrap(), PidfdFlags::empty()) else {
        return;
    };
    let deadline = Timespec {
        tv_sec: patience().as_secs() as i64,
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

#[tokio::test]
async fn a_claude_that_crashes_leaves_nothing_it_started_running() {
    use std::os::unix::fs::PermissionsExt;
    let workspace = tempfile::tempdir().unwrap();
    let crashing = workspace.path().join("claude");
    std::fs::write(
        &crashing,
        "#!/bin/sh\nsleep 600 > /dev/null 2>&1 &\necho $! > started.pid\nexit 3\n",
    )
    .unwrap();
    std::fs::set_permissions(&crashing, std::fs::Permissions::from_mode(0o755)).unwrap();
    let claude = Arc::new(Claude::new(ClaudeOptions::new(crashing)));
    let server = serve(Store::open_in_memory().unwrap(), claude, Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, workspace.path(), None).await;

    watch.submit("hello", WhenBusy::FollowUp).await;
    watch
        .until("the model error", |watch| {
            watch.status == ConversationStatus::Idle && watch.has(kinds::ASSISTANT)
        })
        .await;

    assert!(
        watch
            .final_text()
            .contains("claude stopped (exit status: 3)"),
        "{}",
        watch.final_text()
    );
    let started = std::fs::read_to_string(workspace.path().join("started.pid")).unwrap();
    ends(started.trim().parse().unwrap()).await;
}

#[tokio::test]
async fn a_claude_that_died_while_idle_resumes_for_the_next_message() {
    let scenario = Scenario::new("died_while_idle");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;
    watch.submit(REMEMBER, WhenBusy::FollowUp).await;
    watch.until_answered(1).await;

    let parked = claudes_working_in(scenario.workspace.path());
    assert_eq!(parked.len(), 1, "one claude waits for the next message");
    kill(parked[0]).await;

    watch.submit(RECALL, WhenBusy::FollowUp).await;
    watch.until_answered(2).await;

    assert!(watch.no_model_errors(), "the next message failed");
    assert!(
        watch.remembered_plum(),
        "claude answered: {}",
        watch.final_text()
    );
    scenario.keep_recording(&watch.conversation);
}

#[tokio::test]
async fn a_conversation_whose_claude_session_is_gone_goes_on_from_its_transcript() {
    let scenario = Scenario::new("session_gone");
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nisse.sqlite");

    let server = scenario.start(Store::open(&path).unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;
    watch.submit(REMEMBER, WhenBusy::FollowUp).await;
    watch.until_answered(1).await;
    let conversation = watch.conversation.clone();
    drop((watch, server));

    scenario.forget_claude_sessions();
    let server = scenario.start(Store::open(&path).unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::existing(&server, conversation).await;
    watch.submit(RECALL, WhenBusy::FollowUp).await;
    watch.until_answered(2).await;

    assert!(watch.no_model_errors(), "the conversation failed");
    assert!(
        watch.remembered_plum(),
        "claude answered: {}",
        watch.final_text()
    );
    watch
        .submit("Now reply with that word in lowercase.", WhenBusy::FollowUp)
        .await;
    watch.until_answered(3).await;
    assert!(watch.no_model_errors(), "the next message failed");
    assert!(
        watch.remembered_plum(),
        "claude answered: {}",
        watch.final_text()
    );
    scenario.keep_recording(&watch.conversation);
}

/// A stand-in for a Luau extension whose `tool.call` hook takes its time before it lets a call
/// through. Like a Luau state, the extension runs one hook at a time, the engine included.
struct OneAtATime(std::sync::Mutex<()>);

impl Hooks for OneAtATime {
    fn tool_call(
        &self,
        call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        let _state = self.0.lock().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        engine(call)
    }
}

#[tokio::test]
async fn parallel_reads_through_a_one_at_a_time_tool_hook_both_finish_and_claude_answers() {
    let scenario = Scenario::new("parallel_reads_hooked");
    std::fs::write(scenario.workspace.path().join("a.txt"), "apple\n").unwrap();
    std::fs::write(scenario.workspace.path().join("b.txt"), "banana\n").unwrap();
    let hooks = Arc::new(OneAtATime(std::sync::Mutex::new(())));
    let server = scenario.start(Store::open_in_memory().unwrap(), hooks);
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

    watch
        .submit(
            "In a single message, call the Read tool twice in parallel: once on a.txt and once \
             on b.txt. Then reply with both contents, separated by a comma.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_idle().await;

    let reads: Vec<&Entry> = watch
        .entries
        .iter()
        .filter(|entry| entry.kind == kinds::TOOL_CALL && entry.data["name"] == "Read")
        .collect();
    assert_eq!(reads.len(), 2, "claude read in parallel: {reads:#?}");
    for read in &reads {
        let result = watch
            .entries
            .iter()
            .find(|entry| {
                entry.kind == kinds::TOOL_RESULT && entry.data["call_id"] == read.data["id"]
            })
            .expect("every read got its result");
        assert_eq!(result.data["is_error"], false);
    }
    let answer = watch.final_text().to_lowercase();
    assert!(
        answer.contains("apple") && answer.contains("banana"),
        "claude answered: {answer}"
    );
    scenario.keep_recording(&watch.conversation);
}

const BANANA: &str = "Also end your reply with the word BANANA.";
const CHERRY: &str = "And start your reply with the word CHERRY.";

/// A guard that keeps a.txt off limits, and answers only once the test has steered, so the
/// steer is waiting while Claude hears its denial and goes on to stream its next call.
struct OffLimitsOnceSteered(std::sync::Mutex<std::sync::mpsc::Receiver<()>>);

impl Hooks for OffLimitsOnceSteered {
    fn tool_call(
        &self,
        call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        let path = call.args["file_path"].as_str().unwrap_or_default();
        if path.ends_with("/a.txt") {
            let _ = self.0.lock().unwrap().recv();
            return ToolOutcome::denied("guard: a.txt is off limits");
        }
        engine(call)
    }
}

#[tokio::test]
async fn a_steer_waits_for_the_calls_claude_has_still_to_stream_in_the_same_message() {
    let scenario = Scenario::new("steer_mid_message");
    std::fs::write(scenario.workspace.path().join("a.txt"), "apple\n").unwrap();
    std::fs::write(scenario.workspace.path().join("b.txt"), "banana\n").unwrap();
    let (steered, guard_waits) = std::sync::mpsc::channel();
    let hooks = Arc::new(OffLimitsOnceSteered(std::sync::Mutex::new(guard_waits)));
    let server = scenario.start(Store::open_in_memory().unwrap(), hooks);
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

    watch
        .submit(
            "In a single message, call the Read tool twice in parallel: once on a.txt and once \
             on b.txt. Then reply with both contents, separated by a comma.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_kind(kinds::TOOL_CALL).await;
    watch.submit(BANANA, WhenBusy::Steer).await;
    steered.send(()).unwrap();
    watch.until_idle().await;

    assert!(
        watch.no_model_errors(),
        "the run failed: {}",
        watch.final_text()
    );
    let results: Vec<usize> = watch
        .entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.kind == kinds::TOOL_RESULT)
        .map(|(at, _)| at)
        .collect();
    let steer_at = watch
        .entries
        .iter()
        .position(|entry| entry.kind == kinds::USER && entry.data["text"] == BANANA)
        .expect("the steer joined the run");
    assert_eq!(results.len(), 2, "both reads have their result");
    assert!(
        results.iter().all(|&result_at| steer_at > result_at),
        "the steer joined after both reads: {:?}",
        watch.kinds()
    );
    assert!(
        watch.final_text().contains("BANANA"),
        "claude answered: {}",
        watch.final_text()
    );
}

#[tokio::test]
async fn two_steers_in_one_claude_turn_both_reach_claude_and_the_next_message_still_runs() {
    let scenario = Scenario::new("two_steers");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

    watch
        .submit(
            "Run the bash command `touch one.txt` with the Bash tool, then, as a separate call, \
             run `touch two.txt` with the Bash tool, then reply with exactly: done",
            WhenBusy::FollowUp,
        )
        .await;
    for steer in [BANANA, CHERRY] {
        let asked = watch.count(kinds::APPROVAL_REQUEST) + 1;
        watch
            .until("the next approval request", |watch| {
                watch.count(kinds::APPROVAL_REQUEST) == asked
            })
            .await;
        let request = watch.last(kinds::APPROVAL_REQUEST).clone();
        watch.submit(steer, WhenBusy::Steer).await;
        watch
            .resolve(request.data["call_id"].as_str().unwrap(), true)
            .await;
    }
    watch
        .until("an answer that heard both steers", |watch| {
            watch.status == ConversationStatus::Idle
                && watch.has(kinds::ASSISTANT)
                && watch.final_text().contains("BANANA")
                && watch.final_text().contains("CHERRY")
        })
        .await;
    assert_eq!(watch.count(kinds::USER), 3);

    let answers = watch.count(kinds::ASSISTANT);
    watch
        .submit("Reply with exactly: still here", WhenBusy::FollowUp)
        .await;
    watch.until_answered(answers + 1).await;
    assert!(watch.no_model_errors(), "the next message failed");
    assert!(
        watch.final_text().contains("still here"),
        "claude answered: {}",
        watch.final_text()
    );
    scenario.keep_recording(&watch.conversation);
}

/// The store as a crash right after each of its commits would leave it on disk: a copy of the
/// database with its write-ahead log cut after that commit.
fn crash_points(database: &Path) -> Vec<tempfile::TempDir> {
    let main = std::fs::read(database).unwrap();
    let log = std::fs::read(format!("{}-wal", database.display())).unwrap();
    let word = |at: usize| u32::from_be_bytes(log[at..at + 4].try_into().unwrap());
    let frame = 24 + word(8) as usize;
    let salts = &log[16..24];
    let mut points = Vec::new();
    let mut end = 32;
    while end + frame <= log.len() && log[end + 8..end + 16] == *salts {
        let ends_a_commit = word(end + 4) != 0;
        end += frame;
        if ends_a_commit {
            let copy = tempfile::tempdir().unwrap();
            std::fs::write(copy.path().join("nisse.sqlite"), &main).unwrap();
            std::fs::write(copy.path().join("nisse.sqlite-wal"), &log[..end]).unwrap();
            points.push(copy);
        }
    }
    assert!(
        (end - 32) / frame < 1000,
        "the log was checkpointed during the run, so the database no longer shows its start"
    );
    points
}

/// One of Claude's own messages in its main chain, and what Nisse commits of it.
struct ClaudeMessage {
    uuid: String,
    texts: Vec<String>,
    calls: Vec<String>,
    results: Vec<String>,
}

fn claude_chain(fixture: &Path) -> Vec<ClaudeMessage> {
    let fixture = std::fs::read_to_string(fixture).unwrap();
    let blocks = |frame: &Value, kind: &str, field: &str| -> Vec<String> {
        frame["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"] == kind)
            .filter_map(|block| block[field].as_str())
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
            .collect()
    };
    fixture
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|record| record["type"] == "emit_inbound")
        .map(|record| record["frame"].clone())
        .filter(|frame| frame["parent_tool_use_id"].is_null() && frame["isReplay"] != true)
        .filter(|frame| frame["type"] == "assistant" || frame["type"] == "user")
        .map(|frame| ClaudeMessage {
            uuid: frame["uuid"].as_str().unwrap().to_owned(),
            texts: blocks(&frame, "text", "text"),
            calls: blocks(&frame, "tool_use", "id"),
            results: blocks(&frame, "tool_result", "tool_use_id"),
        })
        .collect()
}

/// Whether `transcript` holds each part of Claude's message that the finished run committed.
fn committed_parts(message: &ClaudeMessage, transcript: &[Entry], finished: &[Entry]) -> Vec<bool> {
    let said = |entries: &[Entry], text: &str| {
        entries
            .iter()
            .any(|entry| entry.kind == kinds::ASSISTANT && entry.data["text"] == text)
    };
    let holds = |entries: &[Entry], kind: &str, field: &str, id: &str| {
        entries.iter().any(|entry| {
            entry.kind == kind && entry.data[field] == id && entry.data["denied"].is_null()
        })
    };
    let texts = message
        .texts
        .iter()
        .filter(|text| said(finished, text))
        .map(|text| said(transcript, text));
    let calls = message
        .calls
        .iter()
        .filter(|id| holds(finished, kinds::TOOL_CALL, "id", id))
        .map(|id| holds(transcript, kinds::TOOL_CALL, "id", id));
    let results = message
        .results
        .iter()
        .filter(|id| holds(finished, kinds::TOOL_RESULT, "call_id", id))
        .map(|id| holds(transcript, kinds::TOOL_RESULT, "call_id", id));
    texts.chain(calls).chain(results).collect()
}

/// Starts Nisse on a store and returns the message Nisse first resumes Claude's session at,
/// as a stand-in claude that records how it was started sees it.
fn resumed_at(store: &Path, conversation: &Conversation) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let claude_dir = tempfile::tempdir().unwrap();
    let claude = claude_dir.path().join("claude");
    std::fs::write(
        &claude,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/started\"\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let provider = Arc::new(Claude::new(ClaudeOptions::new(claude.clone())));
        let server = serve(Store::open(store).unwrap(), provider, Arc::new(NoHooks));
        let mut watch = Watch::existing(&server, conversation.clone()).await;
        watch.submit("Go on.", WhenBusy::FollowUp).await;
        watch
            .until("claude to be started", |watch| !watch.no_model_errors())
            .await;
    });
    runtime.shutdown_background();
    let started = std::fs::read_to_string(claude_dir.path().join("started")).unwrap();
    let first: Vec<&str> = started.lines().next().unwrap().split(' ').collect();
    first
        .windows(2)
        .find(|pair| pair[0] == "--resume-session-at")
        .map(|pair| pair[1].to_owned())
}

#[test]
fn a_crash_after_any_commit_resumes_claude_exactly_where_the_transcript_ends() {
    let scenario = Scenario::new("crash_points");
    std::fs::write(
        scenario.workspace.path().join("notes.txt"),
        "the gnome lives under the floor\n",
    )
    .unwrap();
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nisse.sqlite");

    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (conversation, finished, crashes) = runtime.block_on(async {
        let server = scenario.start(Store::open(&path).unwrap(), Arc::new(NoHooks));
        let mut watch =
            Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;
        watch
            .submit(
                "First write one short sentence saying that you will read the notes. Then use \
                 the Read tool to read notes.txt. Then reply with where the gnome lives, in \
                 three words.",
                WhenBusy::FollowUp,
            )
            .await;
        watch.until_idle().await;
        scenario.keep_recording(&watch.conversation);
        (
            watch.conversation.clone(),
            watch.entries.clone(),
            crash_points(&path),
        )
    });
    runtime.shutdown_background();

    let chain = claude_chain(&fixture_path(scenario.name));
    assert!(
        chain.iter().any(|message| !message.texts.is_empty())
            && chain.iter().any(|message| !message.calls.is_empty()),
        "the run has text and a call to commit"
    );
    for (commit, crash) in crashes.iter().enumerate() {
        let store = crash.path().join("nisse.sqlite");
        let transcript = {
            let store = Store::open(&store).unwrap();
            if store.conversation(&conversation.id).unwrap().is_none() {
                continue;
            }
            store.entries(&conversation.id, 0).unwrap()
        };
        let head = resumed_at(&store, &conversation);
        let covered = head.as_ref().map_or(0, |head| {
            1 + chain
                .iter()
                .position(|message| message.uuid == *head)
                .unwrap_or_else(|| panic!("resumed at {head}, which is not Claude's message"))
        });
        for (at, message) in chain.iter().enumerate() {
            let parts = committed_parts(message, &transcript, &finished);
            assert!(
                parts.iter().all(|committed| *committed == (at < covered)),
                "a crash after commit {commit} resumes claude at {head:?}, but the transcript \
                 holds {parts:?} of message {}",
                message.uuid
            );
        }
    }
}

/// A server whose only provider is `claude`, on Anthropic's own API whatever this machine's
/// environment says, so its account fields decide whether it is signed in. Every claude it
/// starts, in the workspace or not, replays the scenario.
fn serve_instance(scenario: &Scenario, config_dir: &Path) -> Arc<Server> {
    let mut options = ClaudeOptions::new(env!("CARGO_BIN_EXE_nisse-claude-replay"));
    options.config_dir = Some(config_dir.to_owned());
    options.env.insert(
        "ANTHROPIC_BASE_URL".into(),
        "https://api.anthropic.com".into(),
    );
    options.env.insert(
        "NISSE_CLAUDE_REPLAY_DIR".into(),
        scenario.workspace.path().to_string_lossy().into_owned(),
    );
    serve(
        Store::open_in_memory().unwrap(),
        Arc::new(Claude::new(options)),
        Arc::new(NoHooks),
    )
}

async fn claude_instance(client: &Client) -> ProviderSnapshot {
    let listed: ProvidersListResult = client
        .request(ClientRequest::ProvidersList(ProvidersListParams::default()))
        .await
        .unwrap();
    listed.providers.into_iter().next().unwrap()
}

async fn sign_in_reaches(
    notifications: &mut UnboundedReceiver<ServerNotification>,
    wanted: impl Fn(&AuthState) -> bool,
) -> AuthState {
    tokio::time::timeout(patience(), async {
        loop {
            match notifications.recv().await {
                Some(ServerNotification::AuthState(state)) if wanted(&state) => return state,
                Some(_) => {}
                None => panic!("the server hung up"),
            }
        }
    })
    .await
    .expect("the sign-in got there in time")
}

#[tokio::test]
async fn a_signed_out_claude_signs_in_with_claude_codes_own_command_in_a_terminal() {
    let scenario = Scenario::new("terminal_sign_in");
    let config_dir = tempfile::tempdir().unwrap();
    let server = serve_instance(&scenario, config_dir.path());
    let (client, mut notifications) = Client::new(server.connect_in_process());
    client.initialize("claude-test").await.unwrap();

    let before = claude_instance(&client).await;
    let started: AuthState = client
        .request(ClientRequest::AuthStart(AuthStartParams {
            provider: "claude".into(),
            method: None,
        }))
        .await
        .unwrap();
    let waiting = sign_in_reaches(&mut notifications, |state| {
        state.phase == AuthPhase::Waiting
    })
    .await;
    let answered: AuthAccepted = client
        .request(ClientRequest::AuthRespond(AuthRespondParams {
            provider: "claude".into(),
            flow_id: started.flow_id.clone(),
            response: AuthResponse::TerminalExited { success: true },
        }))
        .await
        .unwrap();
    let settled = sign_in_reaches(&mut notifications, |state| state.phase.is_over()).await;
    let after = claude_instance(&client).await;

    assert_eq!(before.health.status, ProviderStatus::SignedOut);
    assert_eq!(before.health.version.as_deref(), Some("2.1.310"));
    assert_eq!(before.sign_in, [AuthMethod::Terminal]);
    assert_eq!(
        waiting.interaction,
        Some(AuthInteraction::Terminal {
            command: vec![
                env!("CARGO_BIN_EXE_nisse-claude-replay").into(),
                "auth".into(),
                "login".into(),
            ],
            env: [(
                "CLAUDE_CONFIG_DIR".to_owned(),
                config_dir.path().to_string_lossy().into_owned(),
            )]
            .into(),
        })
    );
    assert!(answered.accepted);
    assert_eq!(settled.phase, AuthPhase::Succeeded, "{settled:?}");
    assert_eq!(
        settled.message.as_deref(),
        Some("person@example.com · Claude Max")
    );
    assert_eq!(after.health.status, ProviderStatus::Ready);
}

#[tokio::test]
async fn credentials_claude_s_api_refused_make_claude_read_signed_out() {
    let scenario = Scenario::new("auth_failed");
    let config_dir = tempfile::tempdir().unwrap();
    let server = serve_instance(&scenario, config_dir.path());
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), None).await;
    let before = claude_instance(&watch.client).await;

    watch.submit("hello", WhenBusy::FollowUp).await;
    watch.until_idle().await;
    let after = claude_instance(&watch.client).await;

    assert_eq!(before.health.status, ProviderStatus::Ready);
    assert_eq!(after.health.status, ProviderStatus::SignedOut);
}

#[tokio::test]
async fn claude_offers_the_models_claude_code_lists_with_the_efforts_each_takes() {
    let scenario = Scenario::new("models");
    let config_dir = tempfile::tempdir().unwrap();
    let server = serve_instance(&scenario, config_dir.path());
    let (client, _notifications) = Client::new(server.connect_in_process());
    client.initialize("claude-test").await.unwrap();

    let listed: ModelsListResult = client
        .request(ClientRequest::ModelsList(ModelsListParams::default()))
        .await
        .unwrap();

    let claude = &listed.providers[0];
    assert_eq!(claude.default_model, None);
    let models: Vec<(&str, &str)> = claude
        .models
        .iter()
        .map(|model| (model.id.as_str(), model.name.as_str()))
        .collect();
    assert_eq!(
        models,
        [
            ("sonnet", "Sonnet"),
            ("fable", "Fable"),
            ("opus", "Opus"),
            ("haiku", "Haiku")
        ]
    );
    assert_eq!(
        claude.models[2].efforts,
        ["low", "medium", "high", "xhigh", "max"]
    );
    assert_eq!(
        claude.models[2].description.as_deref(),
        Some("Opus 5.5 · Best for everyday, complex tasks")
    );
}

#[tokio::test]
async fn a_new_model_reaches_the_live_claude_and_a_new_effort_resumes_its_session() {
    let scenario = Scenario::new("switch_model");
    let server = scenario.start(Store::open_in_memory().unwrap(), Arc::new(NoHooks));
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), Some(MODEL)).await;

    watch
        .submit("Reply with exactly: one", WhenBusy::FollowUp)
        .await;
    watch.until_answers(1).await;
    watch.select("claude", Some(LARGER_MODEL), None).await;
    watch
        .submit("Reply with exactly: two", WhenBusy::FollowUp)
        .await;
    watch.until_answers(2).await;
    let second = watch.last(kinds::ASSISTANT).clone();
    watch
        .select("claude", Some(LARGER_MODEL), Some("low"))
        .await;
    watch
        .submit(
            "What were your two previous replies? Reply with just them, separated by a comma.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_answers(3).await;

    assert_eq!(second.data["text"], "two");
    assert_eq!(
        second.author,
        Actor::Model {
            model: LARGER_MODEL.into()
        }
    );
    assert_eq!(
        watch.final_text().to_lowercase().replace(' ', ""),
        "one,two"
    );
    scenario.keep_recording(&watch.conversation);
}

#[tokio::test]
async fn a_conversation_handed_to_claude_is_retold_its_first_turn_and_as_many_newest_as_fit() {
    let scenario = Scenario::new("handoff");
    let echo: Arc<dyn Provider> = Arc::new(Echo {
        think: Duration::ZERO,
    });
    let server = serve_providers(
        Store::open_in_memory().unwrap(),
        vec![("echo".into(), echo), ("claude".into(), scenario.claude())],
        Arc::new(NoHooks),
    );
    let mut watch = Watch::new_conversation(&server, scenario.workspace.path(), None).await;

    let long = format!("Filler to forget: {}", "lorem ipsum ".repeat(6_000));
    for (said, text) in ["Remember the word lantern.", &long, "Nothing else for now."]
        .into_iter()
        .enumerate()
    {
        watch.submit(text, WhenBusy::FollowUp).await;
        watch.until_answers(said + 1).await;
    }
    watch.select("claude", Some(MODEL), None).await;
    watch
        .submit(
            "Which word did I ask you to remember? Reply with just the word.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_answers(4).await;
    let remembered = watch.final_text().to_owned();
    watch.select("echo", None, None).await;
    watch.submit("plum", WhenBusy::FollowUp).await;
    watch.until_answers(5).await;
    watch.select("claude", Some(MODEL), None).await;
    watch
        .submit(
            "What was the last thing I said before this message? Reply with just that word.",
            WhenBusy::FollowUp,
        )
        .await;
    watch.until_answers(6).await;

    assert_eq!(remembered.to_lowercase().trim_end_matches('.'), "lantern");
    assert_eq!(
        watch.final_text().to_lowercase().trim_end_matches('.'),
        "plum"
    );
    scenario.keep_recording(&watch.conversation);
}
