//! The providers a conversation can name: `claude`, `openai` and `echo`, and the ones
//! `NISSE_HOME/config.toml` names, which can also replace those; and the model new
//! conversations get, from a project's `.nisse/config.toml` or else that file.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use nisse_claude::{Claude, ClaudeOptions};
use nisse_core::{DefaultModel, Echo, Provider};
use nisse_openai::{HOST_PROGRAM, OpenAi, OpenAiOptions};
use nisse_protocol::ModelSelection;
use serde::{Deserialize, de::DeserializeOwned};

use crate::ServerConfig;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    providers: BTreeMap<String, InstanceConfig>,
    default_model: Option<SelectionConfig>,
}

/// What a project's `.nisse/config.toml` may set: nothing secret.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectConfig {
    default_model: Option<SelectionConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectionConfig {
    provider: String,
    model: Option<String>,
    effort: Option<String>,
}

impl From<SelectionConfig> for ModelSelection {
    fn from(config: SelectionConfig) -> Self {
        Self {
            provider: config.provider,
            model: config.model,
            effort: config.effort,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstanceConfig {
    driver: Driver,
    /// Claude: the `claude` binary.
    binary: Option<PathBuf>,
    /// Claude: Claude Code's config directory, which holds the account.
    config_dir: Option<PathBuf>,
    /// Claude: set for every claude the instance starts.
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Claude: added to every claude's command line.
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Driver {
    Claude,
    Openai,
    Echo,
}

impl Driver {
    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Openai => "openai",
            Self::Echo => "echo",
        }
    }
}

pub(crate) struct Configured {
    /// Every provider, the default first.
    pub(crate) providers: Vec<(String, Arc<dyn Provider>)>,
    pub(crate) default_model: DefaultModel,
}

pub(crate) fn configured(server: &ServerConfig) -> Result<Configured> {
    let path = server.home.join("config.toml");
    let config: Config = read(&path)?;
    let user_default = config.default_model.map(ModelSelection::from);
    let default_model: DefaultModel = Arc::new(move |cwd: &Path| {
        let project: ProjectConfig = read(&cwd.join(".nisse/config.toml"))?;
        Ok(project
            .default_model
            .map(ModelSelection::from)
            .or_else(|| user_default.clone()))
    });
    Ok(Configured {
        providers: named(config.providers, server, &path)?,
        default_model,
    })
}

/// The file's settings, or none when there is no file.
fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).with_context(|| format!("reading {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

fn named(
    mut configured: BTreeMap<String, InstanceConfig>,
    server: &ServerConfig,
    path: &Path,
) -> Result<Vec<(String, Arc<dyn Provider>)>> {
    let built_in = [Driver::Claude, Driver::Openai, Driver::Echo].map(|driver| {
        let id = driver.name().to_owned();
        let config = configured
            .remove(&id)
            .unwrap_or_else(|| InstanceConfig::of(driver));
        (id, config)
    });
    built_in
        .into_iter()
        .chain(configured)
        .map(|(id, config)| {
            let provider = config
                .provider(&id, server)
                .with_context(|| format!("provider {id} in {}", path.display()))?;
            Ok((id, provider))
        })
        .collect()
}

impl InstanceConfig {
    fn of(driver: Driver) -> Self {
        Self {
            driver,
            binary: None,
            config_dir: None,
            env: BTreeMap::new(),
            args: Vec::new(),
        }
    }

    fn provider(self, id: &str, server: &ServerConfig) -> Result<Arc<dyn Provider>> {
        if !id
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_')
        {
            bail!("a provider's name holds only letters, digits, `-` and `_`");
        }
        let claude_only = self.binary.is_some()
            || self.config_dir.is_some()
            || !self.env.is_empty()
            || !self.args.is_empty();
        if claude_only && self.driver != Driver::Claude {
            bail!("only claude providers take binary, config_dir, env or args");
        }
        Ok(match self.driver {
            Driver::Claude => {
                let binary = self.binary.map_or_else(|| server.claude.clone(), expanded);
                let mut options = ClaudeOptions::new(binary);
                options.record.clone_from(&server.record);
                options.config_dir = self.config_dir.map(expanded);
                options.env = self.env;
                options.args = self.args;
                Arc::new(Claude::new(options))
            }
            Driver::Openai => {
                let auth_path = server.home.join("auth").join(format!("{id}.json"));
                let mut options =
                    OpenAiOptions::new(auth_path, include_str!("instructions.md"), &server.home);
                options.model_list = server.home.join("cache").join(format!("{id}-models.json"));
                options.record.clone_from(&server.record);
                let installed = server.home.join("bin").join(HOST_PROGRAM);
                options.code_mode_host = match &server.code_mode_host {
                    Some(host) => host.clone(),
                    None if installed.is_file() => installed,
                    None => HOST_PROGRAM.into(),
                };
                options.nested_tools = server.nested_tools;
                Arc::new(OpenAi::new(options)?)
            }
            Driver::Echo => {
                let think = std::env::var("NISSE_ECHO_THINK_MS")
                    .ok()
                    .and_then(|ms| ms.parse().ok())
                    .unwrap_or(600);
                Arc::new(Echo {
                    think: Duration::from_millis(think),
                })
            }
        })
    }
}

fn expanded(path: PathBuf) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path,
    }
}
