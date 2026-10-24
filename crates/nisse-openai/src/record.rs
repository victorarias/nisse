use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::Path,
};

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

const ANY: &str = "<any>";

/// Writes one turn as a replayable fixture: each request Nisse sent, then what came back.
/// Values that change from run to run, and paths on this machine, are replaced by placeholders.
pub(crate) struct Recorder {
    file: Option<File>,
    places: Vec<(String, &'static str)>,
    ids: HashMap<String, String>,
}

impl Recorder {
    pub fn start(dir: Option<&Path>, model: &str, cwd: &Path) -> Result<Self> {
        let Some(dir) = dir else {
            return Ok(Self {
                file: None,
                places: Vec::new(),
                ids: HashMap::new(),
            });
        };
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("openai-{}.ndjson", nisse_core::new_id()));
        let file = File::create(&path)
            .with_context(|| format!("could not record to {}", path.display()))?;
        let mut workspaces = vec![cwd.to_path_buf()];
        workspaces.extend(cwd.canonicalize());
        workspaces.sort_by_key(|path| std::cmp::Reverse(path.as_os_str().len()));
        let places = workspaces
            .into_iter()
            .map(|path| (Some(path.into_os_string()), "<workspace>"))
            .chain([(std::env::var_os("HOME"), "<home>")])
            .filter_map(|(place, placeholder)| {
                let place = place?.to_string_lossy().into_owned();
                (place.len() > 1).then_some((place, placeholder))
            })
            .collect();
        let mut recorder = Self {
            file: Some(file),
            places,
            ids: HashMap::new(),
        };
        recorder.write(json!({
            "type": "transcript_start",
            "provider": "openai",
            "scenario": "recorded",
            "metadata": { "model": model },
        }))?;
        Ok(recorder)
    }

    pub fn outbound(&mut self, body: &Value) -> Result<()> {
        if self.file.is_none() {
            return Ok(());
        }
        let mut frame = body.clone();
        for volatile in ["instructions", "prompt_cache_key"] {
            if frame.get(volatile).is_some() {
                frame[volatile] = ANY.into();
            }
        }
        self.write(json!({ "type": "expect_outbound", "frame": frame }))
    }

    pub fn inbound(&mut self, event: &Value) -> Result<()> {
        if self.file.is_none() {
            return Ok(());
        }
        let mut frame = event.clone();
        if let Some(response) = frame
            .get("response")
            .filter(|response| response.is_object())
        {
            let mut kept = json!({});
            for field in ["id", "status", "error", "incomplete_details", "usage"] {
                if let Some(value) = response.get(field).filter(|value| !value.is_null()) {
                    kept[field] = value.clone();
                }
            }
            frame["response"] = kept;
        }
        let frame = self.without_ids(frame);
        self.write(json!({ "type": "emit_inbound", "frame": frame }))
    }

    /// Replaces every response and item id, wherever it appears, keys included, by a numbered
    /// placeholder, so ids that were the same stay the same and ids that differed stay apart.
    fn without_ids(&mut self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.placeholder(text)),
            Value::Array(items) => items
                .into_iter()
                .map(|item| self.without_ids(item))
                .collect(),
            Value::Object(fields) => Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (self.placeholder(key), self.without_ids(value)))
                    .collect::<Map<_, _>>(),
            ),
            other => other,
        }
    }

    fn placeholder(&mut self, text: String) -> String {
        let Some(kind) = openai_id_kind(&text) else {
            return text;
        };
        let kind = kind.to_owned();
        let numbered = self
            .ids
            .values()
            .filter(|placeholder| placeholder.starts_with(&format!("<{kind}:")))
            .count();
        self.ids
            .entry(text)
            .or_insert_with(|| format!("<{kind}:{}>", numbered + 1))
            .clone()
    }

    fn write(&mut self, line: Value) -> Result<()> {
        let Some(file) = &mut self.file else {
            return Ok(());
        };
        let mut text = line.to_string();
        for (place, placeholder) in &self.places {
            text = text.replace(place.as_str(), placeholder);
        }
        writeln!(file, "{text}").context("could not write the recording")
    }
}

fn openai_id_kind(text: &str) -> Option<&str> {
    let (kind, hex) = text.split_once('_')?;
    let is_kind = !kind.is_empty() && kind.bytes().all(|byte| byte.is_ascii_lowercase());
    let is_hex = hex.len() >= 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    (is_kind && is_hex).then_some(kind)
}
