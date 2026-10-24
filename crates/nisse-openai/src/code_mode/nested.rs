//! The tools a script calls on its global `tools` object, as the model sees them, and how each
//! call becomes a Nisse tool call.

use std::path::Path;

use nisse_core::{ToolCall, ToolOutcome, builtin_tools, run_builtin_tool};
use serde_json::{Value, json};

use super::apply_patch::apply_patch;

/// Which names and shapes the model sees for nested tools.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum NestedTools {
    /// Nisse's built-in tools as they are, named and shaped like Claude Code's, so a hook on
    /// `Bash` covers direct and nested calls, on both providers.
    #[default]
    ClaudeCode,
    /// Codex's `exec_command` and `apply_patch`, which Codex's models are trained on. An
    /// `exec_command` is committed as a `Bash` call.
    Codex,
}

impl std::str::FromStr for NestedTools {
    type Err = String;

    fn from_str(name: &str) -> Result<Self, String> {
        match name {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            other => Err(format!("{other} is neither claude-code nor codex")),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Function,
    Freeform,
}

pub(super) struct Nested {
    pub name: String,
    description: String,
    kind: Kind,
    input: Option<Value>,
}

const OUTCOME: &str = "{ denied?: string; is_error: boolean; output: string; }";

impl NestedTools {
    pub(super) fn tools(self) -> Vec<Nested> {
        match self {
            Self::ClaudeCode => builtin_tools()
                .into_iter()
                .map(|tool| Nested {
                    name: tool.name,
                    description: tool.description,
                    kind: Kind::Function,
                    input: Some(tool.parameters),
                })
                .collect(),
            Self::Codex => vec![
                Nested {
                    name: "exec_command".into(),
                    description: "Runs a command with `sh -c`, returning its output once it exits."
                        .into(),
                    kind: Kind::Function,
                    input: Some(json!({
                        "type": "object",
                        "properties": {
                            "cmd": { "type": "string", "description": "Shell command to execute." },
                            "workdir": { "type": "string", "description": "Working directory for the command. Defaults to the turn cwd." }
                        },
                        "required": ["cmd"],
                        "additionalProperties": false
                    })),
                },
                Nested {
                    name: "apply_patch".into(),
                    description: "The `apply_patch` tool can be used to edit files. This is a \
                                  FREEFORM tool, so do not wrap the patch in JSON."
                        .into(),
                    kind: Kind::Freeform,
                    input: None,
                },
            ],
        }
    }

    /// The Nisse call a script's `tools.<tool>(input)` makes, as `(name, args)`.
    pub(super) fn call(self, tool: &str, input: Value) -> Result<(String, Value), String> {
        let known = self.tools().into_iter().find(|nested| nested.name == tool);
        let Some(nested) = known else {
            return Err(format!("no tool named {tool}"));
        };
        let input = match (nested.kind, input) {
            (Kind::Function, Value::Null) => json!({}),
            (Kind::Function, object @ Value::Object(_)) => object,
            (Kind::Freeform, text @ Value::String(_)) => text,
            (Kind::Function, _) => return Err(format!("{tool} takes an object")),
            (Kind::Freeform, _) => return Err(format!("{tool} takes a string")),
        };
        match (self, tool) {
            (Self::Codex, "exec_command") => {
                let cmd = input["cmd"].as_str().ok_or("exec_command needs `cmd`")?;
                let command = match input["workdir"].as_str() {
                    Some(dir) => format!("cd '{}' && {cmd}", dir.replace('\'', r"'\''")),
                    None => cmd.to_owned(),
                };
                Ok(("Bash".into(), json!({ "command": command })))
            }
            _ => Ok((tool.to_owned(), input)),
        }
    }
}

pub(super) fn run_nested_tool(cwd: &Path) -> impl FnOnce(ToolCall) -> ToolOutcome + Send + 'static {
    let cwd = cwd.to_owned();
    move |call| match (call.name.as_str(), &call.args) {
        ("apply_patch", Value::String(patch)) => apply_patch(&cwd, patch),
        _ => run_builtin_tool(&cwd)(call),
    }
}

impl Nested {
    /// The tool as the host lists it in `ALL_TOOLS`, its description ending in its declaration.
    pub fn definition(&self) -> Value {
        json!({
            "name": self.name,
            "tool_name": { "name": self.name, "namespace": null },
            "description": self.sample(),
            "kind": match self.kind {
                Kind::Function => "function",
                Kind::Freeform => "freeform",
            },
            "input_schema": null,
            "output_schema": null,
        })
    }

    /// The tool's section in `exec`'s description.
    pub fn section(&self) -> String {
        let global = identifier(&self.name);
        let heading = if global == self.name {
            format!("### `{global}`")
        } else {
            format!("### `{global}` (`{}`)", self.name)
        };
        format!("{heading}\n{}", self.sample())
    }

    fn sample(&self) -> String {
        let (input_name, input_type, output_type) = match self.kind {
            Kind::Function => (
                "args",
                self.input
                    .as_ref()
                    .map_or_else(|| "unknown".into(), typescript),
                OUTCOME,
            ),
            Kind::Freeform => ("input", "string".into(), OUTCOME),
        };
        format!(
            "{}\n\nexec tool declaration:\n```ts\ndeclare const tools: {{ {}({input_name}: {input_type}): Promise<{output_type}>; }};\n```",
            self.description,
            identifier(&self.name)
        )
    }
}

/// `name` as a JavaScript identifier, as the host exposes it on `tools`.
fn identifier(name: &str) -> String {
    let identifier: String = name
        .chars()
        .enumerate()
        .map(|(index, ch)| {
            let valid = ch == '_' || ch == '$' || ch.is_ascii_alphabetic();
            if valid || (index > 0 && ch.is_ascii_digit()) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if identifier.is_empty() {
        "_".into()
    } else {
        identifier
    }
}

/// A JSON Schema as a TypeScript type, the way Codex declares nested tools.
fn typescript(schema: &Value) -> String {
    if let Some(values) = schema["enum"].as_array() {
        return values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join(" | ");
    }
    match schema["type"].as_str() {
        Some("string") => "string".into(),
        Some("number" | "integer") => "number".into(),
        Some("boolean") => "boolean".into(),
        Some("null") => "null".into(),
        Some("array") => match schema.get("items") {
            Some(items) => format!("Array<{}>", typescript(items)),
            None => "unknown[]".into(),
        },
        Some("object") => object(schema),
        _ => "unknown".into(),
    }
}

fn object(schema: &Value) -> String {
    let required: Vec<&str> = schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut properties: Vec<(&String, &Value)> = schema["properties"]
        .as_object()
        .into_iter()
        .flatten()
        .collect();
    properties.sort_by_key(|(name, _)| *name);
    let property = |name: &str, value: &Value| {
        let optional = if required.contains(&name) { "" } else { "?" };
        format!("{name}{optional}: {};", typescript(value))
    };
    let described = properties
        .iter()
        .any(|(_, value)| value["description"].is_string());
    if !described {
        let fields: Vec<String> = properties
            .iter()
            .map(|(name, value)| property(name, value))
            .collect();
        return match fields.is_empty() {
            true => "{}".into(),
            false => format!("{{ {} }}", fields.join(" ")),
        };
    }
    let mut lines = vec!["{".to_owned()];
    for (name, value) in properties {
        let description = value["description"].as_str().unwrap_or_default();
        for line in description
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            lines.push(format!("  // {line}"));
        }
        lines.push(format!("  {}", property(name, value)));
    }
    lines.push("}".into());
    lines.join("\n")
}
