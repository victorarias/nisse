use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use anyhow::{Context, Result, anyhow, bail};
use nisse_core::{
    AgentType, Approval, HealthFuture, ModelsFuture, Provider, ProviderFuture, SignIn, ToolCall,
    ToolOutcome, ToolSpec, Turn, Workspace, approval_for, builtin_tools, is_agent_tool,
    run_builtin_tool,
};
use nisse_protocol::{
    AuthMethod, Entry, Mail, MailKind, ProviderHealth, ProviderStatus, Skill, kinds,
};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    auth::{AuthServer, Credentials, ORIGINATOR},
    catalog::{CLIENT_VERSION, Catalog},
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
    /// Where the sign-in's tokens are saved.
    pub auth_path: PathBuf,
    /// Where people sign in and expired tokens are refreshed.
    pub auth: AuthServer,
    pub base_url: String,
    /// Nisse's own instructions; the conversation's directory, its AGENTS.md files and its
    /// skills are added to them.
    pub instructions: String,
    /// The Nisse home, for its own AGENTS.md and skills.
    pub home: PathBuf,
    /// Claude Code's config directory, whose `agents/` hold the person's own agent types.
    pub claude_config: PathBuf,
    /// Where the model list ChatGPT sent last is saved, for starts that can't ask it.
    pub model_list: PathBuf,
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
        let home = home.into();
        Self {
            auth_path: auth_path.into(),
            auth: AuthServer::default(),
            base_url: BASE_URL.into(),
            instructions: instructions.into(),
            model_list: home.join("cache").join("openai-models.json"),
            claude_config: claude_config_dir(),
            home,
            record: None,
            code_mode_host: HOST_PROGRAM.into(),
            nested_tools: NestedTools::default(),
        }
    }
}

/// `CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn claude_config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .unwrap_or_else(|| PathBuf::from(".claude"))
}

pub struct OpenAi {
    options: OpenAiOptions,
    http: reqwest::Client,
    signing_in: Mutex<()>,
    code_mode: CodeMode,
    catalog: Catalog,
    /// Whether ChatGPT was asked for its models since the server started or signed in.
    asked_for_models: AtomicBool,
    /// ChatGPT refused to refresh the saved sign-in: only signing in again helps.
    rejected: AtomicBool,
}

#[derive(Default)]
struct Response {
    messages: Vec<String>,
    calls: Vec<ToolCall>,
}

impl OpenAi {
    pub fn new(options: OpenAiOptions) -> Result<Self> {
        let code_mode = CodeMode::new(options.code_mode_host.clone(), options.nested_tools);
        let catalog = Catalog::new(options.model_list.clone());
        Ok(Self {
            options,
            http: crate::http_client()?,
            signing_in: Mutex::new(()),
            code_mode,
            catalog,
            asked_for_models: AtomicBool::new(false),
            rejected: AtomicBool::new(false),
        })
    }

    /// Asks ChatGPT for the models this sign-in can use, as the Codex release Nisse pins.
    async fn fetch_models(&self) -> Result<()> {
        let (credentials, _) = self.signed_in().await?;
        let response = self
            .http
            .get(format!(
                "{}/codex/models?client_version={CLIENT_VERSION}",
                self.options.base_url
            ))
            .bearer_auth(&credentials.access_token)
            .header("chatgpt-account-id", &credentials.account_id)
            .header("originator", ORIGINATOR)
            .send()
            .await
            .context("could not reach ChatGPT")?;
        let status = response.status();
        if !status.is_success() {
            bail!("ChatGPT answered {status} when asked for its models");
        }
        let body = response.bytes().await?;
        self.catalog.fetched(&body)
    }

    async fn answer(&self, turn: &Turn) -> Result<()> {
        let model = turn.model().unwrap_or(MODEL);
        let types = self
            .workspace(turn.cwd())
            .agent_types(&self.options.claude_config);
        let agent_tools = turn.agent_tools(&types);
        let run = self
            .catalog
            .wants_code_mode(model)
            .then(|| self.code_mode.begin(turn, agent_tools.clone()))
            .transpose()?;
        let answered = self
            .answer_in(turn, model, run.as_ref(), &types, &agent_tools)
            .await;
        if let Some(run) = run {
            run.finish().await;
        }
        answered
    }

    async fn answer_in(
        &self,
        turn: &Turn,
        model: &str,
        run: Option<&Run>,
        types: &[AgentType],
        agent_tools: &[ToolSpec],
    ) -> Result<()> {
        let mut recorder = Recorder::start(self.options.record.as_deref(), model, turn.cwd())?;
        let instructions = self.instructions(turn, types);
        loop {
            let body = self.request_body(
                turn,
                model,
                run.is_some(),
                agent_tools,
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
                    None if is_agent_tool(&call.name) => {
                        turn.call_tool(call, Approval::NotNeeded, turn.run_agent_tool())
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

    /// Nisse's instructions, then each AGENTS.md file, then the skills, read when a run starts,
    /// and a subagent's agent type last.
    fn instructions(&self, turn: &Turn, types: &[AgentType]) -> String {
        let cwd = turn.cwd();
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
        let agent_type = turn
            .lineage()
            .and_then(|lineage| lineage.agent_type.as_deref())
            .and_then(|name| types.iter().find(|kind| kind.name == name));
        if let Some(kind) = agent_type {
            instructions.push_str(&format!(
                "\n# You are a {} agent\n\n{}\n",
                kind.name, kind.instructions
            ));
        }
        instructions
    }

    fn request_body(
        &self,
        turn: &Turn,
        model: &str,
        in_code_mode: bool,
        agent_tools: &[ToolSpec],
        instructions: &str,
        transcript: &[Entry],
    ) -> Value {
        let tools: Vec<Value> = match in_code_mode {
            true => self.code_mode.tools(agent_tools),
            false => builtin_tools()
                .into_iter()
                .chain(agent_tools.iter().cloned())
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
        let mut body = json!({
            "model": model,
            "instructions": instructions,
            "input": transcript.iter().filter_map(input_item).collect::<Vec<_>>(),
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "store": false,
            "stream": true,
            "prompt_cache_key": turn.conversation_id(),
        });
        if let Some(effort) = turn.effort() {
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
            .refreshed(&self.http, &self.options.auth.base)
            .await
            .inspect_err(|_| self.rejected.store(true, Ordering::Relaxed))?;
        fresh.save(&self.options.auth_path)?;
        Ok(fresh)
    }

    fn current_health(&self) -> ProviderHealth {
        let signed_out = ProviderHealth::new(ProviderStatus::SignedOut);
        if !self.options.auth_path.exists() {
            return signed_out.with_message("not signed in to ChatGPT");
        }
        if self.rejected.load(Ordering::Relaxed) {
            return signed_out.with_message("the ChatGPT sign-in expired; sign in again");
        }
        match Credentials::load(&self.options.auth_path) {
            Ok(credentials) => ProviderHealth {
                account: credentials.account(),
                ..ProviderHealth::new(ProviderStatus::Ready)
            },
            Err(error) => signed_out.with_message(format!("{error:#}")),
        }
    }
}

impl Provider for OpenAi {
    fn driver(&self) -> &str {
        "openai"
    }

    fn default_model(&self) -> Option<&str> {
        Some(MODEL)
    }

    fn skills(&self, cwd: &Path) -> Vec<Skill> {
        self.workspace(cwd).skills()
    }

    fn agent_types(&self, cwd: &Path) -> Vec<AgentType> {
        self.workspace(cwd).agent_types(&self.options.claude_config)
    }

    fn run<'a>(&'a self, turn: &'a Turn) -> ProviderFuture<'a> {
        Box::pin(self.answer(turn))
    }

    /// Asks ChatGPT the first time, and whenever a client wants them found again; otherwise,
    /// and when ChatGPT can't be asked, the list Nisse has.
    fn models(&self, refresh: bool) -> ModelsFuture<'_> {
        Box::pin(async move {
            if (refresh || !self.asked_for_models.swap(true, Ordering::Relaxed))
                && let Err(error) = self.fetch_models().await
            {
                eprintln!("nisse: could not list OpenAI's models: {error:#}");
            }
            self.catalog.listed()
        })
    }

    fn health(&self, _refresh: bool) -> HealthFuture<'_> {
        Box::pin(async { self.current_health() })
    }

    fn sign_in_methods(&self) -> Vec<AuthMethod> {
        vec![AuthMethod::Browser, AuthMethod::DeviceCode]
    }

    fn sign_in(&self, method: AuthMethod, mut flow: SignIn) -> ProviderFuture<'_> {
        Box::pin(async move {
            crate::auth::sign_in(
                &self.http,
                &self.options.auth,
                &self.options.auth_path,
                method,
                &mut flow,
            )
            .await?;
            self.rejected.store(false, Ordering::Relaxed);
            self.asked_for_models.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn sign_out(&self) -> ProviderFuture<'_> {
        Box::pin(async {
            let _held = self.signing_in.lock().await;
            match std::fs::remove_file(&self.options.auth_path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
                _ => Ok(()),
            }
        })
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
        kinds::USER if data["mail"].is_object() => {
            let mail: Mail = serde_json::from_value(data["mail"].clone()).ok()?;
            Some(json!({
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": mail_text(&mail, data["text"].as_str().unwrap_or_default()) }],
            }))
        }
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

/// Mail as Codex's models read it.
fn mail_text(mail: &Mail, payload: &str) -> String {
    let kind = match mail.kind {
        MailKind::NewTask => "NEW_TASK",
        MailKind::Message => "MESSAGE",
        MailKind::FinalAnswer => "FINAL_ANSWER",
    };
    format!(
        "Message Type: {kind}\nTask name: {}\nSender: {}\nPayload:\n{payload}",
        mail.task, mail.sender
    )
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
