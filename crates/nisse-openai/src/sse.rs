use anyhow::{Context, Result};
use futures_util::{Stream, StreamExt};
use serde_json::Value;

/// The JSON events of a server-sent event stream, in order.
pub(crate) struct Events<S> {
    body: S,
    buffer: Vec<u8>,
    data: String,
}

impl<S, B, E> Events<S>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::error::Error + Send + Sync + 'static,
{
    pub fn new(body: S) -> Self {
        Self {
            body,
            buffer: Vec::new(),
            data: String::new(),
        }
    }

    /// The next event, or None once the stream has ended.
    pub async fn next(&mut self) -> Result<Option<Value>> {
        loop {
            if let Some(event) = self.buffered_event()? {
                return Ok(Some(event));
            }
            match self.body.next().await {
                Some(chunk) => self
                    .buffer
                    .extend_from_slice(chunk.context("the response stream broke")?.as_ref()),
                None => return Ok(None),
            }
        }
    }

    fn buffered_event(&mut self) -> Result<Option<Value>> {
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .context("the response stream is not UTF-8")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                let data = std::mem::take(&mut self.data);
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                return Ok(Some(
                    serde_json::from_str(&data).context("an event in the stream is not JSON")?,
                ));
            }
            if let Some(value) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
            }
        }
        Ok(None)
    }
}
