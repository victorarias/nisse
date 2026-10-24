//! The Nisse app server. Every transport becomes a pair of channels; one connection loop
//! serves them all.

mod setup;

use std::{collections::HashMap, future::Future, path::Path, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use nisse_core::{Harness, StartError, SubmitError};

use nisse_protocol::{
    Actor, ApprovalResolveResult, AuthAccepted, ClientInfo, ClientRequest, Commit,
    ConversationInterruptResult, ConversationListResult, ConversationSubscribeParams,
    ErrorResponse, InitializeResult, Message, ModelsListResult, PROTOCOL_VERSION,
    ProvidersListResult, Request, RequestId, Response, RpcError, Seq, ServerNotification,
    ServerStopResult, SkillsListResult, StatusChanged,
    transport::{self, Channels},
};
use serde::Serialize;
use setup::Setup;
use tokio::{
    net::UnixListener,
    sync::{
        broadcast,
        mpsc::{self, error::TrySendError},
        watch,
    },
};

pub struct Server {
    harness: Harness,
    setup: Arc<Setup>,
    owner: Actor,
    connections: watch::Sender<usize>,
    stopping: watch::Sender<bool>,
    closing: watch::Sender<bool>,
}

impl Server {
    pub fn new(harness: Harness, owner: Actor) -> Arc<Self> {
        let setup = Setup::new(harness.providers().to_vec());
        Arc::new(Self {
            harness,
            setup,
            owner,
            connections: watch::Sender::new(0),
            stopping: watch::Sender::new(false),
            closing: watch::Sender::new(false),
        })
    }

    pub fn harness(&self) -> &Harness {
        &self.harness
    }

    /// Returns once nothing needs the server: no run is going and no connection has been
    /// attached for `grace`, or a client asked it to stop and no run is going. Waiting costs
    /// nothing; it wakes only when a connection or a run comes or goes.
    pub async fn until_idle(&self, grace: Duration) {
        let mut connections = self.connections.subscribe();
        let mut runs = self.harness.runs();
        let mut stopping = self.stopping.subscribe();
        loop {
            let running = *runs.borrow_and_update() > 0;
            let attached = *connections.borrow_and_update() > 0;
            let stop = *stopping.borrow_and_update();
            if stop && !running {
                return;
            }
            let unneeded = async {
                if running || attached {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep(grace).await;
            };
            tokio::select! {
                () = unneeded => return,
                _ = connections.changed() => {}
                _ = runs.changed() => {}
                _ = stopping.changed() => {}
            }
        }
    }

    /// A client in this process: the TUI when no server is running.
    pub fn connect_in_process(self: &Arc<Self>) -> Channels {
        let (client, server) = transport::pair();
        tokio::spawn(self.clone().serve(server, self.owner.clone()));
        client
    }

    pub async fn serve_stdio(self: Arc<Self>) {
        let channels = transport::lines(tokio::io::stdin(), tokio::io::stdout());
        let owner = self.owner.clone();
        self.serve(channels, owner).await;
    }

    /// WebSocket over a unix socket. Whoever can open the socket is the owner. Whatever socket is
    /// at `path` is replaced, so only the process that serves the socket's home binds it.
    /// Closes every connection once it has sent its client everything already committed, so a
    /// client watching a run that just settled sees it settle. Waits at most `patience` for
    /// clients to acknowledge.
    pub async fn close(&self, patience: Duration) {
        self.closing.send_replace(true);
        let mut connections = self.connections.subscribe();
        let _ =
            tokio::time::timeout(patience, connections.wait_for(|attached| *attached == 0)).await;
    }

    pub fn bind_unix(path: &Path) -> Result<UnixListener> {
        if path.exists() {
            std::fs::remove_file(path)
                .with_context(|| format!("removing stale {}", path.display()))?;
        }
        UnixListener::bind(path).with_context(|| format!("binding {}", path.display()))
    }

    pub async fn serve_unix(self: Arc<Self>, listener: UnixListener) -> Result<()> {
        loop {
            let (stream, _) = listener.accept().await?;
            let server = self.clone();
            tokio::spawn(async move {
                match tokio_tungstenite::accept_async(stream).await {
                    Ok(socket) => {
                        server
                            .clone()
                            .serve(transport::websocket(socket), server.owner.clone())
                            .await
                    }
                    Err(error) => eprintln!("nisse: websocket handshake failed: {error}"),
                }
            });
        }
    }

    pub async fn serve(self: Arc<Self>, channels: Channels, actor: Actor) {
        let Channels {
            outgoing,
            mut incoming,
        } = channels;
        self.connections.send_modify(|attached| *attached += 1);
        let _attached = Attached(self.clone());
        let (subscribe, subscriptions) = mpsc::unbounded_channel();
        let mut forwarder = tokio::spawn(forward(self.clone(), outgoing.clone(), subscriptions));
        let mut closing = self.closing.subscribe();
        let mut connection = Connection {
            server: self,
            actor,
            initialized: false,
            asked_to_stop: false,
            subscribe,
            outgoing: outgoing.clone(),
        };
        loop {
            let message = tokio::select! {
                message = incoming.recv() => message,
                _ = &mut forwarder => None,
                () = until_closing(&mut closing) => {
                    let _ = (&mut forwarder).await;
                    drop(outgoing);
                    while incoming.recv().await.is_some() {}
                    return;
                }
            };
            let Some(message) = message else { break };
            let Message::Request(request) = message else {
                continue;
            };
            let Some(reply) = connection.handle(&request).await else {
                continue;
            };
            let message = match reply {
                Ok(result) => Message::Response(Response {
                    id: request.id,
                    result,
                }),
                Err(error) => Message::Error(ErrorResponse {
                    id: request.id,
                    error,
                }),
            };
            if outgoing.send(message).await.is_err() {
                break;
            }
        }
        forwarder.abort();
        if connection.asked_to_stop {
            connection.server.stopping.send_replace(true);
        }
    }
}

struct Attached(Arc<Server>);

impl Drop for Attached {
    fn drop(&mut self) {
        self.0.connections.send_modify(|attached| *attached -= 1);
    }
}

struct Connection {
    server: Arc<Server>,
    actor: Actor,
    initialized: bool,
    subscribe: mpsc::UnboundedSender<(RequestId, ConversationSubscribeParams)>,
    /// The server stops once this connection, which asked it to, has closed.
    asked_to_stop: bool,
    outgoing: mpsc::Sender<Message>,
}

impl Connection {
    /// `None` when the answer is sent elsewhere: a subscription is answered by the forwarder,
    /// and a slow answer by a task of its own, so the connection's other requests don't wait.
    async fn handle(&mut self, request: &Request) -> Option<Result<serde_json::Value, RpcError>> {
        let call = match ClientRequest::from_request(request) {
            Ok(call) => call,
            Err(error) => return Some(Err(error)),
        };
        if !self.initialized && !matches!(call, ClientRequest::Initialize(_)) {
            return Some(Err(RpcError::new(
                RpcError::INVALID_REQUEST,
                "initialize first",
            )));
        }
        let harness = &self.server.harness;
        Some(match call {
            ClientRequest::Initialize(params) => {
                if params.protocol_version != PROTOCOL_VERSION {
                    return Some(Err(RpcError::new(
                        RpcError::INVALID_REQUEST,
                        format!(
                            "this server speaks protocol {PROTOCOL_VERSION}, not {}",
                            params.protocol_version
                        ),
                    )));
                }
                self.initialized = true;
                to_result(InitializeResult {
                    server: ClientInfo {
                        name: "nisse".into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                    },
                    protocol_version: PROTOCOL_VERSION,
                    actor: self.actor.clone(),
                })
            }
            ClientRequest::ConversationStart(params) => {
                match harness.start_conversation(params, &self.actor).await {
                    Ok(conversation) => to_result(conversation),
                    Err(error) => Err(start_error(error)),
                }
            }
            ClientRequest::ConversationSelectModel(params) => {
                match harness.select_model(params, &self.actor) {
                    Ok(conversation) => to_result(conversation),
                    Err(error) => Err(start_error(error)),
                }
            }
            ClientRequest::ModelsList(params) => {
                let setup = self.server.setup.clone();
                self.answer_later(request.id.clone(), async move {
                    let providers = setup.models(params.refresh).await;
                    to_result(ModelsListResult { providers })
                });
                return None;
            }
            ClientRequest::ServerStop(_) => {
                self.asked_to_stop = true;
                to_result(ServerStopResult {})
            }
            ClientRequest::ConversationList(_) => harness
                .conversations()
                .map_err(internal)
                .and_then(|conversations| to_result(ConversationListResult { conversations })),
            ClientRequest::ConversationRead(params) => harness
                .read(&params.conversation_id, params.since_seq)
                .map_err(not_found)
                .and_then(to_result),
            ClientRequest::ApprovalResolve(params) => harness
                .resolve(params, self.actor.clone())
                .map_err(internal)
                .and_then(|accepted| to_result(ApprovalResolveResult { accepted })),
            ClientRequest::SkillsList(params) => {
                let harness = harness.clone();
                tokio::task::spawn_blocking(move || harness.skills(&params.conversation_id))
                    .await
                    .map_err(|error| internal(error.into()))
                    .and_then(|skills| skills.map_err(not_found))
                    .and_then(|skills| to_result(SkillsListResult { skills }))
            }
            ClientRequest::ProvidersList(params) => {
                let setup = self.server.setup.clone();
                self.answer_later(request.id.clone(), async move {
                    let providers = setup.list(params.refresh).await;
                    to_result(ProvidersListResult { providers })
                });
                return None;
            }
            ClientRequest::AuthLogout(params) => {
                let setup = self.server.setup.clone();
                self.answer_later(request.id.clone(), async move {
                    setup.logout(&params.provider).await.and_then(to_result)
                });
                return None;
            }
            ClientRequest::AuthStart(params) => self.server.setup.start(params).and_then(to_result),
            ClientRequest::AuthRespond(params) => to_result(AuthAccepted {
                accepted: self.server.setup.respond(params),
            }),
            ClientRequest::AuthCancel(params) => to_result(AuthAccepted {
                accepted: self.server.setup.cancel(params),
            }),
            ClientRequest::ConversationSubscribe(params) => {
                let _ = self.subscribe.send((request.id.clone(), params));
                return None;
            }
            ClientRequest::ConversationSubmit(params) => harness
                .submit(params, self.actor.clone())
                .await
                .map_err(refused)
                .and_then(to_result),
            ClientRequest::ConversationInterrupt(params) => harness
                .interrupt(&params.conversation_id)
                .map_err(refused)
                .and_then(|interrupted| to_result(ConversationInterruptResult { interrupted })),
        })
    }
}

fn refused(error: SubmitError) -> RpcError {
    let reason = match error {
        SubmitError::Failed(error) => return internal(error),
        SubmitError::NotFound(_) | SubmitError::ReservedKind(_) => {
            return RpcError::new(RpcError::INVALID_PARAMS, error.to_string());
        }
        SubmitError::Busy => "busy",
        SubmitError::Denied(_) => "denied",
        SubmitError::Hosted => "hosted",
    };
    RpcError {
        code: RpcError::INVALID_REQUEST,
        message: error.to_string(),
        data: Some(serde_json::json!({ "reason": reason })),
    }
}

impl Connection {
    fn answer_later(
        &self,
        id: RequestId,
        answer: impl Future<Output = Result<serde_json::Value, RpcError>> + Send + 'static,
    ) {
        let outgoing = self.outgoing.clone();
        tokio::spawn(async move {
            let message = match answer.await {
                Ok(result) => Message::Response(Response { id, result }),
                Err(error) => Message::Error(ErrorResponse { id, error }),
            };
            let _ = outgoing.send(message).await;
        });
    }
}

/// Everything a connection hears, from one task, so it arrives in commit order. A subscription
/// is answered here too: every commit this task has already passed is in the snapshot, and every
/// later one is still ahead of it in its queue.
async fn forward(
    server: Arc<Server>,
    outgoing: mpsc::Sender<Message>,
    mut subscriptions: mpsc::UnboundedReceiver<(RequestId, ConversationSubscribeParams)>,
) {
    let mut commits = server.harness.subscribe();
    let mut closing = server.closing.subscribe();
    let mut sign_ins = server.setup.subscribe();
    let mut subscribed: HashMap<String, Seq> = HashMap::new();
    loop {
        let commit = tokio::select! {
            () = until_closing(&mut closing) => {
                while let Ok(commit) = commits.try_recv() {
                    if !deliver(&outgoing, &subscribed, commit) {
                        return;
                    }
                }
                return;
            }
            commit = commits.recv() => match commit {
                Ok(commit) => commit,
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    eprintln!("nisse: a connection missed {missed} commits; closing it so it resubscribes");
                    return;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            state = sign_ins.recv() => {
                if let Ok(state) = state && !offer(&outgoing, ServerNotification::AuthState(state)) {
                    return;
                }
                continue;
            }
            subscription = subscriptions.recv() => {
                let Some((id, params)) = subscription else { return };
                let reply = match server.harness.read(&params.conversation_id, params.since_seq) {
                    Ok(snapshot) => {
                        subscribed.insert(params.conversation_id, snapshot.seq);
                        to_result(snapshot)
                    }
                    Err(error) => Err(not_found(error)),
                };
                let message = match reply {
                    Ok(result) => Message::Response(Response { id, result }),
                    Err(error) => Message::Error(ErrorResponse { id, error }),
                };
                if outgoing.try_send(message).is_err() {
                    return;
                }
                continue;
            }
        };
        if !deliver(&outgoing, &subscribed, commit) {
            return;
        }
    }
}

/// Offers a commit's status to the client, and the commit itself when it is subscribed to its
/// conversation. False once the client can no longer keep up.
fn deliver(
    outgoing: &mpsc::Sender<Message>,
    subscribed: &HashMap<String, Seq>,
    commit: Commit,
) -> bool {
    if let Some(status) = commit.status {
        let changed = StatusChanged {
            conversation_id: commit.conversation_id.clone(),
            status,
            seq: commit.seq,
        };
        if !offer(outgoing, ServerNotification::Status(changed)) {
            return false;
        }
    }
    let wanted = subscribed
        .get(&commit.conversation_id)
        .is_some_and(|&from| commit.seq > from);
    !wanted || offer(outgoing, ServerNotification::Committed(commit))
}

async fn until_closing(closing: &mut watch::Receiver<bool>) {
    let _ = closing.wait_for(|closing| *closing).await;
}

/// Never waits on a slow client: a full queue drops this client's notifications for good.
fn offer(outgoing: &mpsc::Sender<Message>, notification: ServerNotification) -> bool {
    match outgoing.try_send(Message::Notification(notification.into_notification())) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            eprintln!(
                "nisse: a client fell {} messages behind; it must resubscribe",
                transport::QUEUE_CAPACITY
            );
            false
        }
        Err(TrySendError::Closed(_)) => false,
    }
}

fn to_result(value: impl Serialize) -> Result<serde_json::Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|error| RpcError::new(RpcError::INTERNAL, error.to_string()))
}

fn internal(error: anyhow::Error) -> RpcError {
    RpcError::new(RpcError::INTERNAL, format!("{error:#}"))
}

fn start_error(error: StartError) -> RpcError {
    match error {
        StartError::Failed(error) => internal(error),
        error => RpcError::new(RpcError::INVALID_PARAMS, error.to_string()),
    }
}

fn not_found(error: anyhow::Error) -> RpcError {
    RpcError::new(RpcError::INVALID_PARAMS, format!("{error:#}"))
}
