use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

const SYSTEM_INIT_FIELDS: &[&str] = &[
    "type",
    "subtype",
    "cwd",
    "session_id",
    "model",
    "permissionMode",
    "apiKeySource",
    "claude_code_version",
    "uuid",
];

/// Writes a replay fixture of one conversation's claude traffic: what Nisse wrote, as
/// `expect_outbound`, and what claude printed, as `emit_inbound`, in the order they happened.
/// Values tied to this machine or account are replaced by placeholders the replay binds again,
/// and so are the ids Nisse chose for this process: its requests' ids and its messages' uuids
/// become `<nisse:N>`, numbered in the order Nisse wrote them.
pub(crate) struct Recorder {
    file: Mutex<File>,
    placeholders: Vec<(String, String)>,
    chosen: Mutex<Vec<String>>,
}

impl Recorder {
    pub(crate) fn open(
        dir: &Path,
        conversation_id: &str,
        session: &str,
        cwd: &Path,
    ) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{conversation_id}.ndjson"));
        let is_new = !path.exists();
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("could not record to {}", path.display()))?;
        if is_new {
            writeln!(
                file,
                "{}",
                json!({
                    "type": "transcript_start",
                    "provider": "claude",
                    "scenario": conversation_id,
                    "metadata": {},
                })
            )?;
        }

        let mut placeholders = vec![(session.to_owned(), "<session>".to_owned())];
        let mut workspaces = vec![cwd.to_string_lossy().into_owned()];
        if let Ok(canonical) = cwd.canonicalize() {
            workspaces.push(canonical.to_string_lossy().into_owned());
        }
        workspaces.sort_by_key(|path| std::cmp::Reverse(path.len()));
        placeholders.extend(
            workspaces
                .into_iter()
                .map(|path| (path, "<workspace>".into())),
        );
        if let Some(home) = std::env::var_os("HOME") {
            placeholders.push((home.to_string_lossy().into_owned(), "<home>".into()));
        }
        placeholders.retain(|(real, _)| real.len() > 1);

        Ok(Self {
            file: Mutex::new(file),
            placeholders,
            chosen: Mutex::default(),
        })
    }

    pub(crate) fn outbound(&self, frame: &Value) {
        let chosen = match frame["type"].as_str() {
            Some("control_request") => frame["request_id"].as_str(),
            Some("user") => frame["uuid"].as_str(),
            _ => None,
        };
        if let Some(id) = chosen {
            self.chosen.lock().expect("chosen lock").push(id.to_owned());
        }
        self.write("expect_outbound", self.normalized(frame.clone()));
    }

    pub(crate) fn inbound(&self, frame: &Value) {
        let pruned = self.pruned(frame.clone());
        self.write("emit_inbound", self.normalized(pruned));
    }

    fn write(&self, kind: &str, frame: Value) {
        let line = json!({ "type": kind, "frame": frame });
        let mut file = self.file.lock().expect("record lock");
        let _ = writeln!(file, "{line}");
    }

    /// Drops what Nisse never reads and what describes the account: the command, model and
    /// account listings of the initialize reply, and the tool and plugin listings of `init`.
    fn pruned(&self, mut frame: Value) -> Value {
        let answers_nisse = frame["type"] == "control_response"
            && frame["response"]["request_id"].as_str().is_some_and(|id| {
                self.chosen
                    .lock()
                    .expect("chosen lock")
                    .iter()
                    .any(|ours| ours == id)
            });
        if answers_nisse && let Some(response) = frame["response"].get_mut("response") {
            let version = response.get("claude_code_version").cloned();
            *response = match version {
                Some(version) => json!({ "claude_code_version": version }),
                None => json!({}),
            };
        }
        if frame["type"] == "system"
            && frame["subtype"] == "init"
            && let Some(fields) = frame.as_object_mut()
        {
            fields.retain(|key, _| SYSTEM_INIT_FIELDS.contains(&key.as_str()));
        }
        frame
    }

    fn normalized(&self, frame: Value) -> Value {
        match frame {
            Value::String(text) => Value::String(self.placeheld(text)),
            Value::Array(items) => Value::Array(
                items
                    .into_iter()
                    .map(|item| self.normalized(item))
                    .collect(),
            ),
            Value::Object(fields) => Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (key, self.normalized(value)))
                    .collect::<Map<_, _>>(),
            ),
            other => other,
        }
    }

    fn placeheld(&self, mut text: String) -> String {
        let chosen = self.chosen.lock().expect("chosen lock");
        let chosen = chosen
            .iter()
            .enumerate()
            .map(|(index, id)| (id.as_str(), format!("<nisse:{}>", index + 1)));
        let fixed = self
            .placeholders
            .iter()
            .map(|(real, placeholder)| (real.as_str(), placeholder.clone()));
        for (real, placeholder) in chosen.chain(fixed) {
            if text.contains(real) {
                text = text.replace(real, &placeholder);
            }
        }
        text
    }
}
