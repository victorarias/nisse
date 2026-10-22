use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use nisse_core::{
    Provider, ProviderFuture, ToolCall, Turn, approval_for, builtin_tools, run_builtin_tool,
};
use nisse_protocol::{Entry, kinds};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    auth::{AUTH_BASE, Credentials, ORIGINATOR},
    record::Recorder,
    sse::Events,
};

pub const BASE_URL: &str = "https://chatgpt.com/backend-api";
pub const MODEL: &str = "gpt-6.1-sol";
const LONGEST_ERROR_BODY: usize = 1000;

pub struct OpenAiOptions {
    /// The tokens `login` saved.
    pub auth_path: PathBuf,
    /// Where expired tokens are refreshed.
    pub auth_base: String,
    pub base_url: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub instructions: String,
    /// A folder to write one fixture per turn into.
    pub record: Option<PathBuf>,
}

impl OpenAiOptions {
    pub fn new(auth_path: impl Into<PathBuf>, instructions: impl Into<String>) -> Self {
        Self {
            auth_path: auth_path.into(),
            auth_base: AUTH_BASE.into(),
            base_url: BASE_URL.into(),
            model: MODEL.into(),
            reasoning_effort: None,
            instructions: instructions.into(),
            record: None,
        }
    }
}

pub struct OpenAi {
    options: OpenAiOptions,
    http: reqwest::Client,
    signing_in: Mutex<()>,
}

#[derive(Default)]
struct Response {
    messages: Vec<String>,
    calls: Vec<ToolCall>,
}

impl OpenAi {
    pub fn new(options: OpenAiOptions) -> Result<Self> {
        Ok(Self {
            options,
            http: crate::http_client()?,
            signing_in: Mutex::new(()),
        })
    }

    async fn answer(&self, turn: &Turn) -> Result<()> {
        let mut recorder = Recorder::start(self.options.record.as_deref(), &self.options.model)?;
        loop {
            let body = self.request_body(turn.conversation_id(), &turn.transcript()?);
            let Response {
                mut messages,
                calls,
            } = self.respond(turn, &body, &mut recorder).await?;
            if calls.is_empty() {
                let last = messages.pop();
                for message in &messages {
                    turn.say(message)?;
                }
                if let Some(last) = last {
                    turn.answer(&last)?;
                }
                return Ok(());
            }
            for message in &messages {
                turn.say(message)?;
            }
            for call in calls {
                let approval = approval_for(&call.name);
                turn.call_tool(call, approval, run_builtin_tool).await?;
            }
        }
    }

    fn request_body(&self, conversation_id: &str, transcript: &[Entry]) -> Value {
        let tools: Vec<Value> = builtin_tools()
            .into_iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                    "strict": false,
                })
            })
            .collect();
        let mut body = json!({
            "model": self.options.model,
            "instructions": self.options.instructions,
            "input": transcript.iter().filter_map(input_item).collect::<Vec<_>>(),
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "store": false,
            "stream": true,
            "prompt_cache_key": conversation_id,
        });
        if let Some(effort) = &self.options.reasoning_effort {
            body["reasoning"] = json!({ "effort": effort });
        }
        body
    }

    async fn respond(
        &self,
        turn: &Turn,
        body: &Value,
        recorder: &mut Recorder,
    ) -> Result<Response> {
        let (mut credentials, mut refreshed) = self.signed_in().await?;
        loop {
            recorder.outbound(body)?;
            let response = self
                .http
                .post(format!("{}/codex/responses", self.options.base_url))
                .bearer_auth(&credentials.access_token)
                .header("chatgpt-account-id", &credentials.account_id)
                .header("OpenAI-Beta", "responses=experimental")
                .header("originator", ORIGINATOR)
                .header("session-id", turn.conversation_id())
                .header("x-client-request-id", turn.conversation_id())
                .header("accept", "text/event-stream")
                .json(body)
                .send()
                .await
                .context("could not reach ChatGPT")?;
            let status = response.status();
            if status.is_success() {
                return read_stream(response, turn, recorder).await;
            }
            let text = response.text().await.unwrap_or_default();
            let error: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!(text));
            recorder.inbound(&json!({ "http": { "status": status.as_u16(), "body": error } }))?;
            if status == StatusCode::UNAUTHORIZED && !refreshed {
                credentials = self.refreshed_after_rejection(&credentials).await?;
                refreshed = true;
                continue;
            }
            bail!(http_failure(status, &error));
        }
    }

    /// The saved sign-in, refreshed first when it has expired. Refreshing rotates the refresh
    /// token, so runs in other conversations wait here rather than spend the same one twice.
    async fn signed_in(&self) -> Result<(Credentials, bool)> {
        let _held = self.signing_in.lock().await;
        let credentials = Credentials::load(&self.options.auth_path)?;
        if !credentials.is_expired() {
            return Ok((credentials, false));
        }
        Ok((self.refresh(&credentials).await?, true))
    }

    async fn refreshed_after_rejection(&self, rejected: &Credentials) -> Result<Credentials> {
        let _held = self.signing_in.lock().await;
        let saved = Credentials::load(&self.options.auth_path)?;
        if saved.access_token != rejected.access_token && !saved.is_expired() {
            return Ok(saved);
        }
        self.refresh(&saved).await
    }

    async fn refresh(&self, credentials: &Credentials) -> Result<Credentials> {
        let fresh = credentials
            .refreshed(&self.http, &self.options.auth_base)
            .await?;
        fresh.save(&self.options.auth_path)?;
        Ok(fresh)
    }
}

impl Provider for OpenAi {
    fn model(&self) -> &str {
        &self.options.model
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(self.answer(turn))
    }
}

fn input_item(entry: &Entry) -> Option<Value> {
    let data = &entry.data;
    match entry.kind.as_str() {
        kinds::USER => Some(json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": data["text"] }],
        })),
        kinds::ASSISTANT if data["is_error"] != true => Some(json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": data["text"] }],
        })),
        kinds::TOOL_CALL => Some(json!({
            "type": "function_call",
            "call_id": data["id"],
            "name": data["name"],
            "arguments": match &data["args"] {
                Value::String(unparsed) => unparsed.clone(),
                args => args.to_string(),
            },
        })),
        kinds::TOOL_RESULT => Some(json!({
            "type": "function_call_output",
            "call_id": data["call_id"],
            "output": match data["denied"].as_str() {
                Some(reason) => format!("denied: {reason}"),
                None => data["output"].as_str().unwrap_or_default().to_owned(),
            },
        })),
        _ => None,
    }
}

async fn read_stream(
    response: reqwest::Response,
    turn: &Turn,
    recorder: &mut Recorder,
) -> Result<Response> {
    let mut events = Events::new(response.bytes_stream());
    let mut finished = Response::default();
    let mut live = String::new();
    while let Some(event) = events.next().await? {
        recorder.inbound(&event)?;
        let item = &event["item"];
        match event["type"].as_str().unwrap_or_default() {
            "response.output_item.added" if item["type"] == "message" => live.clear(),
            "response.output_text.delta" | "response.refusal.delta" => {
                live.push_str(event["delta"].as_str().unwrap_or_default());
                turn.stream(&live);
            }
            "response.output_item.done" => match item["type"].as_str() {
                Some("message") => {
                    let text = message_text(item);
                    if !text.is_empty() {
                        finished.messages.push(text);
                    }
                }
                Some("function_call") => finished.calls.push(tool_call(item)?),
                _ => {}
            },
            "response.completed" | "response.done" => return Ok(finished),
            "response.incomplete" => bail!(
                "the response stopped early: {}",
                event["response"]["incomplete_details"]["reason"]
                    .as_str()
                    .unwrap_or("no reason given")
            ),
            "response.failed" => bail!(failure(&event["response"]["error"])),
            "error" => bail!(failure(match event.get("error") {
                Some(error) if error.is_object() => error,
                _ => &event,
            })),
            _ => {}
        }
    }
    bail!("the response stream ended before the response finished")
}

fn message_text(item: &Value) -> String {
    item["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str().or(part["refusal"].as_str()))
        .collect()
}

fn tool_call(item: &Value) -> Result<ToolCall> {
    let id = item["call_id"]
        .as_str()
        .ok_or_else(|| anyhow!("a function call without a call_id"))?;
    let arguments = item["arguments"].as_str().unwrap_or("{}");
    Ok(ToolCall {
        id: id.into(),
        name: item["name"].as_str().unwrap_or_default().into(),
        args: serde_json::from_str(arguments).unwrap_or_else(|_| json!(arguments)),
    })
}

fn http_failure(status: StatusCode, body: &Value) -> String {
    let error = &body["error"];
    if is_usage_limit(error) || status == StatusCode::TOO_MANY_REQUESTS {
        return usage_limit(error);
    }
    if status == StatusCode::UNAUTHORIZED {
        return "ChatGPT turned the sign-in down; sign in again".into();
    }
    let message = error["message"]
        .as_str()
        .or(body["detail"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let text = body
                .as_str()
                .map_or_else(|| body.to_string(), str::to_owned);
            let cut = text.floor_char_boundary(LONGEST_ERROR_BODY);
            text[..cut].to_owned()
        });
    format!("ChatGPT answered {status}: {message}")
}

fn failure(error: &Value) -> String {
    if is_usage_limit(error) {
        return usage_limit(error);
    }
    let code = error["code"].as_str().or(error["type"].as_str());
    let message = error["message"].as_str().unwrap_or("no details given");
    match code {
        Some(code) => format!("the response failed ({code}): {message}"),
        None => format!("the response failed: {message}"),
    }
}

fn is_usage_limit(error: &Value) -> bool {
    let code = error["code"].as_str().or(error["type"].as_str());
    matches!(
        code,
        Some("usage_limit_reached" | "usage_not_included" | "rate_limit_exceeded")
    )
}

fn usage_limit(error: &Value) -> String {
    let plan = error["plan_type"]
        .as_str()
        .map(|plan| format!(" ({} plan)", plan.to_lowercase()))
        .unwrap_or_default();
    let when = error["resets_at"]
        .as_i64()
        .map(|resets_at| {
            let minutes = ((resets_at * 1000 - nisse_core::now_ms()) / 60_000).max(0);
            format!(" Try again in about {minutes} min.")
        })
        .unwrap_or_default();
    format!("You have hit your ChatGPT usage limit{plan}.{when}")
}
