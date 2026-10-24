//! Signing in to ChatGPT through the server's sign-in methods, against a fake OpenAI sign-in
//! server.

mod common;

use std::os::unix::fs::PermissionsExt;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{EMAIL, Fake, Nisse, PATIENCE, answer, param, sign_in};
use nisse_client::Client;
use nisse_protocol::{
    AuthAccepted, AuthCancelParams, AuthInteraction, AuthLogoutParams, AuthMethod, AuthPhase,
    AuthResponse, AuthState, ClientRequest, ProviderSnapshot, ProviderStatus, ServerNotification,
};
use reqwest::Url;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn the_browser_callback_exchanges_its_code_for_saved_tokens() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");

    let page = sign_in(&fake, &auth_path).await;

    assert_eq!(page, reqwest::StatusCode::OK);
    let exchanges = fake.received("/oauth/token");
    assert_eq!(exchanges.len(), 1);
    let form = exchanges[0].form();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["client_id"], "app_EMoamEEZ73f0CkXaXp7hrann");
    assert_eq!(form["code"], "the-code");
    assert!(
        form["redirect_uri"].starts_with("http://localhost:")
            && form["redirect_uri"].ends_with("/auth/callback"),
        "{}",
        form["redirect_uri"]
    );
    let mode = std::fs::metadata(&auth_path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[tokio::test]
async fn the_provider_reads_signed_out_until_a_sign_in_names_the_account() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let mut nisse = Nisse::start(&fake, &home.path().join("openai.json")).await;
    let before = nisse.provider().await;

    let waiting = nisse.start_sign_in(None).await;
    reqwest::get(answer(&waiting, "the-code")).await.unwrap();
    let settled = nisse.sign_in_settles().await;
    let after = nisse.provider().await;

    assert_eq!(before.health.status, ProviderStatus::SignedOut);
    assert_eq!(
        before.sign_in,
        [AuthMethod::Browser, AuthMethod::DeviceCode]
    );
    let account = format!("{EMAIL} · ChatGPT Plus");
    assert_eq!(settled.phase, AuthPhase::Succeeded);
    assert_eq!(settled.message.as_deref(), Some(account.as_str()));
    assert_eq!(after.health.status, ProviderStatus::Ready);
    assert_eq!(after.health.account.as_deref(), Some(account.as_str()));
}

#[tokio::test]
async fn a_silent_connection_to_the_callback_does_not_hold_up_the_browsers_answer() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    let mut nisse = Nisse::start(&fake, &auth_path).await;
    let waiting = nisse.start_sign_in(Some(AuthMethod::Browser)).await;
    let callback = answer(&waiting, "the-code");

    let _preconnected = tokio::net::TcpStream::connect(("127.0.0.1", callback.port().unwrap()))
        .await
        .unwrap();
    let answered = tokio::time::timeout(PATIENCE, async {
        let browser = reqwest::get(callback).await.unwrap();
        nisse.sign_in_settles().await;
        browser.status()
    })
    .await
    .expect("the browser's answer got through");

    assert_eq!(answered, reqwest::StatusCode::OK);
    assert!(auth_path.exists());
}

#[tokio::test]
async fn the_browser_flow_proves_it_asked_with_pkce() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let mut nisse = Nisse::start(&fake, &home.path().join("openai.json")).await;
    let waiting = nisse.start_sign_in(Some(AuthMethod::Browser)).await;
    let Some(AuthInteraction::Browser { url }) = &waiting.interaction else {
        panic!("the browser flow asks to open a URL");
    };
    let url = Url::parse(url).unwrap();
    let asked_challenge = param(&url, "code_challenge");
    assert_eq!(param(&url, "code_challenge_method"), "S256");
    assert_eq!(param(&url, "originator"), "nisse");
    let callback = param(&url, "redirect_uri");

    let stranger = reqwest::get(format!("{callback}?code=forged&state=not-the-state"))
        .await
        .unwrap();
    let browser = reqwest::get(answer(&waiting, "the-code")).await.unwrap();
    let settled = nisse.sign_in_settles().await;

    assert_eq!(settled.phase, AuthPhase::Succeeded);
    assert_eq!(stranger.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(browser.status(), reqwest::StatusCode::OK);
    let form = fake.received("/oauth/token")[0].form();
    assert_eq!(form["code"], "the-code");
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes()));
    assert_eq!(challenge, asked_challenge);
}

#[tokio::test]
async fn a_browser_on_another_machine_signs_in_with_the_address_it_ended_on() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    let mut nisse = Nisse::start(&fake, &auth_path).await;
    let waiting = nisse.start_sign_in(Some(AuthMethod::Browser)).await;
    let ended_on = answer(&waiting, "the-code").to_string();

    let accepted = nisse
        .respond(&waiting, AuthResponse::Callback { url: ended_on })
        .await;
    let settled = nisse.sign_in_settles().await;

    assert!(accepted);
    assert_eq!(settled.phase, AuthPhase::Succeeded, "{settled:?}");
    let form = fake.received("/oauth/token")[0].form();
    assert_eq!(form["code"], "the-code");
    assert!(auth_path.exists());
}

#[tokio::test]
async fn the_device_code_flow_shows_a_code_and_saves_tokens() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let waiting = nisse.start_sign_in(Some(AuthMethod::DeviceCode)).await;
    let settled = nisse.sign_in_settles().await;

    assert_eq!(
        waiting.interaction,
        Some(AuthInteraction::DeviceCode {
            url: format!("{}/codex/device", fake.base),
            code: "WXYZ-1234".into(),
        })
    );
    assert_eq!(settled.phase, AuthPhase::Succeeded);
    let form = fake.received("/oauth/token")[0].form();
    assert_eq!(form["code"], "device-code");
    assert_eq!(form["code_verifier"], "device-verifier");
    assert_eq!(
        form["redirect_uri"],
        format!("{}/deviceauth/callback", fake.base)
    );
    assert!(auth_path.exists());
}

#[tokio::test]
async fn any_client_follows_and_finishes_a_sign_in_another_started() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let mut nisse = Nisse::start(&fake, &home.path().join("openai.json")).await;
    let (other, mut heard) = Client::new(nisse.server.connect_in_process());
    other.initialize("other").await.unwrap();

    let waiting = nisse.start_sign_in(Some(AuthMethod::Browser)).await;
    let joined: AuthState = other
        .request(ClientRequest::AuthStart(nisse_protocol::AuthStartParams {
            provider: waiting.provider.clone(),
            method: None,
        }))
        .await
        .unwrap();
    reqwest::get(answer(&joined, "the-code")).await.unwrap();
    let settled = tokio::time::timeout(PATIENCE, async {
        loop {
            if let Some(ServerNotification::AuthState(state)) = heard.recv().await
                && state.phase.is_over()
            {
                return state;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(joined, waiting);
    assert_eq!(settled.phase, AuthPhase::Succeeded);
}

#[tokio::test]
async fn cancelling_a_sign_in_lets_go_of_its_callback_port() {
    let fake = Fake::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut nisse = Nisse::start(&fake, &home.path().join("openai.json")).await;
    let waiting = nisse.start_sign_in(Some(AuthMethod::Browser)).await;
    let callback = answer(&waiting, "the-code");

    let cancelled: AuthAccepted = nisse
        .client
        .request(ClientRequest::AuthCancel(AuthCancelParams {
            provider: waiting.provider.clone(),
            flow_id: waiting.flow_id.clone(),
        }))
        .await
        .unwrap();
    let settled = nisse.sign_in_settles().await;

    assert!(cancelled.accepted);
    assert_eq!(settled.phase, AuthPhase::Cancelled);
    tokio::time::timeout(PATIENCE, async {
        while tokio::net::TcpStream::connect(("127.0.0.1", callback.port().unwrap()))
            .await
            .is_ok()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("nothing listens for the browser anymore");
}

#[tokio::test]
async fn signing_out_forgets_the_sign_in() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    sign_in(&fake, &auth_path).await;
    let nisse = Nisse::start(&fake, &auth_path).await;

    let signed_out: ProviderSnapshot = nisse
        .client
        .request(ClientRequest::AuthLogout(AuthLogoutParams {
            provider: "openai".into(),
        }))
        .await
        .unwrap();

    assert_eq!(signed_out.health.status, ProviderStatus::SignedOut);
    assert!(!auth_path.exists());
}

#[tokio::test]
async fn a_sign_in_chatgpt_no_longer_refreshes_reads_signed_out() {
    let fake = Fake::start().await;
    fake.issue_tokens("expired", -1);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    sign_in(&fake, &auth_path).await;
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    nisse.converse("hello", true).await;
    let provider = nisse.provider().await;

    assert_eq!(provider.health.status, ProviderStatus::SignedOut);
    assert_eq!(
        provider.health.message.as_deref(),
        Some("the ChatGPT sign-in expired; sign in again")
    );
}
