//! Subagents a model starts and talks to with tools shaped like Codex's `multi_agent_v2`: each
//! one is a conversation of its own under the one that started it, addressed by a task name
//! such as `/root/explore`, and agents talk by mail.

use std::time::Duration;

use nisse_protocol::{
    Actor, Conversation, ConversationStatus, Entry, Lineage, Mail, MailKind, ModelSelection,
    SubmissionStatus, WhenBusy, kinds,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    tools::{ToolCall, ToolOutcome, ToolSpec},
    turn::Turn,
};

pub const SPAWN_AGENT: &str = "spawn_agent";
pub const SEND_MESSAGE: &str = "send_message";
pub const FOLLOWUP_TASK: &str = "followup_task";
pub const WAIT_AGENT: &str = "wait_agent";
pub const LIST_AGENTS: &str = "list_agents";
pub const INTERRUPT_AGENT: &str = "interrupt_agent";

const ROOT_TASK: &str = "/root";
const DEFAULT_WAIT_MS: u64 = 30_000;
const MIN_WAIT_MS: u64 = 10_000;
const MAX_WAIT_MS: u64 = 3_600_000;
const ERROR_NEXT_ACTION: &str = "This agent's turn failed. If you still need this agent, use the \
                                 available collaboration tools to give it another task.";

/// How deep subagents nest, and how many of one conversation's tree run at once, with Codex's
/// defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_depth: usize,
    pub max_threads: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_depth: 1,
            max_threads: 6,
        }
    }
}

/// A kind of subagent from Claude Code's agent files, `.claude/agents/<name>.md`: when to use
/// it, the model it prefers, and its instructions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentType {
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    pub instructions: String,
}

pub fn is_agent_tool(name: &str) -> bool {
    [
        SPAWN_AGENT,
        SEND_MESSAGE,
        FOLLOWUP_TASK,
        WAIT_AGENT,
        LIST_AGENTS,
        INTERRUPT_AGENT,
    ]
    .contains(&name)
}

/// The conversation's task name: its own, or `/root` for one people started.
pub(crate) fn task_of(conversation: &Conversation) -> String {
    conversation
        .lineage
        .as_ref()
        .and_then(|lineage| lineage.task.clone())
        .unwrap_or_else(|| ROOT_TASK.to_owned())
}

/// How many subagents deep the conversation is: none for one people started.
pub(crate) fn depth(lineage: Option<&Lineage>) -> usize {
    match lineage {
        None => 0,
        Some(lineage) => lineage
            .task
            .as_deref()
            .map_or(1, |task| task.matches('/').count().saturating_sub(1)),
    }
}

/// Every conversation of `family` under `id`, nearest first.
pub(crate) fn descendants<'a>(family: &'a [Conversation], id: &str) -> Vec<&'a Conversation> {
    let mut found: Vec<&Conversation> = Vec::new();
    let mut parents = vec![id.to_owned()];
    while let Some(parent) = parents.pop() {
        for child in family.iter().filter(|child| {
            child
                .lineage
                .as_ref()
                .is_some_and(|lineage| lineage.parent == parent)
        }) {
            found.push(child);
            parents.push(child.id.clone());
        }
    }
    found
}

pub(crate) fn errored(error: &str) -> String {
    format!("Agent errored: {error}\n\n{ERROR_NEXT_ACTION}")
}

/// The tools a model gets to start and steer subagents; `spawn_agent` only while it may start
/// one deeper.
pub(crate) fn tool_specs(types: &[AgentType], may_spawn: bool) -> Vec<ToolSpec> {
    let mut specs = Vec::new();
    if may_spawn {
        specs.push(spawn_spec(types));
    }
    specs.extend([
        spec(
            SEND_MESSAGE,
            "Send a message to an existing agent. The message will be delivered promptly. Does \
             not trigger a new turn.",
            json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Relative or canonical task name to message (from spawn_agent)." },
                    "message": { "type": "string", "description": "Message text to queue on the target agent." }
                },
                "required": ["target", "message"],
                "additionalProperties": false
            }),
        ),
        spec(
            FOLLOWUP_TASK,
            "Send a follow-up task to an existing non-root target agent and trigger a turn if it \
             is idle. If the target is already running, deliver the task promptly at message \
             boundaries while sampling, or after the pending tool call completes.",
            json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Agent id or canonical task name to send a follow-up task to (from spawn_agent)." },
                    "message": { "type": "string", "description": "Message text to send to the target agent." }
                },
                "required": ["target", "message"],
                "additionalProperties": false
            }),
        ),
        spec(
            WAIT_AGENT,
            "Wait for a mailbox update from any live agent, including queued messages and \
             final-status notifications. The wait also ends early when new user input is steered \
             into the active turn. Does not return the content; returns either a summary of which \
             agents have updates (if any), an interruption summary for steered input, or a \
             timeout summary if no activity arrives before the deadline.",
            json!({
                "type": "object",
                "properties": {
                    "timeout_ms": { "type": "number", "description": format!("Timeout in milliseconds. Defaults to {DEFAULT_WAIT_MS}, min {MIN_WAIT_MS}, max {MAX_WAIT_MS}.") }
                },
                "additionalProperties": false
            }),
        ),
        spec(
            LIST_AGENTS,
            "List live agents in the current root thread tree. Optionally filter by task-path \
             prefix.",
            json!({
                "type": "object",
                "properties": {
                    "path_prefix": { "type": "string", "description": "Task-path prefix filter without a trailing slash. Omit to list all live agents." }
                },
                "additionalProperties": false
            }),
        ),
        spec(
            INTERRUPT_AGENT,
            "Interrupt an agent's current turn, if any, and return its previous status. The agent \
             remains available for messages and follow-up tasks.",
            json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Agent id or canonical task name to interrupt (from spawn_agent)." }
                },
                "required": ["target"],
                "additionalProperties": false
            }),
        ),
    ]);
    specs
}

fn spawn_spec(types: &[AgentType]) -> ToolSpec {
    let mut agent_type = "Agent type override for the new agent. Omit unless explicitly asked. \
                          The selected role applies regardless of how much parent history is \
                          inherited."
        .to_owned();
    if !types.is_empty() {
        agent_type.push_str("\nAvailable agent types:");
        for kind in types {
            agent_type.push_str(&format!("\n- {}: {}", kind.name, kind.description));
        }
    }
    spec(
        SPAWN_AGENT,
        "Spawns an agent to work on the specified task. If your current task is `/root/task1` and \
         you spawn_agent with task_name \"task_3\" the agent will have canonical task name \
         `/root/task1/task_3`.\nYou are then able to refer to this agent as `task_3` or \
         `/root/task1/task_3` interchangeably. However an agent `/root/task2/task_3` would only \
         be able to communicate with this agent via its canonical name `/root/task1/task_3`.\n\
         The spawned agent will have the same tools as you.\nSpawned agents inherit your current \
         model by default. Do not set the `model` field unless the user explicitly asks for a \
         different model.\nIt will be able to send you and other running agents messages, and \
         its final answer will be provided to you when it finishes.\nThe new agent's canonical \
         task name will be provided to it along with the message.\n\nDo not spawn sub-agents \
         unless the user or applicable AGENTS.md/skill instructions explicitly ask for \
         sub-agents, delegation, or parallel agent work.\n\nNote that passing \
         `fork_turns=\"none\"` will not pass any surrounding context to the spawned subagent, \
         which may cause the agent to lack the context it needs to complete its task, whereas \
         `fork_turns=\"all\"` will provide the subagent with all surrounding context.",
        json!({
            "type": "object",
            "properties": {
                "task_name": { "type": "string", "description": "Task name for the new agent. Use lowercase letters, digits, and underscores." },
                "message": { "type": "string", "description": "Initial plain-text task for the new agent." },
                "agent_type": { "type": "string", "description": agent_type },
                "fork_turns": { "type": "string", "description": "Parent history to inherit. Defaults to `all`; use `none` to start without parent history. Only `all` and `none` are supported." },
                "model": { "type": "string", "description": "Model override for the new agent. Omit unless an explicit override is needed." },
                "reasoning_effort": { "type": "string", "description": "Reasoning effort override for the new agent. Omit to inherit the parent effort." }
            },
            "required": ["task_name", "message"],
            "additionalProperties": false
        }),
    )
}

fn spec(name: &str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters,
    }
}

/// Runs one of the agent tools for the model that `turn` answers for.
pub(crate) async fn run(turn: &Turn, call: &ToolCall) -> ToolOutcome {
    let answered = match call.name.as_str() {
        SPAWN_AGENT => spawn(turn, call).await,
        SEND_MESSAGE => message(turn, call, MailKind::Message),
        FOLLOWUP_TASK => message(turn, call, MailKind::NewTask),
        WAIT_AGENT => wait(turn, call).await,
        LIST_AGENTS => list(turn, call),
        INTERRUPT_AGENT => interrupt(turn, call),
        other => Err(format!("no tool named {other}")),
    };
    match answered {
        Ok(Value::String(text)) => ToolOutcome::ok(text),
        Ok(value) => ToolOutcome::ok(value.to_string()),
        Err(error) => ToolOutcome::error(error),
    }
}

fn args<T: DeserializeOwned>(call: &ToolCall) -> Result<T, String> {
    T::deserialize(&call.args).map_err(|error| format!("bad arguments for {}: {error}", call.name))
}

fn failed(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnArgs {
    task_name: String,
    message: String,
    agent_type: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fork_turns: Option<String>,
}

async fn spawn(turn: &Turn, call: &ToolCall) -> Result<Value, String> {
    let args: SpawnArgs = args(call)?;
    if args.message.trim().is_empty() {
        return Err("Empty message can't be sent to an agent".into());
    }
    let name = args.task_name.trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
    {
        return Err("task_name takes lowercase letters, digits and underscores".into());
    }
    let fork = match args.fork_turns.as_deref().map(str::trim) {
        None | Some("") => true,
        Some(turns) if turns.eq_ignore_ascii_case("all") || turns.parse::<usize>().is_ok() => true,
        Some(turns) if turns.eq_ignore_ascii_case("none") => false,
        Some(_) => return Err("fork_turns must be `none` or `all`".into()),
    };
    turn.may_spawn()?;
    let harness = turn.harness();
    let parent = harness
        .conversation(turn.conversation_id())
        .map_err(failed)?;
    let family = harness.family(&parent).map_err(failed)?;
    let task = format!("{}/{name}", task_of(&parent));
    if family.iter().any(|known| task_of(known) == task) {
        return Err(format!("an agent named {task} already exists"));
    }
    let provider = harness.provider_of(&parent).map_err(failed)?;
    let agent_type = match args.agent_type.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(wanted) => {
            let types = provider.agent_types(&parent.cwd);
            let Some(found) = types.iter().find(|kind| kind.name == wanted) else {
                let known: Vec<&str> = types.iter().map(|kind| kind.name.as_str()).collect();
                return Err(match known.is_empty() {
                    true => format!("no agent type {wanted}; there are none"),
                    false => format!("no agent type {wanted}; there are {}", known.join(", ")),
                });
            };
            Some(found.clone())
        }
    };
    let catalog = provider.models(false).await;
    let listed = |model: &str| catalog.iter().any(|known| known.id == model);
    let model = match args.model {
        Some(model) if listed(&model) => Some(model),
        Some(model) => {
            return Err(format!(
                "no model {model} on {}; leave model out to use yours",
                parent.selection.provider
            ));
        }
        None => agent_type
            .as_ref()
            .and_then(|kind| kind.model.clone())
            .filter(|model| listed(model))
            .or_else(|| parent.selection.model.clone()),
    };
    let effort = args.reasoning_effort.or_else(|| {
        (model == parent.selection.model)
            .then(|| parent.selection.effort.clone())
            .flatten()
    });
    let forked_at = match fork {
        true => Some(launched_at(turn, call).map_err(failed)?),
        false => None,
    };
    let lineage = Lineage {
        parent: parent.id.clone(),
        root: parent
            .lineage
            .as_ref()
            .map_or_else(|| parent.id.clone(), |lineage| lineage.root.clone()),
        call_id: call.id.clone(),
        task: Some(task.clone()),
        agent_type: agent_type.map(|kind| kind.name),
        hosted: false,
        forked_at,
    };
    let selection = ModelSelection {
        provider: parent.selection.provider.clone(),
        model,
        effort,
    };
    let child = harness
        .start_child(&parent, name, selection, lineage, turn.actor())
        .map_err(failed)?;
    let mail = Mail {
        kind: MailKind::NewTask,
        task: task.clone(),
        sender: task_of(&parent),
    };
    let author = Actor::Agent {
        conversation_id: parent.id.clone(),
    };
    harness
        .deliver(&child.id, &args.message, mail, &author)
        .map_err(failed)?;
    Ok(json!({ "task_name": task, "nickname": null }))
}

/// The commit of the call that started this one, or of the script whose call it is: the child
/// inherits what came before it.
fn launched_at(turn: &Turn, call: &ToolCall) -> anyhow::Result<i64> {
    let launcher = call.parent.as_deref().unwrap_or(&call.id);
    turn.entries_since(0)?
        .iter()
        .find(|entry| entry.kind == kinds::TOOL_CALL && entry.data["id"] == launcher)
        .map(|entry| entry.seq)
        .ok_or_else(|| anyhow::anyhow!("the call {launcher} is not in the transcript"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageArgs {
    target: String,
    message: String,
}

fn message(turn: &Turn, call: &ToolCall, kind: MailKind) -> Result<Value, String> {
    let args: MessageArgs = args(call)?;
    if args.message.trim().is_empty() {
        return Err("Empty message can't be sent to an agent".into());
    }
    let harness = turn.harness();
    let sender = harness
        .conversation(turn.conversation_id())
        .map_err(failed)?;
    let family = harness.family(&sender).map_err(failed)?;
    let target = target(&family, &sender, &args.target)?;
    if kind == MailKind::NewTask && target.lineage.is_none() {
        return Err("followup_task takes a subagent; send_message reaches the root".into());
    }
    let mail = Mail {
        kind,
        task: task_of(target),
        sender: task_of(&sender),
    };
    let author = Actor::Agent {
        conversation_id: sender.id.clone(),
    };
    harness
        .deliver(&target.id, &args.message, mail, &author)
        .map_err(failed)?;
    Ok(Value::String(String::new()))
}

/// The agent `name` addresses from `from`: a canonical task name, one relative to `from`, or a
/// conversation id.
fn target<'a>(
    family: &'a [Conversation],
    from: &Conversation,
    name: &str,
) -> Result<&'a Conversation, String> {
    let name = name.trim();
    let task = match name.starts_with('/') {
        true => name.to_owned(),
        false => format!("{}/{name}", task_of(from)),
    };
    family
        .iter()
        .find(|known| task_of(known) == task || known.id == name)
        .ok_or_else(|| format!("no agent {name}"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    timeout_ms: Option<f64>,
}

#[derive(Debug, PartialEq, Eq)]
enum Woken {
    Mail,
    Steered,
}

async fn wait(turn: &Turn, call: &ToolCall) -> Result<Value, String> {
    let args: WaitArgs = args(call)?;
    let requested = args.timeout_ms.map(|ms| ms.max(0.0) as u64);
    let timeout_ms = match requested {
        Some(ms) if ms > MAX_WAIT_MS => {
            return Err(format!("timeout_ms must be at most {MAX_WAIT_MS}"));
        }
        Some(ms) => ms.max(MIN_WAIT_MS),
        None => DEFAULT_WAIT_MS,
    };
    let harness = turn.harness();
    let mut commits = harness.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let woken = loop {
        if let Some(woken) = waiting_input(turn).map_err(failed)? {
            break Some(woken);
        }
        tokio::select! {
            commit = commits.recv() => if let Err(tokio::sync::broadcast::error::RecvError::Closed) = commit {
                break None;
            },
            () = tokio::time::sleep_until(deadline) => break None,
            () = turn.stopped() => return Err("the run was interrupted".into()),
        }
    };
    let message = match woken {
        Some(Woken::Mail) => "Wait completed.",
        Some(Woken::Steered) => "Wait interrupted by new input.",
        None => "Wait timed out.",
    };
    let message = match requested {
        Some(requested) if requested < timeout_ms => format!(
            "{message}\n\nRequested timeout of {requested}ms was clamped to the minimum of {timeout_ms}ms."
        ),
        _ => message.to_owned(),
    };
    Ok(json!({ "message": message, "timed_out": woken.is_none() }))
}

/// What waits to join the run at its next step: mail, or someone's steer.
fn waiting_input(turn: &Turn) -> anyhow::Result<Option<Woken>> {
    let waiting = turn
        .harness()
        .store()
        .open_submissions(turn.conversation_id())?;
    let steers: Vec<_> = waiting
        .iter()
        .filter(|open| open.status == SubmissionStatus::Queued && open.when_busy == WhenBusy::Steer)
        .collect();
    Ok(match steers.iter().any(|steer| steer.mail.is_some()) {
        true => Some(Woken::Mail),
        false => (!steers.is_empty()).then_some(Woken::Steered),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    path_prefix: Option<String>,
}

fn list(turn: &Turn, call: &ToolCall) -> Result<Value, String> {
    let args: ListArgs = args(call)?;
    let harness = turn.harness();
    let caller = harness
        .conversation(turn.conversation_id())
        .map_err(failed)?;
    let family = harness.family(&caller).map_err(failed)?;
    let prefix = args.path_prefix.unwrap_or_default();
    let mut agents = Vec::new();
    for agent in family
        .iter()
        .filter(|agent| task_of(agent).starts_with(&prefix))
    {
        agents.push(json!({
            "agent_name": task_of(agent),
            "agent_status": status(turn, agent).map_err(failed)?,
        }));
    }
    Ok(json!({ "agents": agents }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InterruptArgs {
    target: String,
}

fn interrupt(turn: &Turn, call: &ToolCall) -> Result<Value, String> {
    let args: InterruptArgs = args(call)?;
    let harness = turn.harness();
    let caller = harness
        .conversation(turn.conversation_id())
        .map_err(failed)?;
    let family = harness.family(&caller).map_err(failed)?;
    let target = target(&family, &caller, &args.target)?;
    if target.id == caller.id {
        return Err("an agent can't interrupt itself".into());
    }
    let previous_status = status(turn, target).map_err(failed)?;
    harness
        .interrupt(&target.id)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "previous_status": previous_status }))
}

/// An agent's status as Codex reports it: running, or how its last run ended.
fn status(turn: &Turn, agent: &Conversation) -> anyhow::Result<Value> {
    let store = turn.harness().store();
    if agent.status != ConversationStatus::Idle
        || store
            .open_submissions(&agent.id)?
            .iter()
            .any(|open| open.starts_a_run())
    {
        return Ok(json!("running"));
    }
    let entries = store.entries(&agent.id, 0)?;
    Ok(ended(&entries))
}

fn ended(entries: &[Entry]) -> Value {
    let Some(last) = entries
        .iter()
        .rev()
        .find(|entry| entry.kind == kinds::ASSISTANT)
    else {
        return json!("pending_init");
    };
    let text = last.data["text"].as_str().unwrap_or_default();
    match (
        last.data["interrupted"] == true,
        last.data["is_error"] == true,
    ) {
        (true, _) => json!("interrupted"),
        (false, true) => json!({ "errored": text }),
        (false, false) => json!({ "completed": text }),
    }
}
