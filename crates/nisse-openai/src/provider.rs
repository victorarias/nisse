use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use nisse_core::{
    Approval, Provider, ProviderFuture, ToolCall, ToolOutcome, Turn, Workspace, approval_for,
    builtin_tools, run_builtin_tool,
};
use nisse_protocol::{Entry, Skill, kinds};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    auth::{AUTH_BASE, Credentials, ORIGINATOR},
    catalog::wants_code_mode,
    code_mode::{CodeMode, EXEC, HOST_PROGRAM, NestedTools, Run, WAIT},
    record::Recorder,
    sse::Events,
};

pub const BASE_URL: &str = "https://chatgpt.com/backend-api";
pub const MODEL: &str = "gpt-6.1-sol";
const LONGEST_ERROR_BODY: usize = 1000;
const SKILLS: &str = "# Skills

A skill is a folder of instructions for one kind of task, in a `SKILL.md` file. When a task \
matches a skill's description, `Read` its `SKILL.md` before you start, and follow it. When a \
message names a skill with `/name` or `$name`, the skill's `SKILL.md` comes with the message; \
follow it. Relative paths in a skill are relative to its folder.

";

pub struct OpenAiOptions {
    /// The tokens `login` saved.
    pub auth_path: PathBuf,
    /// Where expired tokens are refreshed.
    pub auth_base: String,
    pub base_url: String,
    /// Nisse's own instructions; the conversation's directory, its AGENTS.md files and its
    /// skills are added to them.
    pub instructions: String,
    /// The Nisse home, for its own AGENTS.md and skills.
    pub home: PathBuf,
    /// A folder to write one fixture per turn into.
    pub record: Option<PathBuf>,
    /// Codex's code-mode host, for the models that work in code mode.
    pub code_mode_host: PathBuf,
    pub nested_tools: NestedTools,
}

impl OpenAiOptions {
    pub fn new(
        auth_path: impl Into<PathBuf>,
        instructions: impl Into<String>,
        home: impl Into<PathBuf>,
    ) -> Self {
        Self {
            auth_path: auth_path.into(),
            auth_base: AUTH_BASE.into(),
            base_url: BASE_URL.into(),
            instructions: instructions.into(),
            home: home.into(),
            record: None,
            code_mode_host: HOST_PROGRAM.into(),
            nested_tools: NestedTools::default(),
        }
    }
}

pub struct OpenAi {
    options: OpenAiOptions,
    http: reqwest::Client,
    signing_in: Mutex<()>,
    code_mode: CodeMode,
}

#[derive(Default)]
struct Response {
    messages: Vec<String>,
    calls: Vec<ToolCall>,
}

impl OpenAi {
    pub fn new(options: OpenAiOptions) -> Result<Self> {
        let code_mode = CodeMode::new(options.code_mode_host.clone(), options.nested_tools);
        Ok(Self {
            options,
            http: crate::http_client()?,
            signing_in: Mutex::new(()),
            code_mode,
        })
    }

    async fn answer(&self, turn: &Turn) -> Result<()> {
        let model = turn.model().unwrap_or(MODEL);
        let run = wants_code_mode(model)
            .then(|| self.code_mode.begin(turn))
            .transpose()?;
        let answered = self.answer_in(turn, model, run.as_ref()).await;
        if let Some(run) = run {
            run.finish().await;
        }
        answered
    }

    async fn answer_in(&self, turn: &Turn, model: &str, run: Option<&Run>) -> Result<()> {
        let mut recorder = Recorder::start(self.options.record.as_deref(), model)?;
        let instructions = self.instructions(turn.cwd());
        loop {
            let body = self.request_body(
                turn,
                model,
                run.is_some(),
                &instructions,
                &turn.transcript()?,
            );
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
                match run {
                    Some(run) if [EXEC, WAIT].contains(&call.name.as_str()) => {
                        run.call(call).await?;
                    }
                    Some(_) => {
                        let unknown = format!("no tool named {}; use exec", call.name);
                        turn.call_tool(call, Approval::NotNeeded, move |_| {
                            ToolOutcome::error(unknown)
                        })
                        .await?;
                    }
                    None => {
                        let approval = approval_for(&call.name);
                        turn.call_tool(call, approval, run_builtin_tool(turn.cwd()))
                            .await?;
                    }
                }
            }
            turn.place_steers()?;
        }
    }

    fn workspace(&self, cwd: &Path) -> Workspace {
        Workspace {
            cwd: cwd.to_owned(),
            home: self.options.home.clone(),
        }
    }

    /// Nisse's instructions, then each AGENTS.md file, then the skills, read when a run starts.
    fn instructions(&self, cwd: &Path) -> String {
        let workspace = self.workspace(cwd);
        let mut instructions = format!(
            "{}\nThe working directory is {}.\n",
            self.options.instructions,
            cwd.display()
        );
        for file in workspace.agents_md() {
            instructions.push_str(&format!(
                "\n# AGENTS.md instructions from {}\n\n{}\n",
                file.path.display(),
                file.text.trim_end()
            ));
        }
        let skills = workspace.skills();
        if !skills.is_empty() {
            instructions.push('\n');
            instructions.push_str(SKILLS);
            for skill in &skills {
                instructions.push_str(&format!(
                    "- {}: {} (file: {})\n",
                    skill.name, skill.description, skill.path
                ));
            }
        }
        instructions
    }

    fn request_body(
        &self,
        turn: &Turn,
        model: &str,
        in_code_mode: bool,
        instructions: &str,
        transcript: &[Entry],
    ) -> Value {
        let tools: Vec<Value> = match in_code_mode {
            true => self.code_mode.tools(),
            false => builtin_tools()
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
                .collect(),
        };
        json!({
            "model": model,
            "instructions": instructions,
            "input": transcript.iter().filter_map(input_item).collect::<Vec<_>>(),
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "store": false,
            "stream": true,
            "prompt_cache_key": turn.conversation_id(),
        })
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
    fn default_model(&self) -> Option<&str> {
        Some(MODEL)
    }

    fn skills(&self, cwd: &Path) -> Vec<Skill> {
        self.workspace(cwd).skills()
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(self.answer(turn))
    }
}

/// The entry as the model sees it. The calls a script made are the script's business: the model
/// sees what the script reported.
fn input_item(entry: &Entry) -> Option<Value> {
    let data = &entry.data;
    if data.get("parent").is_some_and(Value::is_string) {
        return None;
    }
    match entry.kind.as_str() {
        kinds::USER => {
            let skills = data["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|skill| {
                    json!({
                        "type": "input_text",
                        "text": format!(
                            "<skill>\n<name>{}</name>\n<path>{}</path>\n{}\n</skill>",
                            skill["name"].as_str().unwrap_or_default(),
                            skill["path"].as_str().unwrap_or_default(),
                            skill["text"].as_str().unwrap_or_default().trim_end(),
                        ),
                    })
                });
            let text = json!({ "type": "input_text", "text": data["text"] });
            let content: Vec<Value> = std::iter::once(text).chain(skills).collect();
            Some(json!({ "type": "message", "role": "user", "content": content }))
        }
        kinds::ASSISTANT if data["is_error"] != true => Some(json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": data["text"] }],
        })),
        kinds::TOOL_CALL if data["name"] == EXEC => Some(json!({
            "type": "custom_tool_call",
            "call_id": data["id"],
            "name": EXEC,
            "input": data["args"].as_str().unwrap_or_default(),
        })),
        kinds::TOOL_RESULT if data["name"] == EXEC => Some(json!({
            "type": "custom_tool_call_output",
            "call_id": data["call_id"],
            "output": tool_output(data),
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
            "output": tool_output(data),
        })),
        _ => None,
    }
}

fn tool_output(result: &Value) -> String {
    match result["denied"].as_str() {
        Some(reason) => format!("denied: {reason}"),
        None => result["output"].as_str().unwrap_or_default().to_owned(),
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
                Some("custom_tool_call") => finished.calls.push(custom_tool_call(item)?),
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
        parent: None,
    })
}

fn custom_tool_call(item: &Value) -> Result<ToolCall> {
    let id = item["call_id"]
        .as_str()
        .ok_or_else(|| anyhow!("a custom tool call without a call_id"))?;
    Ok(ToolCall {
        id: id.into(),
        name: item["name"].as_str().unwrap_or_default().into(),
        args: item["input"].as_str().unwrap_or_default().into(),
        parent: None,
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
