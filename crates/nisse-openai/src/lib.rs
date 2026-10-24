//! OpenAI's Responses API through a ChatGPT sign-in, as a Nisse provider. Nisse runs the agent
//! loop, so every tool call is committed, hooked and approved by Nisse.

mod auth;
mod provider;
mod record;
mod sse;

use std::time::Duration;

pub use auth::{AUTH_BASE, AuthServer, CALLBACK_PORT, LoginMethod, LoginPrompt, login, login_with};
pub use provider::{BASE_URL, MODEL, OpenAi, OpenAiOptions};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const STALLED_STREAM: Duration = Duration::from_secs(300);

fn http_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("nisse/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(STALLED_STREAM)
        .build()?)
}
