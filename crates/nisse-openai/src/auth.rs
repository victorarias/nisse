use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{StreamExt, stream::FuturesUnordered};
use nisse_core::SignIn;
use nisse_protocol::{AuthInteraction, AuthMethod, AuthResponse};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

pub const AUTH_BASE: &str = "https://auth.openai.com";
pub const CALLBACK_PORT: u16 = 1455;
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PATH: &str = "/auth/callback";
const SCOPE: &str = "openid profile email offline_access";
const ACCOUNT_CLAIM: &str = "https://api.openai.com/auth";
const PROFILE_CLAIM: &str = "https://api.openai.com/profile";
const DEVICE_CODE_LIFETIME: Duration = Duration::from_secs(15 * 60);
const SHORTEST_POLL: Duration = Duration::from_secs(1);
const LONGEST_CALLBACK_REQUEST: usize = 16 * 1024;
pub(crate) const ORIGINATOR: &str = "nisse";

/// Where signing in happens. The default is OpenAI's own; port 0 listens on any free port.
#[derive(Debug, Clone)]
pub struct AuthServer {
    pub base: String,
    pub callback_port: u16,
}

impl Default for AuthServer {
    fn default() -> Self {
        Self {
            base: AUTH_BASE.into(),
            callback_port: CALLBACK_PORT,
        }
    }
}

/// Signs in to ChatGPT by `method`, showing a person what to do through `flow`, and saves the
/// tokens to `auth_path`, readable only by this user.
pub(crate) async fn sign_in(
    http: &reqwest::Client,
    server: &AuthServer,
    auth_path: &Path,
    method: AuthMethod,
    flow: &mut SignIn,
) -> Result<()> {
    let tokens = match method {
        AuthMethod::Browser => browser_sign_in(http, server, flow).await?,
        AuthMethod::DeviceCode => device_code_sign_in(http, server, flow).await?,
        AuthMethod::Terminal => bail!("ChatGPT has no sign-in command to run"),
    };
    Credentials::from_tokens(tokens, None)?.save(auth_path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Credentials {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_ms: i64,
    pub account_id: String,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

impl Credentials {
    pub fn load(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path).map_err(|error| {
            anyhow!(
                "not signed in to ChatGPT: could not read {}: {error}",
                path.display()
            )
        })?;
        serde_json::from_str(&text).with_context(|| format!("{} is not valid", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let unfinished = path.with_extension("partial");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&unfinished)
            .with_context(|| format!("could not write {}", unfinished.display()))?;
        file.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
        file.sync_all()?;
        fs::rename(&unfinished, path)
            .with_context(|| format!("could not write {}", path.display()))?;
        Ok(())
    }

    /// The email and plan the sign-in belongs to, as far as its token says.
    pub fn account(&self) -> Option<String> {
        let claims = claims(&self.access_token).ok()?;
        let email = claims[PROFILE_CLAIM]["email"].as_str();
        let plan = claims[ACCOUNT_CLAIM]["chatgpt_plan_type"]
            .as_str()
            .map(|plan| format!("ChatGPT {}", capitalized(plan)));
        let parts: Vec<String> = email.map(str::to_owned).into_iter().chain(plan).collect();
        (!parts.is_empty()).then(|| parts.join(" · "))
    }

    pub fn is_expired(&self) -> bool {
        nisse_core::now_ms() >= self.expires_at_ms
    }

    pub async fn refreshed(&self, http: &reqwest::Client, auth_base: &str) -> Result<Self> {
        let response = http
            .post(format!("{auth_base}/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", self.refresh_token.as_str()),
                ("client_id", CLIENT_ID),
            ])
            .send()
            .await
            .context("could not refresh the ChatGPT sign-in")?;
        let tokens = read_tokens(response, "refresh")
            .await
            .context("the ChatGPT sign-in expired; sign in again")?;
        Self::from_tokens(tokens, Some(&self.refresh_token))
    }

    fn from_tokens(tokens: Tokens, previous_refresh_token: Option<&str>) -> Result<Self> {
        let refresh_token = tokens
            .refresh_token
            .or_else(|| previous_refresh_token.map(str::to_owned))
            .ok_or_else(|| anyhow!("the token response carried no refresh token"))?;
        Ok(Self {
            account_id: account_id(&tokens.access_token)?,
            access_token: tokens.access_token,
            refresh_token,
            expires_at_ms: nisse_core::now_ms() + tokens.expires_in * 1000,
        })
    }
}

fn claims(access_token: &str) -> Result<Value> {
    access_token
        .split('.')
        .nth(1)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
        .and_then(|payload| serde_json::from_slice::<Value>(&payload).ok())
        .ok_or_else(|| anyhow!("the access token is not a JWT"))
}

fn account_id(access_token: &str) -> Result<String> {
    claims(access_token)?[ACCOUNT_CLAIM]["chatgpt_account_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("the access token names no ChatGPT account"))
}

async fn read_tokens(response: reqwest::Response, operation: &str) -> Result<Tokens> {
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        bail!("token {operation} failed ({status}){}", reason(&text));
    }
    serde_json::from_str(&text)
        .map_err(|_| anyhow!("token {operation} answered without the expected fields"))
}

async fn exchange(
    http: &reqwest::Client,
    server: &AuthServer,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Tokens> {
    let response = http
        .post(format!("{}/oauth/token", server.base))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await?;
    read_tokens(response, "exchange").await
}

async fn browser_sign_in(
    http: &reqwest::Client,
    server: &AuthServer,
    flow: &mut SignIn,
) -> Result<Tokens> {
    let listener = TcpListener::bind(("127.0.0.1", server.callback_port))
        .await
        .with_context(|| {
            format!(
                "could not listen on 127.0.0.1:{} for the browser's answer (is another sign-in running?); a device code sign-in needs no port",
                server.callback_port
            )
        })?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://localhost:{port}{CALLBACK_PATH}");
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = URL_SAFE_NO_PAD.encode(random_bytes::<16>()?);
    let url = Url::parse_with_params(
        &format!("{}/oauth/authorize", server.base),
        [
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", ORIGINATOR),
        ],
    )?;
    flow.show(AuthInteraction::Browser { url: url.into() });

    let mut reading = FuturesUnordered::new();
    loop {
        let (mut stream, target) = tokio::select! {
            accepted = listener.accept() => {
                let (mut stream, _) = accepted?;
                reading.push(async move {
                    let target = request_target(&mut stream).await;
                    (stream, target)
                });
                continue;
            }
            Some(read) = reading.next(), if !reading.is_empty() => read,
            Some(AuthResponse::Callback { url }) = flow.response() => {
                match callback(&pasted_target(&url), &state) {
                    Callback::Ignored(..) => continue,
                    Callback::Refused(reason) => bail!("ChatGPT refused the sign-in: {reason}"),
                    Callback::Code(code) => {
                        return exchange(http, server, &code, &verifier, &redirect_uri).await;
                    }
                }
            }
        };
        let Ok(target) = target else {
            continue;
        };
        let code = match callback(&target, &state) {
            Callback::Ignored(status, message) => {
                reply(&mut stream, status, message).await;
                continue;
            }
            Callback::Refused(reason) => {
                reply(&mut stream, StatusCode::BAD_REQUEST, &reason).await;
                bail!("ChatGPT refused the sign-in: {reason}");
            }
            Callback::Code(code) => code,
        };
        return match exchange(http, server, &code, &verifier, &redirect_uri).await {
            Ok(tokens) => {
                reply(
                    &mut stream,
                    StatusCode::OK,
                    "Signed in to ChatGPT. You can close this tab.",
                )
                .await;
                Ok(tokens)
            }
            Err(error) => {
                reply(&mut stream, StatusCode::BAD_GATEWAY, "Signing in failed.").await;
                Err(error)
            }
        };
    }
}

/// The path and query of an address pasted from a browser on another machine.
fn pasted_target(url: &str) -> String {
    let Ok(url) = Url::parse(url.trim()) else {
        return String::new();
    };
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    }
}

enum Callback {
    Ignored(StatusCode, &'static str),
    Refused(String),
    Code(String),
}

fn callback(target: &str, state: &str) -> Callback {
    let Ok(url) = Url::parse(&format!("http://localhost{target}")) else {
        return Callback::Ignored(StatusCode::BAD_REQUEST, "Not a sign-in answer.");
    };
    if url.path() != CALLBACK_PATH {
        return Callback::Ignored(StatusCode::NOT_FOUND, "Not found.");
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("state").as_deref() != Some(state) {
        return Callback::Ignored(
            StatusCode::BAD_REQUEST,
            "This answer is for another sign-in.",
        );
    }
    if let Some(error) = param("error") {
        return Callback::Refused(param("error_description").unwrap_or(error));
    }
    match param("code") {
        Some(code) => Callback::Code(code),
        None => Callback::Ignored(StatusCode::BAD_REQUEST, "The answer carried no code."),
    }
}

async fn request_target(stream: &mut TcpStream) -> Result<String> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).await?;
        if read == 0 || head.len() > LONGEST_CALLBACK_REQUEST {
            bail!("an incomplete request");
        }
        head.extend_from_slice(&chunk[..read]);
    }
    let line = String::from_utf8_lossy(&head);
    let mut parts = line.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("GET"), Some(target)) => Ok(target.to_owned()),
        _ => bail!("not a GET request"),
    }
}

async fn reply(stream: &mut TcpStream, status: StatusCode, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Nisse</title><p style=\"font-family:sans-serif\">{message}</p>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn device_code_sign_in(
    http: &reqwest::Client,
    server: &AuthServer,
    flow: &mut SignIn,
) -> Result<Tokens> {
    let response = http
        .post(format!("{}/api/accounts/deviceauth/usercode", server.base))
        .json(&json!({ "client_id": CLIENT_ID }))
        .send()
        .await?;
    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        bail!("this server offers no device code sign-in; sign in through a browser");
    }
    let text = response.text().await?;
    if !status.is_success() {
        bail!(
            "asking for a device code failed ({status}){}",
            reason(&text)
        );
    }
    let device: Value = serde_json::from_str(&text)?;
    let (Some(device_auth_id), Some(user_code)) = (
        device["device_auth_id"].as_str(),
        device["user_code"].as_str(),
    ) else {
        bail!("the device code answer is missing fields");
    };
    let interval = device["interval"]
        .as_u64()
        .or_else(|| device["interval"].as_str()?.trim().parse().ok())
        .map_or(SHORTEST_POLL, Duration::from_secs)
        .max(SHORTEST_POLL);
    flow.show(AuthInteraction::DeviceCode {
        url: format!("{}/codex/device", server.base),
        code: user_code.into(),
    });

    let deadline = Instant::now() + DEVICE_CODE_LIFETIME;
    while Instant::now() < deadline {
        tokio::time::sleep(interval).await;
        let response = http
            .post(format!("{}/api/accounts/deviceauth/token", server.base))
            .json(&json!({ "device_auth_id": device_auth_id, "user_code": user_code }))
            .send()
            .await?;
        let status = response.status();
        if status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND {
            continue;
        }
        let text = response.text().await?;
        if !status.is_success() {
            bail!("the device code sign-in failed ({status}){}", reason(&text));
        }
        let granted: Value = serde_json::from_str(&text)?;
        let (Some(code), Some(verifier)) = (
            granted["authorization_code"].as_str(),
            granted["code_verifier"].as_str(),
        ) else {
            bail!("the device code grant is missing fields");
        };
        let redirect_uri = format!("{}/deviceauth/callback", server.base);
        return exchange(http, server, code, verifier, &redirect_uri).await;
    }
    bail!("the device code expired before anyone entered it")
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// What an error answer says went wrong, without anything else it carries.
fn reason(body: &str) -> String {
    let error: Value = serde_json::from_str(body).unwrap_or_default();
    let said = error["error_description"]
        .as_str()
        .or(error["error"]["message"].as_str())
        .or(error["error"].as_str());
    said.map(|said| format!(": {said}")).unwrap_or_default()
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|error| anyhow!("no randomness: {error}"))?;
    Ok(bytes)
}
