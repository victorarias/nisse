use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};

const ANY: &str = "<any>";

/// Writes one turn as a replayable fixture: each request Nisse sent, then what came back.
/// Values that change from run to run, and paths on this machine, are replaced by placeholders.
pub(crate) struct Recorder {
    file: Option<File>,
    places: Vec<(String, &'static str)>,
}

impl Recorder {
    pub fn start(dir: Option<&Path>, model: &str) -> Result<Self> {
        let Some(dir) = dir else {
            return Ok(Self {
                file: None,
                places: Vec::new(),
            });
        };
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("openai-{}.ndjson", nisse_core::new_id()));
        let file = File::create(&path)
            .with_context(|| format!("could not record to {}", path.display()))?;
        let workspace = std::env::current_dir().ok().map(|dir| dir.into_os_string());
        let home = std::env::var_os("HOME");
        let places = [(workspace, "<workspace>"), (home, "<home>")]
            .into_iter()
            .filter_map(|(place, placeholder)| {
                let place = place?.to_string_lossy().into_owned();
                (place.len() > 1).then_some((place, placeholder))
            })
            .collect();
        let mut recorder = Self {
            file: Some(file),
            places,
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
            let mut kept = json!({ "id": "<response>" });
            for field in ["status", "error", "incomplete_details", "usage"] {
                if let Some(value) = response.get(field).filter(|value| !value.is_null()) {
                    kept[field] = value.clone();
                }
            }
            frame["response"] = kept;
        }
        if frame["item"].get("id").is_some() {
            frame["item"]["id"] = "<item>".into();
        }
        if frame.get("item_id").is_some() {
            frame["item_id"] = "<item>".into();
        }
        self.write(json!({ "type": "emit_inbound", "frame": frame }))
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
