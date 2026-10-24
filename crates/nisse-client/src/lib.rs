//! A typed client over any transport: an in-process server, or a server's unix socket.

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};

use anyhow::{Context, Result, anyhow};
use nisse_protocol::{
    ClientInfo, ClientRequest, InitializeParams, InitializeResult, Message, PROTOCOL_VERSION,
    RequestId, RpcError, ServerNotification,
    transport::{self, Channels},
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

type Waiters = HashMap<RequestId, oneshot::Sender<Result<Value, RpcError>>>;

type Pending = Arc<Mutex<Option<Waiters>>>;

#[derive(Clone)]
pub struct Client {
    outgoing: mpsc::Sender<Message>,
    pending: Pending,
    next_id: Arc<AtomicI64>,
}

impl Client {
    /// Wraps a connection; notifications arrive on the returned receiver, in order.
    pub fn new(channels: Channels) -> (Self, mpsc::UnboundedReceiver<ServerNotification>) {
        let Channels {
            outgoing,
            mut incoming,
        } = channels;
        let pending: Pending = Arc::new(Mutex::new(Some(Waiters::new())));
        let (notify, notifications) = mpsc::unbounded_channel();
        let routing = pending.clone();
        tokio::spawn(async move {
            while let Some(message) = incoming.recv().await {
                let (id, answer) = match message {
                    Message::Response(response) => (response.id, Ok(response.result)),
                    Message::Error(error) => (error.id, Err(error.error)),
                    Message::Notification(notification) => {
                        if let Some(known) = ServerNotification::from_notification(&notification) {
                            let _ = notify.send(known);
                        }
                        continue;
                    }
                    Message::Request(_) => continue,
                };
                let waiter = routing
                    .lock()
                    .expect("pending lock")
                    .as_mut()
                    .and_then(|waiters| waiters.remove(&id));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(answer);
                }
            }
            routing.lock().expect("pending lock").take();
        });
        (
            Self {
                outgoing,
                pending,
                next_id: Arc::new(AtomicI64::new(1)),
            },
            notifications,
        )
    }

    pub async fn connect_unix(
        path: &Path,
    ) -> Result<(Self, mpsc::UnboundedReceiver<ServerNotification>)> {
        let stream = tokio::net::UnixStream::connect(path)
            .await
            .with_context(|| format!("connecting to {}", path.display()))?;
        let (socket, _) = tokio_tungstenite::client_async("ws://localhost/rpc", stream).await?;
        Ok(Self::new(transport::websocket(socket)))
    }

    pub async fn initialize(&self, name: &str) -> Result<InitializeResult> {
        self.request(ClientRequest::Initialize(InitializeParams {
            client: ClientInfo {
                name: name.into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            protocol_version: PROTOCOL_VERSION,
            experimental: false,
        }))
        .await
    }

    pub async fn request<T: DeserializeOwned>(&self, call: ClientRequest) -> Result<T> {
        let id = RequestId::Integer(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (answer, answered) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending lock")
            .as_mut()
            .ok_or_else(closed)?
            .insert(id.clone(), answer);
        self.outgoing
            .send(Message::Request(call.into_request(id)))
            .await
            .map_err(|_| closed())?;
        let result = answered
            .await
            .map_err(|_| closed())?
            .map_err(|error| anyhow!("{} ({})", error.message, error.code))?;
        Ok(serde_json::from_value(result)?)
    }
}

fn closed() -> anyhow::Error {
    anyhow!("the server closed the connection")
}
