//! Signing in to ChatGPT, against a fake OpenAI sign-in server.

mod common;

use std::{os::unix::fs::PermissionsExt, sync::Mutex};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{Fake, PATIENCE, sign_in};
use nisse_openai::{LoginMethod, LoginPrompt, login_with};
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
async fn a_silent_connection_to_the_callback_does_not_hold_up_the_browsers_answer() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    let (prompts, mut prompted) = tokio::sync::mpsc::unbounded_channel();
    let server = fake.auth_server();
    let path = auth_path.clone();
    let login = tokio::spawn(async move {
        login_with(&server, &path, LoginMethod::Browser, move |prompt| {
            let _ = prompts.send(prompt);
        })
        .await
    });
    let Some(LoginPrompt::OpenUrl { url }) = prompted.recv().await else {
        panic!("the browser flow asks to open a URL");
    };
    let url = reqwest::Url::parse(&url).unwrap();
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .unwrap()
    };
    let callback = reqwest::Url::parse(&param("redirect_uri")).unwrap();

    let _preconnected = tokio::net::TcpStream::connect(("127.0.0.1", callback.port().unwrap()))
        .await
        .unwrap();
    let answered = tokio::time::timeout(PATIENCE, async {
        let browser = reqwest::get(format!("{callback}?code=the-code&state={}", param("state")))
            .await
            .unwrap();
        login.await.unwrap().unwrap();
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
    let auth_path = home.path().join("openai.json");
    let (prompts, mut prompted) = tokio::sync::mpsc::unbounded_channel();
    let server = fake.auth_server();
    let path = auth_path.clone();
    let login = tokio::spawn(async move {
        login_with(&server, &path, LoginMethod::Browser, move |prompt| {
            let _ = prompts.send(prompt);
        })
        .await
    });
    let Some(LoginPrompt::OpenUrl { url }) = prompted.recv().await else {
        panic!("the browser flow asks to open a URL");
    };
    let url = reqwest::Url::parse(&url).unwrap();
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .unwrap()
    };
    let asked_challenge = param("code_challenge");
    assert_eq!(param("code_challenge_method"), "S256");
    assert_eq!(param("originator"), "nisse");
    let callback = param("redirect_uri");

    let stranger = reqwest::get(format!("{callback}?code=forged&state=not-the-state"))
        .await
        .unwrap();
    let browser = reqwest::get(format!("{callback}?code=the-code&state={}", param("state")))
        .await
        .unwrap();
    tokio::time::timeout(PATIENCE, login)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(stranger.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(browser.status(), reqwest::StatusCode::OK);
    let form = fake.received("/oauth/token")[0].form();
    assert_eq!(form["code"], "the-code");
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes()));
    assert_eq!(challenge, asked_challenge);
}

#[tokio::test]
async fn the_device_code_flow_shows_a_code_and_saves_tokens() {
    let fake = Fake::start().await;
    fake.issue_tokens("first", 3600);
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    let prompts = Mutex::new(Vec::new());

    tokio::time::timeout(
        PATIENCE,
        login_with(
            &fake.auth_server(),
            &auth_path,
            LoginMethod::DeviceCode,
            |prompt| prompts.lock().unwrap().push(prompt),
        ),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(
        prompts.into_inner().unwrap(),
        [LoginPrompt::EnterCode {
            url: format!("{}/codex/device", fake.base),
            code: "WXYZ-1234".into(),
        }]
    );
    let form = fake.received("/oauth/token")[0].form();
    assert_eq!(form["code"], "device-code");
    assert_eq!(form["code_verifier"], "device-verifier");
    assert_eq!(
        form["redirect_uri"],
        format!("{}/deviceauth/callback", fake.base)
    );
    assert!(auth_path.exists());
}
