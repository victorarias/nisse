//! Codex's `codex-code-mode-host`: a child process that runs each script in a fresh V8 isolate.
//! It speaks protocol version 1 on stdio, each frame a little-endian `u32` length and then JSON,
//! and multiplexes one session per conversation on one connection.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::mpsc,
};

const MAX_FRAME: usize = 64 * 1024 * 1024;
const KEPT_STDERR: usize = 4096;

/// What the host answers when a cell yields, finishes or is stopped.
#[derive(Debug, Deserialize)]
pub(crate) enum Runtime {
    Yielded {
        cell_id: String,
        content_items: Vec<Value>,
    },
    Terminated {
        cell_id: String,
        content_items: Vec<Value>,
    },
    Result {
        cell_id: String,
        content_items: Vec<Value>,
        error_text: Option<String>,
    },
}

/// A nested tool call a script made, for the run that started it to answer.
pub(crate) struct Delegated {
    pub id: i64,
    pub cell_id: String,
    pub runtime_call_id: String,
    pub tool: String,
    pub input: Value,
    pub connection: Arc<Connection>,
}

#[derive(Deserialize)]
#[serde(tag = "status")]
enum Outcome<T> {
    #[serde(rename = "ok")]
    Ok { value: T },
    #[serde(rename = "error")]
    Err { message: String },
}

impl<T> Outcome<T> {
    fn into_result(self) -> Result<T> {
        match self {
            Self::Ok { value } => Ok(value),
            Self::Err { message } => Err(anyhow!(message)),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Incoming {
    #[serde(rename = "connection/ready")]
    Ready {},
    #[serde(rename = "connection/rejected")]
    Rejected { reason: Value },
    #[serde(rename = "operation/response")]
    Response { id: i64, result: Outcome<Value> },
    #[serde(rename = "execute/initialResponse")]
    InitialResponse { id: i64, result: Outcome<Runtime> },
    #[serde(rename = "delegate/request", rename_all = "camelCase")]
    DelegateRequest {
        id: i64,
        session_id: String,
        request: Value,
    },
    #[serde(other)]
    Other,
}

enum Reply {
    Response(Result<Value>),
    Initial(Result<Runtime>),
}

type Routes = Mutex<HashMap<String, mpsc::UnboundedSender<Delegated>>>;

/// The host process, started on first use and stopped once no run has used it for `idle`.
pub(crate) struct Host {
    program: PathBuf,
    idle: Duration,
    connection: tokio::sync::Mutex<Option<Arc<Connection>>>,
    routes: Arc<Routes>,
    runs: Mutex<Runs>,
}

#[derive(Default)]
struct Runs {
    active: usize,
    generation: u64,
}

impl Host {
    pub fn new(program: PathBuf, idle: Duration) -> Self {
        Self {
            program,
            idle,
            connection: tokio::sync::Mutex::new(None),
            routes: Arc::default(),
            runs: Mutex::default(),
        }
    }

    pub fn program(&self) -> &std::path::Path {
        &self.program
    }

    /// Nested calls from `conversation`'s scripts go to `calls` until the run ends.
    pub fn begin_run(&self, conversation: &str, calls: mpsc::UnboundedSender<Delegated>) {
        let mut runs = self.runs.lock().expect("runs lock");
        runs.active += 1;
        runs.generation += 1;
        self.routes
            .lock()
            .expect("routes lock")
            .insert(conversation.to_owned(), calls);
    }

    pub fn end_run(self: &Arc<Self>, conversation: &str) {
        self.routes
            .lock()
            .expect("routes lock")
            .remove(conversation);
        let mut runs = self.runs.lock().expect("runs lock");
        runs.active -= 1;
        if runs.active > 0 {
            return;
        }
        let generation = runs.generation;
        let host = Arc::downgrade(self);
        let idle = self.idle;
        tokio::spawn(async move {
            tokio::time::sleep(idle).await;
            let Some(host) = host.upgrade() else {
                return;
            };
            let mut connection = host.connection.lock().await;
            let runs = host.runs.lock().expect("runs lock");
            if runs.active == 0 && runs.generation == generation {
                connection.take();
            }
        });
    }

    /// The running host with a session open for `conversation`, started when there is none.
    pub async fn session(&self, conversation: &str) -> Result<Arc<Connection>> {
        let connection = {
            let mut current = self.connection.lock().await;
            match current
                .as_ref()
                .filter(|connection| connection.is_running())
            {
                Some(connection) => connection.clone(),
                None => {
                    let started = Connection::start(&self.program, self.routes.clone()).await?;
                    *current = Some(started.clone());
                    started
                }
            }
        };
        connection.open_session(conversation).await?;
        Ok(connection)
    }
}

pub(crate) struct Connection {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    pending: Mutex<HashMap<i64, mpsc::UnboundedSender<Reply>>>,
    next_id: AtomicI64,
    sessions: tokio::sync::Mutex<HashSet<String>>,
    stopped: AtomicBool,
    stderr: Arc<Mutex<String>>,
    _child: Child,
}

impl Connection {
    async fn start(program: &std::path::Path, routes: Arc<Routes>) -> Result<Arc<Self>> {
        let mut child = Command::new(program)
            .args(["--listen", "stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("could not start {}", program.display()))?;
        let mut stdin = child.stdin.take().context("the host has no stdin")?;
        let mut stdout = child.stdout.take().context("the host has no stdout")?;
        let stderr = Arc::new(Mutex::new(String::new()));
        tokio::spawn(keep_tail(
            child.stderr.take().context("the host has no stderr")?,
            stderr.clone(),
        ));

        let hello = frame(&json!({
            "type": "connection/hello",
            "supportedVersions": [1],
            "requiredCapabilities": [],
            "optionalCapabilities": [],
        }));
        stdin.write_all(&hello).await?;
        stdin.flush().await?;
        match read_frame::<Incoming>(&mut stdout).await {
            Ok(Some(Incoming::Ready {})) => {}
            Ok(Some(Incoming::Rejected { reason })) => {
                bail!("the code-mode host turned Nisse down: {reason}")
            }
            Ok(_) | Err(_) => bail!(
                "the code-mode host did not answer its handshake{}",
                last_words(&stderr)
            ),
        }

        let (outgoing, mut queued) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(bytes) = queued.recv().await {
                if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        let connection = Arc::new(Self {
            outgoing,
            pending: Mutex::default(),
            next_id: AtomicI64::new(1),
            sessions: tokio::sync::Mutex::default(),
            stopped: AtomicBool::new(false),
            stderr,
            _child: child,
        });
        tokio::spawn(read_frames(stdout, Arc::downgrade(&connection), routes));
        Ok(connection)
    }

    fn is_running(&self) -> bool {
        !self.stopped.load(Ordering::Acquire)
    }

    async fn open_session(&self, conversation: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        if sessions.contains(conversation) {
            return Ok(());
        }
        self.operation(json!({ "method": "session/open", "sessionId": conversation }))
            .await?;
        sessions.insert(conversation.to_owned());
        Ok(())
    }

    /// Starts a cell and waits for its first answer. `started` learns the cell's id before
    /// anything the cell yields, so its nested calls can be told apart from the next cell's.
    pub async fn execute(
        &self,
        conversation: &str,
        request: Value,
        started: impl FnOnce(&str),
    ) -> Result<Runtime> {
        let (id, mut replies) = self.send(json!({
            "method": "session/execute",
            "sessionId": conversation,
            "request": request,
        }));
        let mut started = Some(started);
        let answer = loop {
            match replies.recv().await {
                Some(Reply::Response(Ok(response))) => {
                    if let (Some(cell_id), Some(started)) =
                        (response["cellId"].as_str(), started.take())
                    {
                        started(cell_id);
                    }
                }
                Some(Reply::Response(Err(error))) => break Err(error),
                Some(Reply::Initial(runtime)) => break runtime,
                None => break Err(self.stopped_error()),
            }
        };
        self.forget(id);
        answer
    }

    /// Waits up to `yield_time_ms` for more of a yielded cell. A cell this host doesn't have,
    /// because it finished or the host restarted, answers as finished with an error.
    pub async fn wait(
        &self,
        conversation: &str,
        cell_id: &str,
        yield_time_ms: u64,
    ) -> Result<Runtime> {
        self.waited(json!({
            "method": "session/wait",
            "sessionId": conversation,
            "request": { "cell_id": cell_id, "yield_time_ms": yield_time_ms },
        }))
        .await
    }

    pub async fn terminate(&self, conversation: &str, cell_id: &str) -> Result<Runtime> {
        self.waited(json!({
            "method": "session/terminate",
            "sessionId": conversation,
            "cellId": cell_id,
        }))
        .await
    }

    async fn waited(&self, request: Value) -> Result<Runtime> {
        let completed = self.operation(request).await?;
        let (_, runtime) = completed["outcome"]
            .as_object()
            .and_then(|outcome| outcome.iter().next())
            .context("the host's wait answer has no outcome")?;
        Ok(Runtime::deserialize(runtime)?)
    }

    pub fn answer(&self, id: i64, result: Result<Value, String>) {
        let result = match result {
            Ok(result) => {
                json!({ "status": "ok", "value": { "type": "tool/result", "result": result } })
            }
            Err(message) => json!({ "status": "error", "message": message }),
        };
        let _ = self.outgoing.send(frame(&json!({
            "type": "delegate/response",
            "id": id,
            "result": result,
        })));
    }

    async fn operation(&self, request: Value) -> Result<Value> {
        let (id, mut replies) = self.send(request);
        let answer = match replies.recv().await {
            Some(Reply::Response(response)) => response,
            Some(Reply::Initial(_)) => Err(anyhow!("the host answered out of turn")),
            None => Err(self.stopped_error()),
        };
        self.forget(id);
        answer
    }

    fn send(&self, request: Value) -> (i64, mpsc::UnboundedReceiver<Reply>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (replies, receiver) = mpsc::unbounded_channel();
        if self.is_running() {
            self.pending
                .lock()
                .expect("pending lock")
                .insert(id, replies);
            let _ = self.outgoing.send(frame(&json!({
                "type": "operation/request",
                "id": id,
                "request": request,
            })));
        }
        (id, receiver)
    }

    fn forget(&self, id: i64) {
        self.pending.lock().expect("pending lock").remove(&id);
    }

    fn stopped_error(&self) -> anyhow::Error {
        anyhow!("the code-mode host stopped{}", last_words(&self.stderr))
    }

    fn deliver(&self, id: i64, reply: Reply) {
        if let Some(replies) = self.pending.lock().expect("pending lock").get(&id) {
            let _ = replies.send(reply);
        }
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.pending.lock().expect("pending lock").clear();
    }
}

async fn read_frames(
    mut stdout: impl AsyncRead + Unpin,
    connection: Weak<Connection>,
    routes: Arc<Routes>,
) {
    while let Ok(Some(incoming)) = read_frame::<Incoming>(&mut stdout).await {
        let Some(connection) = connection.upgrade() else {
            return;
        };
        match incoming {
            Incoming::Response { id, result } => {
                connection.deliver(id, Reply::Response(result.into_result()))
            }
            Incoming::InitialResponse { id, result } => {
                connection.deliver(id, Reply::Initial(result.into_result()))
            }
            Incoming::DelegateRequest {
                id,
                session_id,
                request,
            } => delegate(id, &session_id, request, connection, &routes),
            Incoming::Ready {} | Incoming::Rejected { .. } | Incoming::Other => {}
        }
    }
    if let Some(connection) = connection.upgrade() {
        connection.stop();
    }
}

fn delegate(
    id: i64,
    session_id: &str,
    request: Value,
    connection: Arc<Connection>,
    routes: &Routes,
) {
    let invocation = &request["invocation"];
    if request["type"] != "tool/invoke" {
        connection.answer(id, Err("Nisse does not support this helper".into()));
        return;
    }
    let route = routes.lock().expect("routes lock").get(session_id).cloned();
    let call = Delegated {
        id,
        cell_id: invocation["cell_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        runtime_call_id: invocation["runtime_tool_call_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        tool: invocation["tool_name"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        input: invocation["input"].clone(),
        connection: connection.clone(),
    };
    let delivered = route.is_some_and(|route| route.send(call).is_ok());
    if !delivered {
        connection.answer(id, Err("the run that started this script has ended".into()));
    }
}

fn frame(message: &Value) -> Vec<u8> {
    let payload = message.to_string().into_bytes();
    let mut bytes = Vec::with_capacity(payload.len() + 4);
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&payload);
    bytes
}

async fn read_frame<T: DeserializeOwned>(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<Option<T>> {
    let mut length = [0u8; 4];
    if reader.read(&mut length[..1]).await? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut length[1..]).await?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_FRAME {
        bail!("the code-mode host sent a {length}-byte frame");
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await?;
    Ok(Some(serde_json::from_slice(&payload)?))
}

async fn keep_tail(mut stderr: impl AsyncRead + Unpin, tail: Arc<Mutex<String>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(read) = stderr.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        let mut tail = tail.lock().expect("stderr lock");
        tail.push_str(&String::from_utf8_lossy(&chunk[..read]));
        if tail.len() > KEPT_STDERR {
            let cut = tail.ceil_char_boundary(tail.len() - KEPT_STDERR);
            tail.drain(..cut);
        }
    }
}

fn last_words(stderr: &Mutex<String>) -> String {
    let tail = stderr.lock().expect("stderr lock");
    let last = tail.trim().lines().last().unwrap_or_default();
    if last.is_empty() {
        String::new()
    } else {
        format!(": {last}")
    }
}
