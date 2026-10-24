use std::{path::Path, time::Duration};

use nisse_core::new_id;
use nisse_protocol::{ModelInfo, ProviderHealth, ProviderStatus};
use serde_json::{Value, json};

use crate::process::Process;

/// Bedrock and other backends take a while to report the account.
const PATIENCE: Duration = Duration::from_secs(25);

/// What Claude Code says of itself before it is asked anything.
#[derive(Clone)]
pub(crate) struct Probed {
    pub(crate) health: ProviderHealth,
    pub(crate) models: Vec<ModelInfo>,
}

impl From<ProviderHealth> for Probed {
    fn from(health: ProviderHealth) -> Self {
        Self {
            health,
            models: Vec::new(),
        }
    }
}

/// Starts claude without a prompt, outside any project and with hooks and MCP servers off, and
/// reads how it is signed in, and which models it offers, from its answer to `initialize`.
/// Nothing reaches Claude's API.
pub(crate) async fn probe(binary: &Path, env: &[(String, String)]) -> Probed {
    let args = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--setting-sources",
        "user",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--no-session-persistence",
    ]
    .map(str::to_owned);
    let mut env = env.to_vec();
    env.push(("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "false".into()));
    let unavailable = ProviderHealth::new(ProviderStatus::Unavailable);
    let mut process = match Process::spawn(binary, &std::env::temp_dir(), &args, &env, None) {
        Ok(process) => process,
        Err(error) => {
            return unavailable
                .with_message(format!("{error:#}; install Claude Code or set its binary"))
                .into();
        }
    };
    let request_id = new_id();
    process.send(json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "initialize" },
    }));
    let answer = tokio::time::timeout(PATIENCE, async {
        while let Some(frame) = process.inbound.recv().await {
            if frame["type"] == "control_response"
                && frame["response"]["request_id"] == request_id.as_str()
            {
                return Some(frame["response"].clone());
            }
        }
        None
    })
    .await;
    let health = match answer {
        Ok(Some(response)) if response["subtype"] == "success" => {
            let initialized = &response["response"];
            return Probed {
                health: health(initialized, custom_endpoint(&env)),
                models: models(initialized),
            };
        }
        Ok(Some(response)) => unavailable.with_message(format!(
            "claude could not start: {}",
            response["error"].as_str().unwrap_or("it did not say why")
        )),
        Ok(None) => unavailable.with_message(process.exit_reason().await),
        Err(_) => unavailable.with_message(format!(
            "claude did not answer within {} seconds",
            PATIENCE.as_secs()
        )),
    };
    health.into()
}

/// The models Claude Code offers, by the aliases its `--model` takes. Its `default` entry is
/// what a selection without a model gets, so it is not listed as a model of its own.
fn models(initialized: &Value) -> Vec<ModelInfo> {
    initialized["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model["value"].as_str().filter(|id| *id != "default")?;
            let efforts = match model["supportsEffort"].as_bool() {
                Some(true) => model["supportedEffortLevels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| effort.as_str().map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            Some(ModelInfo {
                id: id.to_owned(),
                name: model["displayName"].as_str().unwrap_or(id).to_owned(),
                description: model["description"].as_str().map(str::to_owned),
                efforts,
                default_effort: None,
                context_window: None,
                code_mode: false,
            })
        })
        .collect()
}

/// Claude Code reports `tokenSource: "none"` when it found no credentials at all; any other
/// account, an API key, or a backend other than Anthropic's own, can answer.
fn health(initialized: &Value, custom_endpoint: bool) -> ProviderHealth {
    let account = &initialized["account"];
    let text = |field: &str| account[field].as_str().filter(|value| !value.is_empty());
    let backend = text("apiProvider").filter(|backend| *backend != "firstParty");
    let api_key = text("apiKeySource").filter(|source| *source != "none");
    let signed_in = custom_endpoint
        || backend.is_some()
        || text("tokenSource") != Some("none")
        || api_key.is_some()
        || text("email").is_some()
        || text("subscriptionType").is_some();
    let version = initialized["claude_code_version"]
        .as_str()
        .map(str::to_owned);
    if !signed_in {
        return ProviderHealth {
            version,
            ..ProviderHealth::new(ProviderStatus::SignedOut)
                .with_message("not signed in to Claude Code")
        };
    }
    let plan = match (api_key, backend, text("subscriptionType")) {
        (Some(source), _, _) => Some(format!("API key from {source}")),
        (_, Some(backend), _) => Some(backend.to_owned()),
        (_, _, Some(subscription)) => Some(subscription_label(subscription)),
        _ if custom_endpoint => Some("a custom API endpoint".to_owned()),
        _ => None,
    };
    let parts: Vec<String> = text("email")
        .map(str::to_owned)
        .into_iter()
        .chain(plan)
        .collect();
    ProviderHealth {
        version,
        account: (!parts.is_empty()).then(|| parts.join(" · ")),
        ..ProviderHealth::new(ProviderStatus::Ready)
    }
}

fn subscription_label(subscription: &str) -> String {
    match subscription.to_lowercase().as_str() {
        "max" => "Claude Max".into(),
        "pro" => "Claude Pro".into(),
        "team" => "Claude Team".into(),
        "enterprise" => "Claude Enterprise".into(),
        _ => subscription.to_owned(),
    }
}

/// Account fields can't vouch for credentials sent to another API endpoint.
fn custom_endpoint(env: &[(String, String)]) -> bool {
    let configured = env
        .iter()
        .rev()
        .find(|(name, _)| name == "ANTHROPIC_BASE_URL")
        .map(|(_, url)| url.clone())
        .or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok());
    configured.is_some_and(|url| {
        let host = url
            .trim()
            .split_once("://")
            .map(|(_, rest)| rest.split(['/', ':']).next().unwrap_or_default())
            .unwrap_or_default();
        !host.is_empty() && host != "api.anthropic.com"
    })
}
