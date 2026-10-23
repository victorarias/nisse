//! The Nisse app server. Every transport becomes a pair of channels; one connection loop
//! serves them all.

use std::{path::Path, sync::Arc};

use anyhow::{Context, Result};
use nisse_core::{Harness, SubmitError};
use std::collections::HashMap;

use nisse_protocol::{
    Actor, ApprovalResolveResult, ClientInfo, ClientRequest, ConversationListResult,
    ConversationSubscribeParams, ErrorResponse, InitializeResult, Message, PROTOCOL_VERSION,
    Request, RequestId, Response, RpcError, Seq, ServerNotification, StatusChanged, UiChanged,
    transport::{self, Channels},
};
use serde::Serialize;
use tokio::{
    net::UnixListener,
    sync::{
        broadcast,
        mpsc::{self, error::TrySendError},
    },
};

pub struct Server {
    harness: Harness,
    ui: broadcast::Sender<UiChanged>,
    owner: Actor,
}

impl Server {
    pub fn new(harness: Harness, ui: broadcast::Sender<UiChanged>, owner: Actor) -> Arc<Self> {
        Arc::new(Self { harness, ui, owner })
    }

    pub fn harness(&self) -> &Harness {
        &self.harness
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

    /// WebSocket over a unix socket. Whoever can open the socket is the owner.
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
        let (subscribe, subscriptions) = mpsc::unbounded_channel();
        let mut forwarder = tokio::spawn(forward(self.clone(), outgoing.clone(), subscriptions));
        let mut connection = Connection {
            server: self,
            actor,
            initialized: false,
            subscribe,
        };
        loop {
            let message = tokio::select! {
                message = incoming.recv() => message,
                _ = &mut forwarder => None,
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
    }
}

struct Connection {
    server: Arc<Server>,
    actor: Actor,
    initialized: bool,
    subscribe: mpsc::UnboundedSender<(RequestId, ConversationSubscribeParams)>,
}

impl Connection {
    /// `None` when the answer is sent elsewhere: a subscription is answered by the forwarder.
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
                    model: harness.model().to_owned(),
                })
            }
            ClientRequest::ConversationCreate(params) => harness
                .create_conversation(params.title, &self.actor)
                .map_err(internal)
                .and_then(to_result),
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
            ClientRequest::ConversationSubscribe(params) => {
                let _ = self.subscribe.send((request.id.clone(), params));
                return None;
            }
            ClientRequest::ConversationSubmit(params) => {
                match harness.submit(params, self.actor.clone()).await {
                    Ok(result) => to_result(result),
                    Err(SubmitError::NotFound(id)) => Err(RpcError::new(
                        RpcError::INVALID_PARAMS,
                        format!("no conversation {id}"),
                    )),
                    Err(error @ (SubmitError::Busy | SubmitError::Denied(_))) => Err(RpcError {
                        code: RpcError::INVALID_REQUEST,
                        message: error.to_string(),
                        data: Some(serde_json::json!({
                            "reason": if matches!(error, SubmitError::Busy) { "busy" } else { "denied" }
                        })),
                    }),
                    Err(SubmitError::Failed(error)) => Err(internal(error)),
                }
            }
        })
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
    let mut ui = server.ui.subscribe();
    let mut subscribed: HashMap<String, Seq> = HashMap::new();
    loop {
        let commit = tokio::select! {
            commit = commits.recv() => match commit {
                Ok(commit) => commit,
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    eprintln!("nisse: a connection missed {missed} commits; closing it so it resubscribes");
                    return;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            changed = ui.recv() => {
                if let Ok(changed) = changed && !offer(&outgoing, ServerNotification::UiChanged(changed)) {
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
        if let Some(status) = commit.status {
            let changed = StatusChanged {
                conversation_id: commit.conversation_id.clone(),
                status,
                seq: commit.seq,
            };
            if !offer(&outgoing, ServerNotification::Status(changed)) {
                return;
            }
        }
        let wanted = subscribed
            .get(&commit.conversation_id)
            .is_some_and(|&from| commit.seq > from);
        if wanted && !offer(&outgoing, ServerNotification::Committed(commit)) {
            return;
        }
    }
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

fn not_found(error: anyhow::Error) -> RpcError {
    RpcError::new(RpcError::INVALID_PARAMS, format!("{error:#}"))
}
