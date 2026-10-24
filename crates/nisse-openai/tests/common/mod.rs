//! A fake of OpenAI's sign-in and Responses servers, scripted from fixtures, and a real Nisse
//! server to drive the provider through.

#![allow(dead_code)]

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use nisse_client::Client;
use nisse_core::{Harness, HarnessOptions, Hooks, NoHooks, Store, Workspace, same_hooks};
use nisse_openai::{AuthServer, OpenAi, OpenAiOptions};
use nisse_protocol::{
    Actor, ApprovalResolveParams, ApprovalResolveResult, AuthAccepted, AuthInteraction, AuthMethod,
    AuthPhase, AuthRespondParams, AuthResponse, AuthStartParams, AuthState, ClientRequest,
    Conversation, ConversationReadResult, ConversationStartParams, ConversationStatus,
    ConversationSubmitParams, ConversationSubmitResult, ConversationSubscribeParams, Entry, Input,
    ProviderSnapshot, ProvidersListParams, ProvidersListResult, ServerNotification, WhenBusy,
    kinds,
};
use nisse_server::Server;
use reqwest::Url;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, broadcast, mpsc},
};

pub const PATIENCE: Duration = Duration::from_secs(10);
pub const ACCOUNT: &str = "acct-test";
pub const EMAIL: &str = "person@example.com";
pub const PROVIDER: &str = "openai";
pub const INSTRUCTIONS: &str = "You are a test.";
pub const DIRECT_MODEL: &str = "gpt-5.5";
pub const CODE_MODE_MODEL: &str = "gpt-6.1-sol";
const ANY: &str = "<any>";

#[derive(Debug, Clone)]
pub struct Received {
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Received {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).expect("a JSON body")
    }

    pub fn form(&self) -> HashMap<String, String> {
        Url::parse(&format!("http://form/?{}", self.body))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }
}

enum Reply {
    Http(u16, Value),
    Events(Vec<Value>),
}

#[derive(Default)]
struct Script {
    responses: VecDeque<Reply>,
    hold: Option<(usize, Arc<Notify>)>,
    tokens: VecDeque<Value>,
    received: Vec<Received>,
}

/// OpenAI as the provider sees it: sign-in endpoints and `/codex/responses`.
pub struct Fake {
    pub base: String,
    script: Arc<Mutex<Script>>,
}

impl Fake {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let script = Arc::new(Mutex::new(Script::default()));
        let serving = script.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, serving.clone()));
            }
        });
        Self { base, script }
    }

    /// Scripts the replies of a fixture and returns the requests it expects, in order.
    pub fn play(&self, fixture: &str) -> Vec<Value> {
        self.play_file(Path::new(&format!(
            "{}/tests/fixtures/{fixture}.ndjson",
            env!("CARGO_MANIFEST_DIR")
        )))
    }

    pub fn play_file(&self, path: &Path) -> Vec<Value> {
        let text = std::fs::read_to_string(path).unwrap();
        let mut expected = Vec::new();
        let mut replies: Vec<Vec<Value>> = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let line: Value = serde_json::from_str(line).unwrap();
            match line["type"].as_str().unwrap() {
                "expect_outbound" => {
                    expected.push(line["frame"].clone());
                    replies.push(Vec::new());
                }
                "emit_inbound" => replies.last_mut().unwrap().push(line["frame"].clone()),
                _ => {}
            }
        }
        let mut script = self.script.lock().unwrap();
        for frames in replies {
            script.responses.push_back(match frames.first() {
                Some(frame) if frame.get("http").is_some() => Reply::Http(
                    frame["http"]["status"].as_u64().unwrap() as u16,
                    frame["http"]["body"].clone(),
                ),
                _ => Reply::Events(frames),
            });
        }
        expected
    }

    /// The next answer of the token endpoint: an access token for `label`.
    pub fn issue_tokens(&self, label: &str, expires_in: i64) {
        self.script.lock().unwrap().tokens.push_back(json!({
            "access_token": access_token(label),
            "refresh_token": format!("{label}-refresh"),
            "id_token": "unused",
            "expires_in": expires_in,
        }));
    }

    /// Makes the next streamed reply stop after `events` events until the returned bell rings.
    pub fn hold_after(&self, events: usize) -> Arc<Notify> {
        let release = Arc::new(Notify::new());
        self.script.lock().unwrap().hold = Some((events, release.clone()));
        release
    }

    pub fn received(&self, path: &str) -> Vec<Received> {
        self.script
            .lock()
            .unwrap()
            .received
            .iter()
            .filter(|request| request.path == path)
            .cloned()
            .collect()
    }

    pub fn auth_server(&self) -> AuthServer {
        AuthServer {
            base: self.base.clone(),
            callback_port: 0,
        }
    }
}

pub fn access_token(label: &str) -> String {
    let claims = json!({
        "label": label,
        "https://api.openai.com/auth": { "chatgpt_account_id": ACCOUNT, "chatgpt_plan_type": "plus" },
        "https://api.openai.com/profile": { "email": EMAIL },
    });
    format!(
        "e30.{}.signature",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

async fn serve(mut stream: TcpStream, script: Arc<Mutex<Script>>) {
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    let (reply, hold) = {
        let mut script = script.lock().unwrap();
        script.received.push(request.clone());
        match request.path.as_str() {
            "/codex/responses" => match script.responses.pop_front() {
                Some(events @ Reply::Events(_)) => (events, script.hold.take()),
                Some(reply) => (reply, None),
                None => (
                    Reply::Http(500, json!({ "detail": "nothing scripted" })),
                    None,
                ),
            },
            "/oauth/token" => match script.tokens.pop_front() {
                Some(tokens) => (Reply::Http(200, tokens), None),
                None => (Reply::Http(400, json!({ "error": "invalid_grant" })), None),
            },
            "/api/accounts/deviceauth/usercode" => (
                Reply::Http(
                    200,
                    json!({ "device_auth_id": "device-1", "user_code": "WXYZ-1234", "interval": "0" }),
                ),
                None,
            ),
            "/api/accounts/deviceauth/token" => (
                Reply::Http(
                    200,
                    json!({ "authorization_code": "device-code", "code_verifier": "device-verifier" }),
                ),
                None,
            ),
            _ => (Reply::Http(404, json!({ "detail": "not found" })), None),
        }
    };
    match reply {
        Reply::Http(status, body) => {
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {status} Scripted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
        Reply::Events(events) => {
            let head =
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes()).await;
            for (sent, event) in events.iter().enumerate() {
                if let Some((after, release)) = &hold
                    && sent == *after
                {
                    release.notified().await;
                }
                let event = format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap_or_default()
                );
                let _ = stream.write_all(event.as_bytes()).await;
            }
        }
    }
    let _ = stream.shutdown().await;
}

async fn read_request(stream: &mut TcpStream) -> Option<Received> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&bytes[..head_end]).into_owned();
    let mut lines = head.lines();
    let target = lines.next()?.split_whitespace().nth(1)?.to_owned();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|length| length.parse().ok())
        .unwrap_or(0);
    while bytes.len() < head_end + length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Some(Received {
        path: target.split('?').next()?.to_owned(),
        headers,
        body: String::from_utf8_lossy(&bytes[head_end..head_end + length]).into_owned(),
    })
}

/// Whether `actual` is `expected`, where "<any>" in `expected` stands for any present value.
pub fn matches(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::String(any), _) if any == ANY => true,
        (Value::Object(expected), Value::Object(actual)) => {
            expected.len() == actual.len()
                && expected.iter().all(|(key, value)| {
                    actual.get(key).is_some_and(|actual| matches(value, actual))
                })
        }
        (Value::Array(expected), Value::Array(actual)) => {
            expected.len() == actual.len()
                && expected
                    .iter()
                    .zip(actual)
                    .all(|(expected, actual)| matches(expected, actual))
        }
        _ => expected == actual,
    }
}

pub fn assert_requests(fake: &Fake, expected: &[Value]) {
    let sent: Vec<Value> = fake
        .received("/codex/responses")
        .iter()
        .map(Received::json)
        .collect();
    assert_eq!(sent.len(), expected.len(), "requests sent: {sent:#?}");
    for (expected, sent) in expected.iter().zip(&sent) {
        assert!(
            matches(expected, sent),
            "expected\n{expected:#}\nsent\n{sent:#}"
        );
    }
}

/// Signs in through the browser flow against `fake`, answering as the browser would, and
/// returns what the browser was told.
pub async fn sign_in(fake: &Fake, auth_path: &Path) -> reqwest::StatusCode {
    let mut nisse = Nisse::start(fake, auth_path).await;
    let waiting = nisse.start_sign_in(None).await;
    let status = reqwest::get(answer(&waiting, "the-code"))
        .await
        .unwrap()
        .status();
    let settled = nisse.sign_in_settles().await;
    assert_eq!(settled.phase, AuthPhase::Succeeded, "{settled:?}");
    status
}

/// Where the browser returns to after signing in, with `code`.
pub fn answer(waiting: &AuthState, code: &str) -> Url {
    let Some(AuthInteraction::Browser { url }) = &waiting.interaction else {
        panic!("the sign-in waits for a browser: {waiting:?}");
    };
    let url = Url::parse(url).unwrap();
    let mut callback = Url::parse(&param(&url, "redirect_uri")).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", &param(&url, "state"));
    callback
}

pub fn param(url: &Url, name: &str) -> String {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .unwrap()
}

pub fn owner() -> Actor {
    Actor::Person {
        id: "owner".into(),
        name: "owner".into(),
    }
}

/// A real Nisse server whose model is the OpenAI provider, pointed at `fake`.
pub struct Nisse {
    pub client: Client,
    notifications: mpsc::UnboundedReceiver<ServerNotification>,
    pub conversation: Conversation,
    committed: Vec<Entry>,
    pub server: Arc<Server>,
    _workspace: Option<tempfile::TempDir>,
}

impl Nisse {
    /// On a model that takes direct tools.
    pub async fn start(fake: &Fake, auth_path: &Path) -> Self {
        Self::with(fake, auth_path, DIRECT_MODEL, |_| {}).await
    }

    pub async fn recording(fake: &Fake, auth_path: &Path, record: Option<&Path>) -> Self {
        Self::with(fake, auth_path, DIRECT_MODEL, |options| {
            options.record = record.map(Path::to_owned)
        })
        .await
    }

    pub async fn with(
        fake: &Fake,
        auth_path: &Path,
        model: &str,
        change: impl FnOnce(&mut OpenAiOptions),
    ) -> Self {
        Self::with_hooks(fake, auth_path, model, change, Arc::new(NoHooks)).await
    }

    pub async fn with_hooks(
        fake: &Fake,
        auth_path: &Path,
        model: &str,
        change: impl FnOnce(&mut OpenAiOptions),
        hooks: Arc<dyn Hooks>,
    ) -> Self {
        let empty = tempfile::tempdir().unwrap();
        let workspace = Workspace {
            cwd: std::env::current_dir().unwrap(),
            home: empty.path().to_owned(),
        };
        let mut nisse = Self::build(fake, auth_path, model, change, hooks, workspace).await;
        nisse._workspace = Some(empty);
        nisse
    }

    /// On a model that takes direct tools, with a conversation in `workspace`'s directory.
    pub async fn in_workspace(fake: &Fake, auth_path: &Path, workspace: Workspace) -> Self {
        Self::build(
            fake,
            auth_path,
            DIRECT_MODEL,
            |_| {},
            Arc::new(NoHooks),
            workspace,
        )
        .await
    }

    async fn build(
        fake: &Fake,
        auth_path: &Path,
        model: &str,
        change: impl FnOnce(&mut OpenAiOptions),
        hooks: Arc<dyn Hooks>,
        workspace: Workspace,
    ) -> Self {
        let mut options = OpenAiOptions::new(auth_path, INSTRUCTIONS, workspace.home);
        options.base_url = fake.base.clone();
        options.auth = fake.auth_server();
        change(&mut options);
        let provider = Arc::new(OpenAi::new(options).unwrap());
        let harness = Harness::with_store(
            Store::open_in_memory().unwrap(),
            HarnessOptions {
                providers: vec![(PROVIDER.into(), provider)],
                hooks: same_hooks(hooks),
            },
        );
        let server = Server::new(harness, broadcast::channel(16).0, owner());
        let (client, notifications) = Client::new(server.connect_in_process());
        client.initialize("openai-test").await.unwrap();
        let conversation: Conversation = client
            .request(ClientRequest::ConversationStart(ConversationStartParams {
                title: None,
                cwd: workspace.cwd,
                provider: None,
                model: Some(model.into()),
            }))
            .await
            .unwrap();
        let _: ConversationReadResult = client
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
            conversation,
            committed: Vec::new(),
            server,
            _workspace: None,
        }
    }

    /// Starts signing in by `method`, or the preferred one, and returns the state once it waits
    /// for a person.
    pub async fn start_sign_in(&mut self, method: Option<AuthMethod>) -> AuthState {
        let started: AuthState = self
            .client
            .request(ClientRequest::AuthStart(AuthStartParams {
                provider: PROVIDER.into(),
                method,
            }))
            .await
            .unwrap();
        assert_eq!(started.phase, AuthPhase::Starting);
        self.sign_in_reaches(|state| state.phase != AuthPhase::Starting)
            .await
    }

    /// The state the sign-in ends in.
    pub async fn sign_in_settles(&mut self) -> AuthState {
        self.sign_in_reaches(|state| state.phase.is_over()).await
    }

    pub async fn sign_in_reaches(&mut self, wanted: impl Fn(&AuthState) -> bool) -> AuthState {
        tokio::time::timeout(PATIENCE, async {
            loop {
                match self.notifications.recv().await {
                    Some(ServerNotification::AuthState(state)) if wanted(&state) => return state,
                    Some(_) => {}
                    None => panic!("the server hung up"),
                }
            }
        })
        .await
        .expect("the sign-in got there in time")
    }

    pub async fn respond(&self, state: &AuthState, response: AuthResponse) -> bool {
        let answered: AuthAccepted = self
            .client
            .request(ClientRequest::AuthRespond(AuthRespondParams {
                provider: state.provider.clone(),
                flow_id: state.flow_id.clone(),
                response,
            }))
            .await
            .unwrap();
        answered.accepted
    }

    pub async fn provider(&self) -> ProviderSnapshot {
        let listed: ProvidersListResult = self
            .client
            .request(ClientRequest::ProvidersList(ProvidersListParams {
                refresh: true,
            }))
            .await
            .unwrap();
        listed.providers.into_iter().next().unwrap()
    }

    /// Submits `text` and returns what the run committed until the conversation went idle,
    /// answering each approval it asks for with `allow`.
    pub async fn converse(&mut self, text: &str, allow: bool) -> Vec<Entry> {
        self.submit(text).await;
        self.finish(allow).await
    }

    pub async fn submit(&self, text: &str) {
        self.send(text, WhenBusy::FollowUp).await;
    }

    async fn send(&self, text: &str, when_busy: WhenBusy) {
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

    /// The first text the model is still writing that reaches clients.
    pub async fn live(&mut self) -> String {
        self.live_within(PATIENCE)
            .await
            .expect("live text arrived in time")
    }

    /// The first text the model is still writing that reaches clients within `window`, if any.
    pub async fn live_within(&mut self, window: Duration) -> Option<String> {
        tokio::time::timeout(window, async {
            loop {
                if let Some(ServerNotification::Committed(commit)) = self.notifications.recv().await
                {
                    self.committed.extend(commit.entries);
                    if let Some(live) = commit.live.filter(|live| !live.is_empty()) {
                        return live;
                    }
                }
            }
        })
        .await
        .ok()
    }

    pub async fn finish(&mut self, allow: bool) -> Vec<Entry> {
        self.finish_steering(allow, None).await
    }

    /// `finish`, sending `steer` while the first approval waits.
    pub async fn finish_steering(&mut self, allow: bool, mut steer: Option<&str>) -> Vec<Entry> {
        tokio::time::timeout(PATIENCE, async {
            while let Some(notification) = self.notifications.recv().await {
                match notification {
                    ServerNotification::Committed(commit) => {
                        for entry in commit.entries {
                            if entry.kind == kinds::APPROVAL_REQUEST {
                                if let Some(steer) = steer.take() {
                                    self.send(steer, WhenBusy::Steer).await;
                                }
                                self.resolve(&entry, allow).await;
                            }
                            self.committed.push(entry);
                        }
                    }
                    ServerNotification::Status(changed)
                        if changed.status == ConversationStatus::Idle
                            && self.committed.iter().any(|entry| entry.kind == kinds::USER) =>
                    {
                        return;
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("the run finished in time");
        std::mem::take(&mut self.committed)
    }

    /// The next entry of `kind` the run commits, keeping what it committed before for `finish`.
    pub async fn next(&mut self, kind: &str) -> Entry {
        tokio::time::timeout(PATIENCE, async {
            loop {
                if let Some(ServerNotification::Committed(commit)) = self.notifications.recv().await
                {
                    for entry in commit.entries {
                        self.committed.push(entry.clone());
                        if entry.kind == kind {
                            return entry;
                        }
                    }
                }
            }
        })
        .await
        .expect("the entry was committed in time")
    }

    async fn resolve(&self, request: &Entry, allow: bool) {
        let _: ApprovalResolveResult = self
            .client
            .request(ClientRequest::ApprovalResolve(ApprovalResolveParams {
                conversation_id: self.conversation.id.clone(),
                call_id: request.data["call_id"].as_str().unwrap().into(),
                allow,
                reason: None,
            }))
            .await
            .unwrap();
    }
}

/// The transcript as the model sees it: approvals are Nisse's business.
pub fn exchange(entries: &[Entry]) -> Vec<(String, Value)> {
    entries
        .iter()
        .filter(|entry| entry.kind != kinds::APPROVAL_REQUEST && entry.kind != kinds::APPROVAL)
        .map(|entry| (entry.kind.clone(), entry.data.clone()))
        .collect()
}

/// Codex's code-mode host at the release Nisse pins, installed once into the target directory,
/// or the one `NISSE_CODE_MODE_HOST` names.
pub fn code_mode_host() -> PathBuf {
    static HOST: OnceLock<PathBuf> = OnceLock::new();
    HOST.get_or_init(|| {
        if let Some(host) = std::env::var_os("NISSE_CODE_MODE_HOST") {
            return host.into();
        }
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let installed = std::process::Command::new(workspace.join("scripts/code-mode-host.sh"))
            .arg(workspace.join("target/code-mode-host"))
            .output()
            .expect("scripts/code-mode-host.sh runs");
        assert!(
            installed.status.success(),
            "installing the code-mode host failed: {}",
            String::from_utf8_lossy(&installed.stderr)
        );
        PathBuf::from(String::from_utf8(installed.stdout).unwrap().trim())
    })
    .clone()
}

/// Code-mode scripts run by the real host.
pub fn in_code_mode(options: &mut OpenAiOptions) {
    options.code_mode_host = code_mode_host();
}
