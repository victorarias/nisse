//! Luau extensions. Each extension is a folder with `init.luau`, which returns `function(on, options)`.
//! Every hook is `hook(nisse, e, next)`: return without `next` to answer for the chain, or call
//! `next(e)` to continue to later extensions and then Nisse's own behaviour.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use mlua::{Function, Lua, LuaOptions, LuaSerdeExt, StdLib, Table, VmState};
use nisse_core::{Hooks, ToolCall, ToolOutcome};
use nisse_protocol::UiChanged;
use serde_json::{Value, json};

const HOOK_BUDGET: Duration = Duration::from_millis(250);

pub type UiSink = Arc<dyn Fn(UiChanged) + Send + Sync>;

pub struct LuaHost {
    extensions: Vec<Extension>,
}

struct Extension {
    name: String,
    lua: Lua,
    hooks: Vec<Hook>,
    deadline: Arc<Mutex<Option<Instant>>>,
}

struct Hook {
    event: String,
    tool: Option<String>,
    function: Function,
}

impl LuaHost {
    pub fn empty() -> Self {
        Self {
            extensions: Vec::new(),
        }
    }

    /// Loads every extension folder found directly under `roots`, in name order.
    pub fn load(roots: &[PathBuf], ui: UiSink) -> Result<Self> {
        let mut folders: Vec<PathBuf> = roots
            .iter()
            .filter_map(|root| std::fs::read_dir(root).ok())
            .flatten()
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.join("init.luau").is_file())
            .collect();
        folders.sort();
        let extensions = folders
            .iter()
            .map(|folder| Extension::load(folder, ui.clone()))
            .collect::<Result<_>>()?;
        Ok(Self { extensions })
    }

    pub fn names(&self) -> Vec<String> {
        self.extensions
            .iter()
            .map(|extension| extension.name.clone())
            .collect()
    }

    fn dispatch(
        &self,
        event: &str,
        tool: Option<&str>,
        input: Value,
        engine: &dyn Fn(Value) -> Value,
    ) -> Value {
        let chain: Vec<(&Extension, &Hook)> = self
            .extensions
            .iter()
            .flat_map(|extension| extension.hooks.iter().map(move |hook| (extension, hook)))
            .filter(|(_, hook)| {
                hook.event == event && (hook.tool.is_none() || hook.tool.as_deref() == tool)
            })
            .collect();
        run_chain(&chain, input, engine)
    }
}

fn run_chain(
    chain: &[(&Extension, &Hook)],
    input: Value,
    engine: &dyn Fn(Value) -> Value,
) -> Value {
    let Some(((extension, hook), rest)) = chain.split_first() else {
        return engine(input);
    };
    let continued: Mutex<Option<Value>> = Mutex::new(None);
    *extension.deadline.lock().expect("deadline lock") = Some(Instant::now() + HOOK_BUDGET);
    let ran = extension.lua.scope(|scope| {
        let next = scope.create_function(|lua, e: mlua::Value| {
            let result = run_chain(rest, lua.from_value(e)?, engine);
            *continued.lock().expect("continued lock") = Some(result.clone());
            lua.to_value(&result)
        })?;
        let nisse: Table = extension.lua.globals().get("nisse")?;
        let returned: mlua::Value =
            hook.function
                .call((nisse, extension.lua.to_value(&input)?, next))?;
        extension.lua.from_value::<Value>(returned)
    });
    *extension.deadline.lock().expect("deadline lock") = None;
    match ran {
        Ok(Value::Null) => continued
            .into_inner()
            .expect("continued lock")
            .unwrap_or(Value::Null),
        Ok(result) => result,
        Err(error) => {
            eprintln!(
                "nisse: extension {}: {} hook failed: {error}",
                extension.name, hook.event
            );
            match continued.into_inner().expect("continued lock") {
                Some(result) => result,
                None if hook.event == "tool.call" => {
                    json!({ "deny": format!("{}: its guard failed", extension.name) })
                }
                None => run_chain(rest, input, engine),
            }
        }
    }
}

impl Extension {
    fn load(folder: &Path, ui: UiSink) -> Result<Self> {
        let name = folder
            .file_name()
            .and_then(|name| name.to_str())
            .context("extension folder needs a UTF-8 name")?
            .to_owned();
        let lua = Lua::new_with(
            StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE,
            LuaOptions::default(),
        )?;
        let deadline: Arc<Mutex<Option<Instant>>> = Arc::default();
        let budget = deadline.clone();
        lua.set_interrupt(move |_| match *budget.lock().expect("deadline lock") {
            Some(deadline) if Instant::now() > deadline => {
                Err(mlua::Error::runtime("hook ran past its time budget"))
            }
            _ => Ok(VmState::Continue),
        });
        lua.globals().set("nisse", nisse_table(&lua, &name, ui)?)?;
        lua.sandbox(true)?;

        let source = std::fs::read_to_string(folder.join("init.luau"))?;
        let register: Function = lua
            .load(source)
            .set_name(format!("@{name}/init.luau"))
            .eval()
            .with_context(|| format!("loading extension {name}"))?;
        let registered: Arc<Mutex<Vec<Hook>>> = Arc::default();
        let collect = registered.clone();
        let on = lua.create_function(
            move |_, (event, second, third): (String, mlua::Value, Option<Function>)| {
                let (matcher, function) = match (second, third) {
                    (mlua::Value::Function(function), None) => (None, function),
                    (mlua::Value::Table(matcher), Some(function)) => (Some(matcher), function),
                    _ => return Err(mlua::Error::runtime("on(event, [matcher], hook)")),
                };
                let tool = matcher
                    .map(|matcher| matcher.get::<Option<String>>("tool"))
                    .transpose()?
                    .flatten();
                collect.lock().expect("hooks lock").push(Hook {
                    event,
                    tool,
                    function,
                });
                Ok(())
            },
        )?;
        register
            .call::<()>((on, lua.create_table()?))
            .with_context(|| format!("registering extension {name}"))?;
        let hooks = std::mem::take(&mut *registered.lock().expect("hooks lock"));
        if hooks.is_empty() {
            bail!("extension {name} registered no hooks");
        }
        Ok(Self {
            name,
            lua,
            hooks,
            deadline,
        })
    }
}

fn nisse_table(lua: &Lua, name: &str, ui: UiSink) -> Result<Table> {
    let nisse = lua.create_table()?;
    let surfaces = lua.create_table()?;
    let (extension, sink) = (name.to_owned(), ui.clone());
    surfaces.set(
        "status",
        lua.create_function(move |_, text: Option<String>| {
            sink(UiChanged::Status {
                extension: extension.clone(),
                text,
            });
            Ok(())
        })?,
    )?;
    let (extension, sink) = (name.to_owned(), ui);
    surfaces.set(
        "toast",
        lua.create_function(move |_, text: String| {
            sink(UiChanged::Toast {
                extension: extension.clone(),
                text,
            });
            Ok(())
        })?,
    )?;
    nisse.set("ui", surfaces)?;
    let extension = name.to_owned();
    nisse.set(
        "log",
        lua.create_function(move |_, text: String| {
            eprintln!("nisse: extension {extension}: {text}");
            Ok(())
        })?,
    )?;
    Ok(nisse)
}

impl Hooks for LuaHost {
    fn prompt_submit(&self, text: String) -> Result<String, String> {
        let result = self.dispatch("prompt.submit", None, json!({ "text": text }), &|e| e);
        if let Some(reason) = result["deny"].as_str() {
            return Err(reason.to_owned());
        }
        Ok(result["text"].as_str().map(str::to_owned).unwrap_or(text))
    }

    fn tool_call(
        &self,
        call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        let input = json!({ "tool": call.name, "id": call.id, "args": call.args });
        let result = self.dispatch("tool.call", Some(&call.name), input, &|e| {
            let call = ToolCall {
                id: e["id"].as_str().unwrap_or(&call.id).to_owned(),
                name: e["tool"].as_str().unwrap_or(&call.name).to_owned(),
                args: e["args"].clone(),
            };
            serde_json::to_value(engine(call)).unwrap_or_default()
        });
        if let Some(reason) = result["deny"].as_str() {
            return ToolOutcome::denied(reason);
        }
        serde_json::from_value(result).unwrap_or_else(|error| {
            ToolOutcome::error(format!("an extension returned a malformed result: {error}"))
        })
    }
}
