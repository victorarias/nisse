use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::turn::Approval;

const OUTPUT_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
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

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            output: message.into(),
            is_error: true,
            denied: None,
        }
    }
}

/// What extensions can change. `engine` is Nisse's own behaviour: the end of every chain.
pub trait Hooks: Send + Sync {
    fn prompt_submit(&self, text: String) -> Result<String, String> {
        Ok(text)
    }

    fn tool_call(
        &self,
        call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        engine(call)
    }
}

pub struct NoHooks;

impl Hooks for NoHooks {}

/// A tool as a model sees it: `parameters` is a JSON Schema for its arguments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

pub fn builtin_tools() -> Vec<ToolSpec> {
    vec![ToolSpec {
        name: "bash".into(),
        description: "Runs a shell command with `sh -c` and returns its output.".into(),
        parameters: json!({
            "type": "object",
            "properties": { "command": { "type": "string" } },
            "required": ["command"],
        }),
    }]
}

pub fn approval_for(_name: &str) -> Approval {
    Approval::Ask
}

pub fn run_builtin_tool(call: ToolCall) -> ToolOutcome {
    match call.name.as_str() {
        "bash" => {
            let Some(command) = call.args["command"].as_str() else {
                return ToolOutcome::error("bash needs a `command` string");
            };
            match Command::new("sh").arg("-c").arg(command).output() {
                Ok(ran) => {
                    let mut output = String::from_utf8_lossy(&ran.stdout).into_owned();
                    output.push_str(&String::from_utf8_lossy(&ran.stderr));
                    if output.len() > OUTPUT_LIMIT {
                        let cut = output.floor_char_boundary(output.len() - OUTPUT_LIMIT);
                        output = format!("[{cut} bytes cut]\n{}", &output[cut..]);
                    }
                    ToolOutcome {
                        output,
                        is_error: !ran.status.success(),
                        denied: None,
                    }
                }
                Err(error) => ToolOutcome::error(format!("could not run sh: {error}")),
            }
        }
        other => ToolOutcome::error(format!("no tool named {other}")),
    }
}
