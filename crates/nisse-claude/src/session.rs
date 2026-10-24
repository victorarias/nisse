use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use anyhow::{Result, anyhow};
use futures_util::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use nisse_core::{Approval, Decision, ToolCall, ToolOutcome, Turn, new_id};
use nisse_protocol::{Entry, Seq, kinds};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::process::Process;

pub(crate) const PRE_TOOL_USE: &str = "nisse_pre_tool_use";
/// The tools Claude Code starts its subagents with.
const STARTS_SUBAGENTS: &[&str] = &["Agent", "Task"];
/// The errors Claude Code reports when its API refuses the credentials it holds.
const AUTH_ERRORS: &[&str] = &["authentication_failed", "oauth_org_not_allowed"];

const RESTARTED: &str = "Nisse restarted before you finished. Continue where you left off.";

const RETOLD: &str = "This Claude Code session joins a conversation it does not hold. \
                      This is the conversation so far; continue it.";

/// How much of the conversation a new session is retold: 16,000 tokens, at about four bytes a
/// token, as t3code budgets its handoffs.
const RETELL_BUDGET: usize = 16_000 * 4;

/// What Nisse keeps per conversation: Claude's session, the newest Claude message whose
/// content Nisse committed, and the newest seq Claude's session holds up to that message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProviderState {
    pub(crate) session: String,
    pub(crate) head: Option<String>,
    pub(crate) delivered: Seq,
}

/// Claude could not resume the conversation's session: claude stopped before it answered
/// `initialize`, as it does when the session or the message to resume at is gone.
#[derive(Debug)]
pub(crate) struct Unresumable(String);

impl std::fmt::Display for Unresumable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Unresumable {}

/// A conversation's live claude process and what Nisse knows of its session.
pub(crate) struct Session {
    process: Process,
    resumed: bool,
    initialized: bool,
    retell: bool,
    heads: Arc<Mutex<Heads>>,
    sent: Seq,
    unacked: VecDeque<Delivery>,
    calls: HashMap<String, Call>,
    mid_message: bool,
    held: VecDeque<Held>,
    streaming: String,
    auth_failed: bool,
    model: Option<String>,
    effort: Option<String>,
    subagents: Subagents,
}

/// Claude Code's subagents in this session, each committed into a conversation of its own:
/// by the `Agent` call that started it, and by Claude Code's id for it.
#[derive(Default)]
struct Subagents {
    turns: HashMap<String, Turn>,
    started_by: HashMap<String, String>,
}

impl Subagents {
    /// The subagent a frame or a hook comes from, by its `agent_id`, or by the call that
    /// started it as a frame's `parent_tool_use_id` names it.
    fn of(&self, agent_id: &Value, started_by: &Value) -> Option<&Turn> {
        let call = agent_id
            .as_str()
            .and_then(|agent| self.started_by.get(agent))
            .map(String::as_str)
            .or(started_by.as_str())?;
        self.turns.get(call)
    }
}

/// A user message Nisse sent, which Claude acknowledges by replaying its uuid.
struct Delivery {
    uuid: String,
    through: Seq,
}

/// A frame Claude sent whose commits wait for the calls before it: `text` is its link in the
/// chain when it carries text to commit.
struct Held {
    frame: Value,
    text: Option<usize>,
}

struct Call {
    /// The subagent that made it, by the call that started the subagent.
    subagent: Option<String>,
    hook_request: String,
    asked_args: Value,
    hook_answered: bool,
    done: bool,
    waiter: Option<oneshot::Sender<ToolOutcome>>,
    denied: Option<String>,
}

enum Event {
    CallDone {
        id: String,
        outcome: Result<ToolOutcome>,
    },
    Asked {
        request_id: String,
        id: String,
        input: Value,
        decision: Result<Decision>,
    },
}

type Started = mpsc::UnboundedSender<(String, ToolCall)>;

impl Session {
    pub(crate) fn new(
        process: Process,
        state: ProviderState,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Self {
        Self {
            process,
            resumed: state.head.is_some(),
            initialized: false,
            retell: false,
            sent: state.delivered,
            heads: Arc::new(Mutex::new(Heads::new(state))),
            unacked: VecDeque::new(),
            calls: HashMap::new(),
            mid_message: false,
            held: VecDeque::new(),
            streaming: String::new(),
            auth_failed: false,
            model: model.map(str::to_owned),
            effort: effort.map(str::to_owned),
            subagents: Subagents::default(),
        }
    }

    /// The effort claude was started with; a live claude can't change it.
    pub(crate) fn effort(&self) -> Option<&str> {
        self.effort.as_deref()
    }

    /// Switches the live claude to `model` before its next turn, or to its own default.
    pub(crate) fn use_model(&mut self, model: Option<&str>) {
        if self.model.as_deref() == model {
            return;
        }
        self.model = model.map(str::to_owned);
        self.process.send(json!({
            "type": "control_request",
            "request_id": new_id(),
            "request": { "subtype": "set_model", "model": model.unwrap_or("default") },
        }));
    }

    /// For a session that does not hold the conversation so far: its first message retells the
    /// whole transcript, Claude's own part included.
    pub(crate) fn retelling(mut self) -> Self {
        self.retell = true;
        self
    }

    /// Whether Claude's API refused its credentials during a run.
    pub(crate) fn auth_failed(&self) -> bool {
        self.auth_failed
    }

    pub(crate) fn has_stopped(&mut self) -> bool {
        self.process.has_exited()
    }

    /// Hands Claude what the conversation gained since it last heard, and commits Claude's
    /// work until it answers all of it. Claude's frames are read as they come, so a tool's
    /// result reaches its call while other calls still wait; what they commit waits its turn.
    pub(crate) async fn answer(&mut self, turn: &Turn) -> Result<()> {
        self.deliver(turn, true)?;
        let (started, mut runs) = mpsc::unbounded_channel();
        let mut pending: FuturesUnordered<BoxFuture<'_, Event>> = FuturesUnordered::new();
        let mut said = false;
        loop {
            while !self.committing()
                && let Some(Held { frame, text }) = self.held.pop_front()
            {
                if frame["type"] == "result" {
                    if !self.initialized {
                        return Err(self.stopped(result_text(&frame)));
                    }
                    if self.unacked.is_empty() {
                        self.calls.clear();
                        return finish(turn, &frame, said);
                    }
                    continue;
                }
                self.on_frame(turn, frame, text, &started, &mut pending, &mut said)?;
            }
            tokio::select! {
                frame = self.process.inbound.recv() => {
                    let Some(frame) = frame else {
                        let reason = self.process.exit_reason().await;
                        return Err(self.stopped(reason));
                    };
                    self.on_read(turn, frame)?;
                }
                Some((id, call)) = runs.recv() => self.on_run(&id, call),
                Some(event) = pending.next(), if !pending.is_empty() => {
                    self.on_event(turn, event)?;
                }
            }
        }
    }

    fn stopped(&self, reason: String) -> anyhow::Error {
        if self.resumed && !self.initialized {
            Unresumable(reason).into()
        } else {
            anyhow!(reason)
        }
    }

    /// Whether a call's entry is still on its way into the transcript: its call, until the
    /// hooks have answered, or its result, once Claude reported it. What Claude says next
    /// waits, so the transcript keeps Claude's order.
    fn committing(&self) -> bool {
        self.calls
            .values()
            .any(|call| !call.hook_answered || (call.waiter.is_none() && !call.done))
    }

    fn deliver(&mut self, turn: &Turn, must_speak: bool) -> Result<()> {
        let entries = turn.entries_since(self.sent)?;
        let newest = entries.last().map_or(self.sent, |entry| entry.seq);
        let unheard = entries.iter();
        let texts: Vec<String> = if std::mem::take(&mut self.retell) {
            retelling(&entries)
        } else {
            unheard.filter_map(|entry| self.told(entry)).collect()
        };
        let mut blocks: Vec<Value> = texts
            .into_iter()
            .map(|text| json!({ "type": "text", "text": text }))
            .collect();
        if blocks.is_empty() {
            if !must_speak {
                return Ok(());
            }
            blocks.push(json!({ "type": "text", "text": RESTARTED }));
        }
        self.sent = self.sent.max(newest);
        let uuid = new_id();
        self.process.send(json!({
            "type": "user",
            "message": { "role": "user", "content": blocks },
            "parent_tool_use_id": null,
            "uuid": uuid,
        }));
        self.unacked.push_back(Delivery {
            uuid,
            through: self.sent,
        });
        Ok(())
    }

    /// What Claude must hear about an entry it has not seen: what people said, and calls Nisse
    /// cut off, which Claude's session holds no result for.
    fn told(&self, entry: &Entry) -> Option<String> {
        match entry.kind.as_str() {
            kinds::USER => entry.data["text"].as_str().map(str::to_owned),
            kinds::TOOL_RESULT if entry.data["cut_off"] == true => {
                let call_id = entry.data["call_id"].as_str()?;
                let output = entry.data["output"].as_str()?;
                (!self.calls.contains_key(call_id)).then(|| {
                    let name = entry.data["name"].as_str().unwrap_or("tool");
                    format!("Your {name} call {call_id} was cut off: {output}")
                })
            }
            _ => None,
        }
    }

    /// Steers wait for Claude's round of calls to end: once Claude has finished the message
    /// that made them and every call has its result committed, they join the run and Claude
    /// hears them.
    fn deliver_steers(&mut self, turn: &Turn) -> Result<()> {
        let round_ended = !self.mid_message
            && self.heads.lock().expect("heads lock").uses.is_empty()
            && self.calls.values().all(|call| call.done);
        if round_ended {
            turn.place_steers()?;
        }
        self.deliver(turn, false)
    }

    /// Takes a frame in as soon as Claude sends it: tool results go to their calls and Claude's
    /// messages join the chain in Claude's order. Whatever the frame commits is held until the
    /// calls before it have committed theirs.
    fn on_read(&mut self, turn: &Turn, frame: Value) -> Result<()> {
        if frame["type"] == "assistant"
            && frame["error"]
                .as_str()
                .is_some_and(|error| AUTH_ERRORS.contains(&error))
        {
            self.auth_failed = true;
        }
        let is_main_chain = frame["parent_tool_use_id"].is_null();
        let (text, message_ended) = match frame["type"].as_str() {
            Some("user") => return self.on_user(turn, &frame, is_main_chain),
            Some("assistant") if is_main_chain => (self.chain_assistant(&frame), false),
            Some("stream_event") if is_main_chain => (None, self.follow_message(&frame["event"])),
            _ => (None, false),
        };
        self.held.push_back(Held { frame, text });
        if message_ended {
            self.deliver_steers(turn)?;
        }
        Ok(())
    }

    /// Follows Claude's main-chain message as it streams, and says when it has ended.
    fn follow_message(&mut self, event: &Value) -> bool {
        match event["type"].as_str() {
            Some("message_start") => self.mid_message = true,
            Some("message_stop") => self.mid_message = false,
            _ => return false,
        }
        !self.mid_message
    }

    fn on_frame<'a>(
        &mut self,
        turn: &'a Turn,
        frame: Value,
        text: Option<usize>,
        started: &Started,
        pending: &mut FuturesUnordered<BoxFuture<'a, Event>>,
        said: &mut bool,
    ) -> Result<()> {
        let is_main_chain = frame["parent_tool_use_id"].is_null();
        match frame["type"].as_str() {
            Some("stream_event") if is_main_chain => self.on_stream(turn, &frame["event"]),
            Some("assistant") if is_main_chain => self.on_assistant(turn, &frame, text, said)?,
            Some("assistant") => {
                if let Some(subagent) = self
                    .subagents
                    .of(&frame["agent_id"], &frame["parent_tool_use_id"])
                {
                    texts(&frame).try_for_each(|text| subagent.say(text))?;
                }
            }
            Some("system") => self.on_task(turn, &frame)?,
            Some("control_response") => self.initialized = true,
            Some("control_request") => self.on_control_request(turn, &frame, started, pending),
            _ => {}
        }
        Ok(())
    }

    /// A subagent starts in a conversation of its own under this one, and finishes there.
    fn on_task(&mut self, turn: &Turn, frame: &Value) -> Result<()> {
        let Some(call) = frame["tool_use_id"].as_str() else {
            return Ok(());
        };
        match frame["subtype"].as_str() {
            Some("task_started") if frame["subagent_type"].is_string() => {
                let title = frame["description"].as_str().unwrap_or("subagent");
                let prompt = frame["prompt"].as_str().unwrap_or_default();
                let subagent =
                    turn.start_hosted(call, title, frame["subagent_type"].as_str(), prompt)?;
                if let Some(agent) = frame["task_id"].as_str() {
                    self.subagents
                        .started_by
                        .insert(agent.to_owned(), call.to_owned());
                }
                self.subagents.turns.insert(call.to_owned(), subagent);
            }
            Some("task_notification") => {
                if let Some(subagent) = self.subagents.turns.remove(call) {
                    subagent.finish_hosted(frame["summary"].as_str())?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn on_stream(&mut self, turn: &Turn, event: &Value) {
        match event["type"].as_str() {
            Some("content_block_start") => self.streaming.clear(),
            Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                self.streaming
                    .push_str(event["delta"]["text"].as_str().unwrap_or_default());
                turn.stream(&self.streaming);
            }
            _ => {}
        }
    }

    /// Puts Claude's message in the chain, waiting for its text and for the calls it makes to
    /// be committed, and names its link when it has text to commit.
    fn chain_assistant(&mut self, frame: &Value) -> Option<usize> {
        let uuid = frame["uuid"].as_str()?;
        let speaks = texts(frame).next().is_some();
        let calls: Vec<String> = content(frame)
            .filter(|block| block["type"] == "tool_use")
            .filter_map(|block| block["id"].as_str().map(str::to_owned))
            .collect();
        let mut heads = self.heads.lock().expect("heads lock");
        let link = heads
            .chain
            .push(Some(uuid), calls.len() + usize::from(speaks), None);
        heads.uses.extend(calls.into_iter().map(|id| (id, link)));
        speaks.then_some(link)
    }

    /// Commits Claude's text, the last of it together with the head that now covers it.
    fn on_assistant(
        &mut self,
        turn: &Turn,
        frame: &Value,
        link: Option<usize>,
        said: &mut bool,
    ) -> Result<()> {
        let texts: Vec<&str> = texts(frame).collect();
        let Some((last, earlier)) = texts.split_last() else {
            return Ok(());
        };
        self.streaming.clear();
        for text in earlier {
            turn.say(text)?;
        }
        let state = {
            let mut heads = self.heads.lock().expect("heads lock");
            if let Some(link) = link {
                heads.chain.release(link);
            }
            heads.moved()?
        };
        turn.say_with_state(last, state.as_ref())?;
        *said = true;
        Ok(())
    }

    /// Results reach their calls from Claude's main chain and from its subagents alike; only
    /// the main chain is Claude's session, so only it moves the head. A replay of a message
    /// Nisse sent acknowledges it and every message sent before it.
    fn on_user(&mut self, turn: &Turn, frame: &Value, is_main_chain: bool) -> Result<()> {
        let reported = self.hand_over_results(frame);
        if !is_main_chain {
            return Ok(());
        }
        let uuid = frame["uuid"].as_str();
        let (named, delivered) = if frame["isReplay"] == true {
            (None, self.acknowledge(uuid))
        } else {
            (uuid, None)
        };
        let state = {
            let mut heads = self.heads.lock().expect("heads lock");
            let link = heads.chain.push(named, reported.len(), delivered);
            heads
                .results
                .extend(reported.into_iter().map(|id| (id, link)));
            heads.moved()?
        };
        save(turn, state)?;
        self.deliver_steers(turn)
    }

    fn acknowledge(&mut self, uuid: Option<&str>) -> Option<Seq> {
        let replayed = self
            .unacked
            .iter()
            .position(|delivery| Some(delivery.uuid.as_str()) == uuid)?;
        self.unacked
            .drain(..=replayed)
            .next_back()
            .map(|delivery| delivery.through)
    }

    /// Hands each result Claude reported to the call waiting for it, and names the calls whose
    /// results are now on their way into the transcript.
    fn hand_over_results(&mut self, frame: &Value) -> Vec<String> {
        let mut reported = Vec::new();
        for block in content(frame).filter(|block| block["type"] == "tool_result") {
            let id = block["tool_use_id"].as_str().unwrap_or_default().to_owned();
            match self.calls.get_mut(&id) {
                Some(call) if !call.done => {
                    if let Some(waiter) = call.waiter.take() {
                        let mut outcome = tool_outcome(block);
                        outcome.denied = call.denied.clone();
                        let _ = waiter.send(outcome);
                    }
                    reported.push(id);
                }
                Some(_) => {}
                None => {
                    let mut heads = self.heads.lock().expect("heads lock");
                    if let Some(link) = heads.uses.remove(&id) {
                        heads.chain.release(link);
                    }
                }
            }
        }
        reported
    }

    fn on_control_request<'a>(
        &mut self,
        turn: &'a Turn,
        frame: &Value,
        started: &Started,
        pending: &mut FuturesUnordered<BoxFuture<'a, Event>>,
    ) {
        let request_id = frame["request_id"].as_str().unwrap_or_default().to_owned();
        let request = &frame["request"];
        match request["subtype"].as_str() {
            Some("hook_callback") if request["input"]["hook_event_name"] == "PreToolUse" => {
                let input = &request["input"];
                let call = ToolCall {
                    id: input["tool_use_id"].as_str().unwrap_or_default().to_owned(),
                    name: input["tool_name"].as_str().unwrap_or_default().to_owned(),
                    args: input["tool_input"].clone(),
                    parent: None,
                };
                let subagent = input["agent_id"]
                    .as_str()
                    .and_then(|agent| self.subagents.started_by.get(agent))
                    .cloned();
                let caller = subagent
                    .as_ref()
                    .and_then(|started_by| self.subagents.turns.get(started_by))
                    .cloned();
                let refused = (caller.is_none() && STARTS_SUBAGENTS.contains(&call.name.as_str()))
                    .then(|| turn.may_spawn().err())
                    .flatten();
                let (waiter, result) = oneshot::channel();
                self.calls.insert(
                    call.id.clone(),
                    Call {
                        subagent,
                        hook_request: request_id,
                        asked_args: call.args.clone(),
                        hook_answered: false,
                        done: false,
                        waiter: Some(waiter),
                        denied: None,
                    },
                );
                let started = started.clone();
                let id = call.id.clone();
                let run = move |call: ToolCall| {
                    if let Some(reason) = refused {
                        return ToolOutcome::denied(reason);
                    }
                    let _ = started.send((id, call));
                    result.blocking_recv().unwrap_or_else(|_| {
                        ToolOutcome::error("claude stopped before the tool finished")
                    })
                };
                match caller {
                    Some(subagent) => pending.push(Box::pin(async move {
                        let id = call.id.clone();
                        let outcome = subagent
                            .call_tool_with_state(call, Approval::NotNeeded, run, || Ok(None))
                            .await;
                        Event::CallDone { id, outcome }
                    })),
                    None => {
                        let heads = self.heads.clone();
                        let settled = call.id.clone();
                        let head = move || heads.lock().expect("heads lock").settle(&settled);
                        pending.push(Box::pin(async move {
                            let id = call.id.clone();
                            let outcome = turn
                                .call_tool_with_state(call, Approval::NotNeeded, run, head)
                                .await;
                            Event::CallDone { id, outcome }
                        }));
                    }
                }
            }
            Some("hook_callback") => self.reply(&request_id, json!({ "continue": true })),
            Some("can_use_tool") => {
                let call = ToolCall {
                    id: request["tool_use_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    name: request["tool_name"].as_str().unwrap_or_default().to_owned(),
                    args: request["input"].clone(),
                    parent: None,
                };
                let reason = request["decision_reason"]
                    .as_str()
                    .or(request["description"].as_str())
                    .map(str::to_owned);
                let started_by = self
                    .calls
                    .get(&call.id)
                    .and_then(|known| known.subagent.clone());
                let asker = self
                    .subagents
                    .of(
                        &request["agent_id"],
                        &started_by.map_or(Value::Null, Value::String),
                    )
                    .cloned();
                pending.push(Box::pin(async move {
                    let decision = match &asker {
                        Some(subagent) => subagent.ask(&call, reason).await,
                        None => turn.ask(&call, reason).await,
                    };
                    Event::Asked {
                        request_id,
                        id: call.id,
                        input: call.args,
                        decision,
                    }
                }));
            }
            other => self.process.send(json!({
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": request_id,
                    "error": format!("nisse does not handle {}", other.unwrap_or("this request")),
                },
            })),
        }
    }

    /// The hooks let the call through: Claude runs it, with the hooks' arguments.
    fn on_run(&mut self, id: &str, call: ToolCall) {
        let Some(asked) = self.calls.get_mut(id) else {
            return;
        };
        asked.hook_answered = true;
        let hook_request = asked.hook_request.clone();
        let mut allow = json!({ "continue": true });
        if call.args != asked.asked_args {
            allow["hookSpecificOutput"] =
                json!({ "hookEventName": "PreToolUse", "updatedInput": call.args });
        }
        self.reply(&hook_request, allow);
    }

    fn on_event(&mut self, turn: &Turn, event: Event) -> Result<()> {
        match event {
            Event::CallDone { id, outcome } => {
                let outcome = outcome?;
                if let Some(call) = self.calls.get_mut(&id) {
                    call.done = true;
                    if !call.hook_answered {
                        call.hook_answered = true;
                        let reason = outcome.denied.clone().unwrap_or(outcome.output);
                        let hook_request = call.hook_request.clone();
                        self.reply(
                            &hook_request,
                            json!({
                                "continue": true,
                                "hookSpecificOutput": {
                                    "hookEventName": "PreToolUse",
                                    "permissionDecision": "deny",
                                    "permissionDecisionReason": reason,
                                },
                            }),
                        );
                    }
                }
                self.deliver_steers(turn)
            }
            Event::Asked {
                request_id,
                id,
                input,
                decision,
            } => {
                let answer = match decision? {
                    Decision::Allow => {
                        json!({ "behavior": "allow", "updatedInput": input, "toolUseID": id })
                    }
                    Decision::Deny(reason) => {
                        if let Some(call) = self.calls.get_mut(&id) {
                            call.denied = Some(reason.clone());
                        }
                        json!({ "behavior": "deny", "message": reason, "toolUseID": id })
                    }
                };
                self.reply(&request_id, answer);
                Ok(())
            }
        }
    }

    fn reply(&self, request_id: &str, response: Value) {
        self.process.send(json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request_id, "response": response },
        }));
    }
}

fn save(turn: &Turn, state: Option<Value>) -> Result<()> {
    state.map_or(Ok(()), |state| turn.set_provider_state(&state))
}

fn finish(turn: &Turn, result: &Value, said: bool) -> Result<()> {
    if result["is_error"] == true || result["subtype"] != "success" {
        return Err(anyhow!(result_text(result)));
    }
    let text = result["result"].as_str().unwrap_or_default();
    if !said && !text.trim().is_empty() {
        turn.answer(text)?;
    }
    Ok(())
}

fn result_text(result: &Value) -> String {
    let text = result["result"].as_str().unwrap_or_default();
    let errors = result["errors"]
        .as_array()
        .map(|errors| {
            errors
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default();
    let subtype = result["subtype"].as_str().unwrap_or("error");
    format!(
        "claude: {subtype}: {}",
        [text, errors.as_str()].join(" ").trim()
    )
}

/// The conversation as a session that never held it hears it: its first turn, and as many of
/// its newest turns as fit in the budget besides, each one whole. The newest turn is always
/// told.
fn retelling(entries: &[Entry]) -> Vec<String> {
    let mut turns: Vec<Vec<String>> = Vec::new();
    for entry in entries {
        if turns.is_empty() || entry.kind == kinds::USER {
            turns.push(Vec::new());
        }
        if let Some(text) = retold(entry)
            && let Some(turn) = turns.last_mut()
        {
            turn.push(text);
        }
    }
    let size = |turn: &Vec<String>| turn.iter().map(String::len).sum::<usize>();
    let mut room = RETELL_BUDGET.saturating_sub(turns.first().map_or(0, size));
    let mut kept_from = turns.len();
    while kept_from > 1 {
        let turn = size(&turns[kept_from - 1]);
        if turn > room && kept_from < turns.len() {
            break;
        }
        room = room.saturating_sub(turn);
        kept_from -= 1;
    }
    let left_out = kept_from.saturating_sub(1);
    let mut told = vec![RETOLD.to_owned()];
    let mut turns = turns.into_iter();
    told.extend(turns.next().into_iter().flatten());
    match left_out {
        0 => {}
        1 => told.push("(One turn of the conversation is left out here.)".into()),
        _ => told.push(format!(
            "({left_out} turns of the conversation are left out here.)"
        )),
    }
    told.extend(turns.skip(left_out).flatten());
    told
}

/// An entry as a session that never held it hears it: what people said, as they said it, and
/// Claude's own part as a record of what it did.
fn retold(entry: &Entry) -> Option<String> {
    let data = &entry.data;
    let name = data["name"].as_str().unwrap_or("tool");
    match entry.kind.as_str() {
        kinds::USER => data["text"].as_str().map(str::to_owned),
        kinds::ASSISTANT if data["is_error"] != true => data["text"]
            .as_str()
            .map(|text| format!("You answered: {text}")),
        kinds::TOOL_CALL => Some(format!(
            "You called {name} ({}) with {}",
            data["id"].as_str().unwrap_or_default(),
            data["args"]
        )),
        kinds::TOOL_RESULT => {
            let call_id = data["call_id"].as_str().unwrap_or_default();
            Some(match data["denied"].as_str() {
                Some(reason) => format!("Your {name} call {call_id} was denied: {reason}"),
                None => format!(
                    "Your {name} call {call_id} returned: {}",
                    data["output"].as_str().unwrap_or_default()
                ),
            })
        }
        _ => None,
    }
}

fn content(frame: &Value) -> impl Iterator<Item = &Value> {
    frame["message"]["content"].as_array().into_iter().flatten()
}

fn tool_outcome(block: &Value) -> ToolOutcome {
    let output = match &block["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    ToolOutcome {
        output,
        is_error: block["is_error"] == true,
        denied: None,
    }
}

fn texts(frame: &Value) -> impl Iterator<Item = &str> {
    content(frame)
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .filter(|text| !text.trim().is_empty())
}

/// Claude's chain, the calls whose entries its links wait for, and the provider state Nisse
/// committed last. It is shared with the calls, whose results commit the head that covers them.
struct Heads {
    chain: Chain,
    uses: HashMap<String, usize>,
    results: HashMap<String, usize>,
    saved: ProviderState,
}

impl Heads {
    fn new(saved: ProviderState) -> Self {
        Self {
            chain: Chain {
                head: saved.head.clone(),
                delivered: saved.delivered,
                heard: saved.delivered,
                ..Chain::default()
            },
            uses: HashMap::new(),
            results: HashMap::new(),
            saved,
        }
    }

    /// One of the call's entries is being committed: the link that waited for it is released.
    fn settle(&mut self, id: &str) -> Result<Option<Value>> {
        for links in [&mut self.uses, &mut self.results] {
            if let Some(link) = links.remove(id) {
                self.chain.release(link);
            }
        }
        self.moved()
    }

    /// The provider state to commit now, when the head has moved since the last one.
    fn moved(&mut self) -> Result<Option<Value>> {
        self.chain.advance();
        if self.chain.head == self.saved.head && self.chain.delivered == self.saved.delivered {
            return Ok(None);
        }
        self.saved.head = self.chain.head.clone();
        self.saved.delivered = self.chain.delivered;
        Ok(Some(serde_json::to_value(&self.saved)?))
    }
}

/// Claude's main chain as Nisse has seen it. The head is the newest of Claude's own messages
/// such that every message up to it has had its content committed; resuming there loses
/// nothing a client saw and keeps nothing it did not. Replays of Nisse's messages never name
/// the head; what they acknowledge counts as delivered once a message of Claude's after them
/// does.
#[derive(Default)]
struct Chain {
    passed: usize,
    links: VecDeque<Link>,
    head: Option<String>,
    delivered: Seq,
    heard: Seq,
}

struct Link {
    uuid: Option<String>,
    waiting: usize,
    delivered: Option<Seq>,
}

impl Chain {
    fn push(&mut self, uuid: Option<&str>, waiting: usize, delivered: Option<Seq>) -> usize {
        self.links.push_back(Link {
            uuid: uuid.map(str::to_owned),
            waiting,
            delivered,
        });
        self.passed + self.links.len() - 1
    }

    fn release(&mut self, link: usize) {
        if let Some(link) = link
            .checked_sub(self.passed)
            .and_then(|offset| self.links.get_mut(offset))
        {
            link.waiting = link.waiting.saturating_sub(1);
        }
    }

    fn advance(&mut self) {
        while self.links.front().is_some_and(|link| link.waiting == 0) {
            let link = self.links.pop_front().expect("a front link");
            self.passed += 1;
            if let Some(delivered) = link.delivered {
                self.heard = self.heard.max(delivered);
            }
            if let Some(uuid) = link.uuid {
                self.head = Some(uuid);
                self.delivered = self.heard;
            }
        }
    }
}
