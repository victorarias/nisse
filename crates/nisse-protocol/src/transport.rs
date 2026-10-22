//! Moves protocol messages between a byte stream and a pair of channels, so the server and
//! clients handle every transport the same way.

use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message as Frame};

use crate::Message;

/// A connection's lag budget: a peer this far behind is disconnected rather than waited for.
pub const QUEUE_CAPACITY: usize = 4096;

pub struct Channels {
    pub outgoing: mpsc::Sender<Message>,
    pub incoming: mpsc::Receiver<Message>,
}

pub fn websocket<S>(socket: WebSocketStream<S>) -> Channels
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = socket.split();
    let (outgoing, mut to_send) = mpsc::channel::<Message>(QUEUE_CAPACITY);
    let (received, incoming) = mpsc::channel(QUEUE_CAPACITY);
    tokio::spawn(async move {
        while let Some(message) = to_send.recv().await {
            let Ok(text) = serde_json::to_string(&message) else {
                continue;
            };
            if sink.send(Frame::text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        while let Some(Ok(frame)) = stream.next().await {
            let text = match frame {
                Frame::Text(text) => text,
                Frame::Close(_) => break,
                _ => continue,
            };
            match serde_json::from_str(&text) {
                Ok(message) => {
                    if received.send(message).await.is_err() {
                        break;
                    }
                }
                Err(error) => eprintln!("nisse: dropped a malformed message: {error}"),
            }
        }
    });
    Channels { outgoing, incoming }
}

/// One JSON message per line, as on stdio.
pub fn lines<R, W>(reader: R, mut writer: W) -> Channels
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (outgoing, mut to_send) = mpsc::channel::<Message>(QUEUE_CAPACITY);
    let (received, incoming) = mpsc::channel(QUEUE_CAPACITY);
    tokio::spawn(async move {
        while let Some(message) = to_send.recv().await {
            let Ok(mut line) = serde_json::to_vec(&message) else {
                continue;
            };
            line.push(b'\n');
            if writer.write_all(&line).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str(&line) {
                Ok(message) => {
                    if received.send(message).await.is_err() {
                        break;
                    }
                }
                Err(error) => eprintln!("nisse: dropped a malformed message: {error}"),
            }
        }
    });
    Channels { outgoing, incoming }
}

/// Two ends of an in-process connection.
pub fn pair() -> (Channels, Channels) {
    let (to_server, from_client) = mpsc::channel(QUEUE_CAPACITY);
    let (to_client, from_server) = mpsc::channel(QUEUE_CAPACITY);
    (
        Channels {
            outgoing: to_server,
            incoming: from_server,
        },
        Channels {
            outgoing: to_client,
            incoming: from_client,
        },
    )
}
