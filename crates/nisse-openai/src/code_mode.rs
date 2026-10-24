//! Code mode, as current OpenAI coding models expect it: the model gets `exec`, which runs
//! JavaScript in Codex's code-mode host, and `wait`, which resumes a script that yielded. Every
//! other tool is a method on the script's global `tools`, and each such nested call goes through
//! Nisse's tool path: committed, hooked, approved, its result committed.

mod apply_patch;
mod host;
mod nested;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Result, bail};
use nisse_core::{Approval, ToolCall, ToolOutcome, Turn, approval_for, with_nested_results};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{sync::mpsc, task::JoinSet};

use host::{Delegated, Host, Runtime};
pub use nested::NestedTools;
use nested::run_nested_tool;

pub const EXEC: &str = "exec";
pub const WAIT: &str = "wait";
pub const HOST_PROGRAM: &str = "codex-code-mode-host";
const HOST_IDLE: Duration = Duration::from_secs(300);
const DEFAULT_YIELD_TIME_MS: u64 = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;
const BYTES_PER_TOKEN: usize = 4;
const PRAGMA: &str = "// @exec:";

const EXEC_GRAMMAR: &str = r#"
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
"#;

const EXEC_DESCRIPTION: &str = r#"Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global `tools` object, for example `await tools.{{ first_tool }}(...)`. Tool names are exposed as normalized JavaScript identifiers.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.
- `yield_time_ms` asks `exec` to yield early if the script is still running. Defaults to 10000 ms.
- `max_output_tokens` sets the token budget for direct `exec` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- `exit()`: Immediately ends the current script successfully (like an early return from the top level).
- `text(value: string | number | boolean | undefined | null)`: Appends a text item. Non-string values are stringified with `JSON.stringify(...)` when possible.
- `store(key: string, value: any)`: stores a serializable value under a string key for later `exec` calls in the same session.
- `load(key: string)`: returns the stored value for a string key, or `undefined` if it is missing.
- `setTimeout(callback: () => void, delayMs?: number)`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep `exec` alive by themselves; await an explicit promise if you need to wait for one.
- `clearTimeout(timeoutId?: number)`: cancels a timeout created by `setTimeout`.
- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description }` entries.
- `yield_control()`: yields the accumulated output to the model immediately while the script keeps running."#;

const WAIT_DESCRIPTION: &str = r#"Waits on a yielded `exec` cell and returns new output or completion.
- Use `wait` only after `exec` returns `Script running with cell ID ...`.
- `cell_id` identifies the running `exec` cell to resume.
- `yield_time_ms` controls how long to wait for more output before yielding again. Defaults to 10000 ms.
- `max_tokens` limits how much new output this wait call returns. Defaults to 10000 tokens.
- `terminate: true` stops the running cell; false or omitted waits for output.
- `wait` returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, `wait` may yield again with the same `cell_id`.
- If the cell has already finished, `wait` returns the completed result and closes the cell."#;

pub(crate) struct CodeMode {
    host: Arc<Host>,
    tools: NestedTools,
}

impl CodeMode {
    pub fn new(program: PathBuf, tools: NestedTools) -> Self {
        Self {
            host: Arc::new(Host::new(program, HOST_IDLE)),
            tools,
        }
    }

    /// `exec` and `wait`, as the Responses API takes them.
    pub fn tools(&self) -> Vec<Value> {
        let nested = self.tools.tools();
        let mut description = EXEC_DESCRIPTION.replace(
            "{{ first_tool }}",
            nested.first().map_or("name", |tool| tool.name.as_str()),
        );
        for tool in &nested {
            description.push_str("\n\n");
            description.push_str(&tool.section());
        }
        vec![
            json!({
                "type": "custom",
                "name": EXEC,
                "description": description,
                "format": { "type": "grammar", "syntax": "lark", "definition": EXEC_GRAMMAR },
            }),
            json!({
                "type": "function",
                "name": WAIT,
                "description": WAIT_DESCRIPTION,
                "strict": false,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cell_id": { "type": "string", "description": "Identifier of the running exec cell." },
                        "yield_time_ms": { "type": "number", "description": "Wait before yielding more output. Defaults to 10000 ms." },
                        "max_tokens": { "type": "number", "description": "Output token budget for this wait call. Defaults to 10000 tokens." },
                        "terminate": { "type": "boolean", "description": "True stops the running exec cell; false or omitted waits for output." }
                    },
                    "required": ["cell_id"],
                    "additionalProperties": false
                },
            }),
        ]
    }

    /// Readies code mode for one run of `turn`. The host itself starts with the first `exec`.
    pub fn begin(&self, turn: &Turn) -> Result<Run> {
        if !is_installed(self.host.program()) {
            bail!(
                "this model works in code mode, which needs Codex's {HOST_PROGRAM}; \
                 install it with scripts/code-mode-host.sh, or point NISSE_CODE_MODE_HOST at it"
            );
        }
        let (calls, delegated) = mpsc::unbounded_channel();
        self.host.begin_run(turn.conversation_id(), calls);
        let cells = Arc::new(Cells::default());
        let nested = tokio::spawn(answer_nested_calls(
            delegated,
            turn.clone(),
            cells.clone(),
            self.tools,
        ));
        Ok(Run {
            host: self.host.clone(),
            tools: self.tools,
            turn: turn.clone(),
            cells,
            nested,
        })
    }
}

/// Which `exec` call started each cell of a run, and which cells still run.
#[derive(Default)]
struct Cells {
    started_by: Mutex<HashMap<String, String>>,
    starting: Mutex<Option<String>>,
    running: Mutex<HashSet<String>>,
}

impl Cells {
    /// The `exec` call behind `cell_id`. A cell the host has not named yet is the one starting:
    /// a run starts one `exec` at a time.
    fn parent(&self, cell_id: &str) -> Option<String> {
        let started_by = self.started_by.lock().expect("cells lock");
        started_by
            .get(cell_id)
            .cloned()
            .or_else(|| self.starting.lock().expect("cells lock").clone())
    }

    fn settled(&self, runtime: &Runtime) {
        let mut running = self.running.lock().expect("cells lock");
        match runtime {
            Runtime::Yielded { cell_id, .. } => running.insert(cell_id.clone()),
            Runtime::Terminated { cell_id, .. } | Runtime::Result { cell_id, .. } => {
                running.remove(cell_id)
            }
        };
    }
}

pub(crate) struct Run {
    host: Arc<Host>,
    tools: NestedTools,
    turn: Turn,
    cells: Arc<Cells>,
    nested: tokio::task::JoinHandle<()>,
}

impl Run {
    pub async fn call(&self, call: ToolCall) -> Result<ToolOutcome> {
        let host = self.host.clone();
        let cells = self.cells.clone();
        let turn = self.turn.clone();
        let tools = self.tools;
        let runtime = tokio::runtime::Handle::current();
        self.turn
            .call_tool(call, Approval::NotNeeded, move |call| {
                runtime.block_on(async {
                    let started = Instant::now();
                    match call.name.as_str() {
                        EXEC => exec(&host, tools, &cells, &turn, &call, started).await,
                        _ => wait(&host, &cells, &turn, &call, started).await,
                    }
                })
            })
            .await
    }

    /// Ends the run's scripts. A nested call still waiting for its approval or its tool is cut
    /// off, and the run closes it as it closes any call it ended.
    pub async fn finish(self) {
        let conversation = self.turn.conversation_id();
        let running: Vec<String> = self
            .cells
            .running
            .lock()
            .expect("cells lock")
            .drain()
            .collect();
        if !running.is_empty()
            && let Ok(connection) = self.host.session(conversation).await
        {
            for cell_id in running {
                let _ = connection.terminate(conversation, &cell_id).await;
            }
        }
        self.host.end_run(conversation);
        self.nested.abort();
        let _ = self.nested.await;
    }
}

#[derive(Deserialize)]
struct Pragma {
    yield_time_ms: Option<u64>,
    max_output_tokens: Option<usize>,
}

async fn exec(
    host: &Host,
    tools: NestedTools,
    cells: &Cells,
    turn: &Turn,
    call: &ToolCall,
    started: Instant,
) -> ToolOutcome {
    let Some(input) = call.args.as_str().filter(|input| !input.trim().is_empty()) else {
        return ToolOutcome::error("exec expects raw JavaScript source text");
    };
    let (source, pragma) = match parse_pragma(input) {
        Ok(parsed) => parsed,
        Err(error) => return ToolOutcome::error(error),
    };
    let conversation = turn.conversation_id();
    let connection = match host.session(conversation).await {
        Ok(connection) => connection,
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let enabled: Vec<Value> = tools.tools().iter().map(|tool| tool.definition()).collect();
    *cells.starting.lock().expect("cells lock") = Some(call.id.clone());
    let answered = connection
        .execute(
            conversation,
            json!({
                "tool_call_id": call.id,
                "enabled_tools": enabled,
                "source": source,
                "yield_time_ms": pragma.yield_time_ms.unwrap_or(DEFAULT_YIELD_TIME_MS),
                "max_output_tokens": pragma.max_output_tokens,
            }),
            |cell_id| {
                cells
                    .started_by
                    .lock()
                    .expect("cells lock")
                    .insert(cell_id.to_owned(), call.id.clone());
            },
        )
        .await;
    *cells.starting.lock().expect("cells lock") = None;
    answered_outcome(
        answered,
        cells,
        turn,
        call,
        started,
        pragma.max_output_tokens,
    )
}

#[derive(Deserialize)]
struct WaitArgs {
    cell_id: String,
    yield_time_ms: Option<u64>,
    max_tokens: Option<usize>,
    #[serde(default)]
    terminate: bool,
}

async fn wait(
    host: &Host,
    cells: &Cells,
    turn: &Turn,
    call: &ToolCall,
    started: Instant,
) -> ToolOutcome {
    let args = match WaitArgs::deserialize(&call.args) {
        Ok(args) => args,
        Err(error) => return ToolOutcome::error(format!("bad arguments for wait: {error}")),
    };
    let conversation = turn.conversation_id();
    let connection = match host.session(conversation).await {
        Ok(connection) => connection,
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let answered = match args.terminate {
        true => connection.terminate(conversation, &args.cell_id).await,
        false => {
            let yield_time_ms = args.yield_time_ms.unwrap_or(DEFAULT_YIELD_TIME_MS);
            connection
                .wait(conversation, &args.cell_id, yield_time_ms)
                .await
        }
    };
    answered_outcome(answered, cells, turn, call, started, args.max_tokens)
}

fn answered_outcome(
    answered: Result<Runtime>,
    cells: &Cells,
    turn: &Turn,
    call: &ToolCall,
    started: Instant,
    max_output_tokens: Option<usize>,
) -> ToolOutcome {
    let runtime = match answered {
        Ok(runtime) => runtime,
        Err(error) => {
            let interrupted =
                format!("interrupted: {error:#}; the script may or may not have taken effect");
            let output = match turn.transcript() {
                Ok(entries) => with_nested_results(&interrupted, &call.id, &entries),
                Err(_) => interrupted,
            };
            return ToolOutcome::error(output);
        }
    };
    cells.settled(&runtime);
    let (status, items, error_text) = match &runtime {
        Runtime::Yielded {
            cell_id,
            content_items,
        } => (
            format!("Script running with cell ID {cell_id}"),
            content_items,
            None,
        ),
        Runtime::Terminated { content_items, .. } => {
            ("Script terminated".to_owned(), content_items, None)
        }
        Runtime::Result {
            content_items,
            error_text,
            ..
        } => (
            match error_text {
                None => "Script completed".to_owned(),
                Some(_) => "Script failed".to_owned(),
            },
            content_items,
            error_text.as_deref(),
        ),
    };
    let mut output: Vec<String> = items.iter().map(item_text).collect();
    if let Some(error) = error_text {
        output.push(format!("Script error:\n{error}"));
    }
    let seconds = (started.elapsed().as_secs_f32() * 10.0).round() / 10.0;
    ToolOutcome {
        output: format!(
            "{status}\nWall time {seconds:.1} seconds\nOutput:\n{}",
            within_budget(
                &output.join("\n"),
                max_output_tokens.unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
            )
        ),
        is_error: error_text.is_some(),
        denied: None,
    }
}

fn item_text(item: &Value) -> String {
    match item["text"].as_str() {
        Some(text) => text.to_owned(),
        None => format!("[{} omitted]", item["type"].as_str().unwrap_or("item")),
    }
}

fn within_budget(text: &str, max_tokens: usize) -> String {
    let budget = max_tokens.saturating_mul(BYTES_PER_TOKEN);
    if text.len() <= budget {
        return text.to_owned();
    }
    let head = text.floor_char_boundary(budget / 2);
    let tail = text.ceil_char_boundary(text.len() - budget / 2);
    let cut = (tail - head) / BYTES_PER_TOKEN;
    format!(
        "Warning: truncated output (original token count: {})\n{}…{cut} tokens truncated…{}",
        text.len() / BYTES_PER_TOKEN,
        &text[..head],
        &text[tail..]
    )
}

fn parse_pragma(input: &str) -> Result<(&str, Pragma), String> {
    let none = Pragma {
        yield_time_ms: None,
        max_output_tokens: None,
    };
    let (first, rest) = input.split_once('\n').unwrap_or((input, ""));
    let Some(pragma) = first.trim_start().strip_prefix(PRAGMA) else {
        return Ok((input, none));
    };
    if rest.trim().is_empty() {
        return Err("exec pragma must be followed by JavaScript source on subsequent lines".into());
    }
    let pragma: Pragma = serde_json::from_str(pragma.trim()).map_err(|error| {
        format!(
            "exec pragma must be a JSON object with `yield_time_ms` and `max_output_tokens`: {error}"
        )
    })?;
    Ok((rest, pragma))
}

async fn answer_nested_calls(
    mut delegated: mpsc::UnboundedReceiver<Delegated>,
    turn: Turn,
    cells: Arc<Cells>,
    tools: NestedTools,
) {
    let mut calls = JoinSet::new();
    loop {
        tokio::select! {
            Some(delegated) = delegated.recv() => {
                calls.spawn(answer_nested_call(delegated, turn.clone(), cells.clone(), tools));
            }
            Some(_) = calls.join_next(), if !calls.is_empty() => {}
            else => return,
        }
    }
}

async fn answer_nested_call(
    delegated: Delegated,
    turn: Turn,
    cells: Arc<Cells>,
    tools: NestedTools,
) {
    let Delegated {
        id,
        cell_id,
        runtime_call_id,
        tool,
        input,
        connection,
    } = delegated;
    let Some(parent) = cells.parent(&cell_id) else {
        connection.answer(id, Err(format!("no exec call started cell {cell_id}")));
        return;
    };
    let (name, args) = match tools.call(&tool, input) {
        Ok(call) => call,
        Err(error) => return connection.answer(id, Err(error)),
    };
    let call = ToolCall {
        id: format!("{parent}/{runtime_call_id}"),
        name,
        args,
        parent: Some(parent),
    };
    let approval = approval_for(&call.name);
    let answered = turn
        .call_tool(call, approval, run_nested_tool(turn.cwd()))
        .await;
    connection.answer(
        id,
        answered
            .map(|outcome| json!(outcome))
            .map_err(|error| format!("{error:#}")),
    );
}

fn is_installed(program: &std::path::Path) -> bool {
    if program.components().count() > 1 {
        return program.is_file();
    }
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(program).is_file()))
}
