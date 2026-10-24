//! OpenAI's models: what ChatGPT's `/codex/models` lists, as Codex asks for it, the copy of that
//! list Nisse saved last, or, before either, the list Codex bundles (`models.json` of
//! rust-v0.164.0, trimmed to what Nisse reads). A model a list doesn't hold gets direct tools.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result};
use nisse_protocol::ModelInfo;
use serde::{Deserialize, Serialize};

/// The Codex release whose models Nisse asks for, the one its code-mode host comes from.
pub(crate) const CLIENT_VERSION: &str = "0.164.0";
const BUNDLED: &str = include_str!("models.json");
const CODE_MODE_ONLY: &str = "code_mode_only";

#[derive(Clone, Serialize, Deserialize)]
struct Models {
    models: Vec<Model>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Model {
    slug: String,
    display_name: Option<String>,
    description: Option<String>,
    /// `list` for the ones a picker offers.
    visibility: Option<String>,
    #[serde(default)]
    priority: i64,
    tool_mode: Option<String>,
    context_window: Option<u64>,
    default_reasoning_level: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<ReasoningLevel>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ReasoningLevel {
    effort: String,
}

/// The newest list Nisse has, kept in memory once read and saved whenever ChatGPT sends one.
pub(crate) struct Catalog {
    saved: PathBuf,
    known: Mutex<Option<Models>>,
}

impl Catalog {
    pub(crate) fn new(saved: PathBuf) -> Self {
        Self {
            saved,
            known: Mutex::new(None),
        }
    }

    /// Takes the list ChatGPT just sent, and saves it for the next start.
    pub(crate) fn fetched(&self, body: &[u8]) -> Result<()> {
        let models: Models =
            serde_json::from_slice(body).context("ChatGPT sent a model list Nisse can't read")?;
        save(&self.saved, &models)?;
        *self.known.lock().expect("catalog lock") = Some(models);
        Ok(())
    }

    /// The models a picker offers, best first.
    pub(crate) fn listed(&self) -> Vec<ModelInfo> {
        let mut models: Vec<Model> = self
            .known()
            .models
            .into_iter()
            .filter(|model| {
                model
                    .visibility
                    .as_deref()
                    .is_none_or(|shown| shown == "list")
            })
            .collect();
        models.sort_by_key(|model| model.priority);
        models.into_iter().map(Model::info).collect()
    }

    pub(crate) fn wants_code_mode(&self, model: &str) -> bool {
        self.known()
            .models
            .iter()
            .any(|known| known.slug == model && known.tool_mode.as_deref() == Some(CODE_MODE_ONLY))
    }

    fn known(&self) -> Models {
        let mut known = self.known.lock().expect("catalog lock");
        known
            .get_or_insert_with(|| {
                std::fs::read(&self.saved)
                    .ok()
                    .and_then(|saved| serde_json::from_slice(&saved).ok())
                    .unwrap_or_else(|| {
                        serde_json::from_str(BUNDLED).expect("the bundled model list parses")
                    })
            })
            .clone()
    }
}

impl Model {
    fn info(self) -> ModelInfo {
        ModelInfo {
            name: self.display_name.unwrap_or_else(|| self.slug.clone()),
            code_mode: self.tool_mode.as_deref() == Some(CODE_MODE_ONLY),
            id: self.slug,
            description: self.description,
            efforts: self
                .supported_reasoning_levels
                .into_iter()
                .map(|level| level.effort)
                .collect(),
            default_effort: self.default_reasoning_level,
            context_window: self.context_window,
        }
    }
}

fn save(path: &Path, models: &Models) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let partial = path.with_extension("partial");
    std::fs::write(&partial, serde_json::to_vec(models)?)?;
    std::fs::rename(&partial, path)
        .with_context(|| format!("could not save the model list to {}", path.display()))
}
