use std::collections::{HashMap, VecDeque};

use anyhow::{Result, anyhow};
use futures_util::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use nisse_core::{Approval, Decision, ToolCall, ToolOutcome, Turn};
use nisse_protocol::{Entry, Seq, kinds};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::process::Process;

pub(crate) const PRE_TOOL_USE: &str = "nisse_pre_tool_use";

const RESTARTED: &str = "Nisse restarted before you finished. Continue where you left off.";

const RETOLD: &str = "Your earlier Claude Code session of this conversation could not be resumed. \
                      This is the conversation so far; continue it.";

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
    state: ProviderState,
    resumed: bool,
    initialized: bool,
    retell: bool,
    chain: Chain,
    sent: Seq,
    unacked: VecDeque<Seq>,
    calls: HashMap<String, Call>,
    uses: HashMap<String, usize>,
    results: HashMap<String, usize>,
    streaming: String,
}

struct Call {
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
    pub(crate) fn new(process: Process, state: ProviderState) -> Self {
        Self {
            process,
            resumed: state.head.is_some(),
            initialized: false,
            retell: false,
            chain: Chain {
                head: state.head.clone(),
                delivered: state.delivered,
                ..Chain::default()
            },
            sent: state.delivered,
            state,
            unacked: VecDeque::new(),
            calls: HashMap::new(),
            uses: HashMap::new(),
            results: HashMap::new(),
            streaming: String::new(),
        }
    }

    /// For a session that replaces one Claude lost: its first message retells the whole
    /// transcript, Claude's own part included.
    pub(crate) fn retelling(mut self) -> Self {
        self.retell = true;
        self
    }

    pub(crate) fn has_stopped(&mut self) -> bool {
        self.process.has_exited()
    }

    /// Hands Claude what the conversation gained since it last heard, and commits Claude's
    /// work until it answers all of it.
    pub(crate) async fn answer(&mut self, turn: &Turn) -> Result<()> {
        self.deliver(turn, true)?;
        let (started, mut runs) = mpsc::unbounded_channel();
        let mut pending: FuturesUnordered<BoxFuture<'_, Event>> = FuturesUnordered::new();
        let mut said = false;
        loop {
            let committing = self.committing();
            tokio::select! {
                frame = self.process.inbound.recv(), if !committing => {
                    let Some(frame) = frame else {
                        let reason = self.process.exit_reason().await;
                        return Err(self.stopped(reason));
                    };
                    if frame["type"] == "result" && !self.initialized {
                        return Err(self.stopped(result_text(&frame)));
                    }
                    if frame["type"] == "result" && self.unacked.is_empty() {
                        self.calls.clear();
                        return finish(turn, &frame, said);
                    }
                    self.on_frame(turn, frame, &started, &mut pending, &mut said)?;
                }
                Some((id, call)) = runs.recv() => self.on_run(turn, &id, call)?,
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
        let entries = turn.transcript()?;
        let Some(newest) = entries.last().map(|entry| entry.seq) else {
            return Ok(());
        };
        let unheard = entries.iter().filter(|entry| entry.seq > self.sent);
        let texts: Vec<String> = if std::mem::take(&mut self.retell) {
            std::iter::once(RETOLD.to_owned())
                .chain(unheard.filter_map(retold))
                .collect()
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
        self.unacked.push_back(self.sent);
        self.process.send(json!({
            "type": "user",
            "message": { "role": "user", "content": blocks },
            "parent_tool_use_id": null,
        }));
        Ok(())
    }

    /// What Claude must hear about an entry it has not seen: what people said, and calls a
    /// restart cut off, which Claude's session no longer holds a result for.
    fn told(&self, entry: &Entry) -> Option<String> {
        match entry.kind.as_str() {
            kinds::USER => entry.data["text"].as_str().map(str::to_owned),
            kinds::TOOL_RESULT => {
                let call_id = entry.data["call_id"].as_str()?;
                let output = entry.data["output"].as_str()?;
                let cut_off = output.starts_with("interrupted:") || output.starts_with("not run:");
                (cut_off && !self.calls.contains_key(call_id)).then(|| {
                    let name = entry.data["name"].as_str().unwrap_or("tool");
                    format!("Your {name} call {call_id} was cut off when Nisse restarted: {output}")
                })
            }
            _ => None,
        }
    }

    fn on_frame<'a>(
        &mut self,
        turn: &'a Turn,
        frame: Value,
        started: &Started,
        pending: &mut FuturesUnordered<BoxFuture<'a, Event>>,
        said: &mut bool,
    ) -> Result<()> {
        let is_main_chain = frame["parent_tool_use_id"].is_null();
        match frame["type"].as_str() {
            Some("stream_event") if is_main_chain => self.on_stream(turn, &frame["event"]),
            Some("assistant") if is_main_chain => self.on_assistant(turn, &frame, said)?,
            Some("user") => self.on_user(turn, &frame, is_main_chain)?,
            Some("control_response") => self.initialized = true,
            Some("control_request") => self.on_control_request(turn, &frame, started, pending),
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

    fn on_assistant(&mut self, turn: &Turn, frame: &Value, said: &mut bool) -> Result<()> {
        let mut waiting_for = Vec::new();
        for block in content(frame) {
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or_default();
                    if !text.trim().is_empty() {
                        turn.say(text)?;
                        *said = true;
                    }
                    self.streaming.clear();
                }
                Some("tool_use") => {
                    let id = block["id"].as_str().unwrap_or_default();
                    if !self.calls.get(id).is_some_and(|call| call.hook_answered) {
                        waiting_for.push(id.to_owned());
                    }
                }
                _ => {}
            }
        }
        if let Some(uuid) = frame["uuid"].as_str() {
            let link = self.chain.push(uuid, waiting_for.len(), None);
            self.uses
                .extend(waiting_for.into_iter().map(|id| (id, link)));
        }
        self.persist(turn)
    }

    /// Results reach their calls from Claude's main chain and from its subagents alike; only
    /// the main chain is Claude's session, so only it moves the head.
    fn on_user(&mut self, turn: &Turn, frame: &Value, is_main_chain: bool) -> Result<()> {
        let reported = self.hand_over_results(frame);
        if !is_main_chain {
            return Ok(());
        }
        let uuid = frame["uuid"].as_str().unwrap_or_default();
        let delivered = if frame["isReplay"] == true {
            self.unacked.pop_front()
        } else {
            None
        };
        let link = self.chain.push(uuid, reported.len(), delivered);
        self.results
            .extend(reported.into_iter().map(|id| (id, link)));
        self.persist(turn)
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
                    if let Some(link) = self.uses.remove(&id) {
                        self.chain.release(link);
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
                };
                let (waiter, result) = oneshot::channel();
                self.calls.insert(
                    call.id.clone(),
                    Call {
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
                    let _ = started.send((id, call));
                    result.blocking_recv().unwrap_or_else(|_| {
                        ToolOutcome::error("claude stopped before the tool finished")
                    })
                };
                pending.push(Box::pin(async move {
                    let id = call.id.clone();
                    let outcome = turn.call_tool(call, Approval::NotNeeded, run).await;
                    Event::CallDone { id, outcome }
                }));
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
                };
                let reason = request["decision_reason"]
                    .as_str()
                    .or(request["description"].as_str())
                    .map(str::to_owned);
                pending.push(Box::pin(async move {
                    let decision = turn.ask(&call, reason).await;
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
    fn on_run(&mut self, turn: &Turn, id: &str, call: ToolCall) -> Result<()> {
        let Some(asked) = self.calls.get_mut(id) else {
            return Ok(());
        };
        asked.hook_answered = true;
        let hook_request = asked.hook_request.clone();
        let mut allow = json!({ "continue": true });
        if call.args != asked.asked_args {
            allow["hookSpecificOutput"] =
                json!({ "hookEventName": "PreToolUse", "updatedInput": call.args });
        }
        if let Some(link) = self.uses.remove(id) {
            self.chain.release(link);
        }
        self.persist(turn)?;
        self.reply(&hook_request, allow);
        Ok(())
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
                for links in [&mut self.uses, &mut self.results] {
                    if let Some(link) = links.remove(&id) {
                        self.chain.release(link);
                    }
                }
                self.persist(turn)?;
                self.deliver(turn, false)
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

    fn persist(&mut self, turn: &Turn) -> Result<()> {
        self.chain.advance();
        if self.chain.head == self.state.head && self.chain.delivered == self.state.delivered {
            return Ok(());
        }
        self.state.head = self.chain.head.clone();
        self.state.delivered = self.chain.delivered;
        turn.set_provider_state(&serde_json::to_value(&self.state)?)
    }
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

/// Claude's main chain as Nisse has seen it. The head is the newest message such that every
/// message up to it has had its content committed; resuming there loses nothing a client saw
/// and keeps nothing it did not.
#[derive(Default)]
struct Chain {
    passed: usize,
    links: VecDeque<Link>,
    head: Option<String>,
    delivered: Seq,
}

struct Link {
    uuid: String,
    waiting: usize,
    delivered: Option<Seq>,
}

impl Chain {
    fn push(&mut self, uuid: &str, waiting: usize, delivered: Option<Seq>) -> usize {
        self.links.push_back(Link {
            uuid: uuid.to_owned(),
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
            if !link.uuid.is_empty() {
                self.head = Some(link.uuid);
            }
            if let Some(delivered) = link.delivered {
                self.delivered = self.delivered.max(delivered);
            }
        }
    }
}
