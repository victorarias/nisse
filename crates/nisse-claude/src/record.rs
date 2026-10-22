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
/// Values tied to this machine or account are replaced by placeholders the replay binds again.
pub(crate) struct Recorder {
    file: Mutex<File>,
    placeholders: Vec<(String, String)>,
    nisse_requests: Vec<String>,
}

impl Recorder {
    pub(crate) fn open(
        dir: &Path,
        conversation_id: &str,
        session: &str,
        cwd: &Path,
        nisse_requests: &[String],
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

        let mut placeholders: Vec<(String, String)> = nisse_requests
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), format!("<request:{}>", index + 1)))
            .collect();
        placeholders.push((session.to_owned(), "<session>".into()));
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
            nisse_requests: nisse_requests.to_vec(),
        })
    }

    pub(crate) fn outbound(&self, frame: &Value) {
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
            && frame["response"]["request_id"]
                .as_str()
                .is_some_and(|id| self.nisse_requests.iter().any(|ours| ours == id));
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
        for (real, placeholder) in &self.placeholders {
            if text.contains(real.as_str()) {
                text = text.replace(real.as_str(), placeholder);
            }
        }
        text
    }
}
