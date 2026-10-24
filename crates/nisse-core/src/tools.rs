mod bash;
mod edit;
mod files;
mod grep;

use std::path::Path;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::turn::Approval;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
    /// The call whose script made this one, as in code mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolOutcome {
    pub output: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denied: Option<String>,
}

impl ToolOutcome {
    pub fn denied(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            output: reason.clone(),
            is_error: true,
            denied: Some(reason),
        }
    }

    pub fn ok(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            is_error: false,
            denied: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            output: message.into(),
            is_error: true,
            denied: None,
        }
    }
}

/// The conversation a tool call is made in, as extensions see it.
#[derive(Debug, Clone, Serialize)]
pub struct CallContext {
    #[serde(rename = "id")]
    pub conversation_id: String,
    /// The conversation that started this one, when it is a subagent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// What extensions can change. `engine` is Nisse's own behaviour: the end of every chain.
pub trait Hooks: Send + Sync {
    fn prompt_submit(&self, text: String) -> Result<String, String> {
        Ok(text)
    }

    fn tool_call(
        &self,
        context: &CallContext,
        call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        let _ = context;
        engine(call)
    }
}

pub struct NoHooks;

impl Hooks for NoHooks {}

/// A tool as a model sees it: `parameters` is a JSON Schema for the call's arguments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

fn spec(name: &str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters,
    }
}

pub fn builtin_tools() -> Vec<ToolSpec> {
    vec![
        spec(
            "Read",
            "Read a text file. Returns each line prefixed with its 1-based number and a tab, \
             up to 2000 lines from `offset`; very long lines are cut. When more lines remain, \
             the output ends with the offset to continue from.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "The file to read; relative paths resolve against the working directory." },
                    "offset": { "type": "integer", "minimum": 1, "description": "The first line to read, counting from 1. Default 1." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": files::READ_LINES, "description": "How many lines to read. Default 2000." }
                },
                "required": ["file_path"],
                "additionalProperties": false
            }),
        ),
        spec(
            "Write",
            "Write `content` to a file, replacing the file if it exists and creating missing \
             parent directories. To change part of an existing file, use `Edit`.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "The file to write; relative paths resolve against the working directory." },
                    "content": { "type": "string", "description": "The file's whole new content." }
                },
                "required": ["file_path", "content"],
                "additionalProperties": false
            }),
        ),
        spec(
            "Edit",
            "Replace exact text in a file. `old_string` must match the file exactly, whitespace \
             and indentation included, and appear exactly once; include surrounding lines to make \
             it unique, or set `replace_all` to replace every occurrence.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "The file to edit; relative paths resolve against the working directory." },
                    "old_string": { "type": "string", "description": "The exact text to replace." },
                    "new_string": { "type": "string", "description": "The text to put in its place; must differ from old_string." },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of exactly one. Default false." }
                },
                "required": ["file_path", "old_string", "new_string"],
                "additionalProperties": false
            }),
        ),
        spec(
            "Bash",
            "Run a command with `sh -c` in the working directory, with no terminal and no stdin. \
             Returns when the shell exits, with stdout and stderr interleaved, keeping the last 16 KiB; \
             processes started in the background with `&` keep running. If the shell is still running \
             after `timeout`, it and every process it started are killed.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The shell command to run." },
                    "timeout": { "type": "integer", "minimum": 1, "maximum": bash::MAX_TIMEOUT_MS, "description": "Milliseconds before the command is killed. Default 120000." }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        ),
        spec(
            "Grep",
            "Search file contents for a regular expression (Rust regex syntax, as in ripgrep). \
             Returns `path:line:text` for each matching line, in path order, up to 200 matches; \
             very long lines are cut. Skips hidden files, binary files and files that a \
             `.gitignore` or `.ignore` excludes.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "The regular expression to search for." },
                    "path": { "type": "string", "description": "The file or directory to search. Default the working directory." },
                    "glob": { "type": "string", "description": "Only search files whose path matches this glob, such as `*.rs` or `src/**/*.ts`." }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
    ]
}

/// Whether a built-in call needs a person's approval before it runs. Unknown names need one.
pub fn approval_for(name: &str) -> Approval {
    match name {
        "Read" | "Grep" => Approval::NotNeeded,
        agent if crate::agents::is_agent_tool(agent) => Approval::NotNeeded,
        _ => Approval::Ask,
    }
}

/// Runs built-in calls in `cwd`, the conversation's directory.
pub fn run_builtin_tool(cwd: &Path) -> impl FnOnce(ToolCall) -> ToolOutcome + Send + 'static {
    let cwd = cwd.to_owned();
    move |call| run_in(&cwd, call)
}

fn run_in(cwd: &Path, call: ToolCall) -> ToolOutcome {
    match call.name.as_str() {
        "Read" => parsed(&call, |args| files::read(cwd, args)),
        "Write" => parsed(&call, |args| files::write(cwd, args)),
        "Edit" => parsed(&call, |args| edit::edit(cwd, args)),
        "Bash" => parsed(&call, |args| bash::bash(cwd, args)),
        "Grep" => parsed(&call, |args| grep::grep(cwd, args)),
        other => ToolOutcome::error(format!("no tool named {other}")),
    }
}

fn parsed<T: DeserializeOwned>(call: &ToolCall, run: impl FnOnce(T) -> ToolOutcome) -> ToolOutcome {
    match T::deserialize(&call.args) {
        Ok(args) => run(args),
        Err(error) => ToolOutcome::error(format!("bad arguments for {}: {error}", call.name)),
    }
}
