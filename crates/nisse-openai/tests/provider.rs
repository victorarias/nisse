//! The OpenAI provider driven through a real Nisse server, against a fake ChatGPT backend.

mod common;

use std::os::unix::fs::PermissionsExt;

use common::{
    ACCOUNT, Fake, INSTRUCTIONS, Nisse, access_token, assert_requests, exchange, sign_in,
};
use nisse_core::LIVE_INTERVAL;
use nisse_protocol::kinds;
use serde_json::{Value, json};

async fn signed_in(fake: &Fake, expires_in: i64) -> (tempfile::TempDir, std::path::PathBuf) {
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    fake.issue_tokens("first", expires_in);
    sign_in(fake, &auth_path).await;
    (home, auth_path)
}

fn texts(entries: &[(String, Value)]) -> Vec<(&str, &str)> {
    entries
        .iter()
        .map(|(kind, data)| {
            let text = data["text"].as_str().or(data["output"].as_str());
            (kind.as_str(), text.unwrap_or_default())
        })
        .collect()
}

#[tokio::test]
async fn a_text_answer_is_committed_as_the_assistants_message() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    let expected = fake.play("text_answer");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse("hello", true).await);

    assert_eq!(
        texts(&entries),
        [(kinds::USER, "hello"), (kinds::ASSISTANT, "Hello there")]
    );
    assert_requests(&fake, &expected);
}

#[tokio::test]
async fn text_shows_live_while_the_model_writes_it() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("text_answer");
    let release = fake.hold_after(4);
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    nisse.submit("hello").await;
    let live = nisse.live().await;
    release.notify_one();
    let entries = exchange(&nisse.finish(true).await);

    assert_eq!(live, "Hello there");
    assert_eq!(entries.last().unwrap().1["text"], "Hello there");
}

#[tokio::test]
async fn requests_carry_the_sign_in_and_the_conversation() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("text_answer");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    nisse.converse("hello", true).await;

    let sent = &fake.received("/codex/responses")[0];
    let conversation_id = nisse.conversation.id.as_str();
    let header = |name: &str| sent.headers.get(name).map(String::as_str);
    assert_eq!(
        header("authorization"),
        Some(format!("Bearer {}", access_token("first")).as_str())
    );
    assert_eq!(header("chatgpt-account-id"), Some(ACCOUNT));
    assert_eq!(header("openai-beta"), Some("responses=experimental"));
    assert_eq!(header("originator"), Some("nisse"));
    assert_eq!(header("session-id"), Some(conversation_id));
    assert_eq!(sent.json()["prompt_cache_key"], conversation_id);
    let instructions = sent.json()["instructions"].as_str().unwrap().to_owned();
    assert!(instructions.starts_with(&format!(
        "{INSTRUCTIONS}\nThe working directory is {}.\n",
        nisse.conversation.cwd.display()
    )));
}

#[tokio::test]
async fn the_model_is_offered_claude_codes_tool_names_and_arguments_so_one_hook_fits_both() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("text_answer");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    nisse.converse("hello", true).await;

    let sent = fake.received("/codex/responses")[0].json();
    let offered: Vec<(&str, &str, Vec<&str>)> = sent["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| {
            let arguments = tool["parameters"]["properties"].as_object().unwrap();
            (
                tool["type"].as_str().unwrap(),
                tool["name"].as_str().unwrap(),
                arguments.keys().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        offered,
        [
            ("function", "Read", vec!["file_path", "limit", "offset"]),
            ("function", "Write", vec!["content", "file_path"]),
            (
                "function",
                "Edit",
                vec!["file_path", "new_string", "old_string", "replace_all"]
            ),
            ("function", "Bash", vec!["command", "timeout"]),
            ("function", "Grep", vec!["glob", "path", "pattern"]),
        ]
    );
}

#[tokio::test]
async fn a_tool_call_runs_and_its_output_goes_back_to_the_model() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    let expected = fake.play("tool_call");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse("what does echo say?", true).await);

    assert_eq!(
        texts(&entries),
        [
            (kinds::USER, "what does echo say?"),
            (kinds::ASSISTANT, "Let me look."),
            (kinds::TOOL_CALL, ""),
            (kinds::TOOL_RESULT, "hi\n"),
            (kinds::ASSISTANT, "It printed hi."),
        ]
    );
    assert_eq!(
        entries[2].1,
        json!({ "id": "call_1", "name": "Bash", "args": { "command": "echo hi" } })
    );
    assert_requests(&fake, &expected);
}

#[tokio::test]
async fn a_steer_waits_until_every_call_the_model_made_at_once_has_its_result() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    let expected = fake.play("steer_after_parallel_calls");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    nisse.submit("echo one and two").await;
    let entries = exchange(&nisse.finish_steering(true, Some("and three")).await);

    assert_eq!(
        texts(&entries),
        [
            (kinds::USER, "echo one and two"),
            (kinds::TOOL_CALL, ""),
            (kinds::TOOL_RESULT, "one\n"),
            (kinds::TOOL_CALL, ""),
            (kinds::TOOL_RESULT, "two\n"),
            (kinds::USER, "and three"),
            (kinds::ASSISTANT, "One, two, and three."),
        ]
    );
    assert_requests(&fake, &expected);
}

#[tokio::test]
async fn a_denied_tool_call_is_reported_to_the_model_as_denied() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    let expected = fake.play("tool_denied");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse("what does echo say?", false).await);

    let result = &entries[3].1;
    assert_eq!(result["denied"], "owner declined");
    assert_eq!(
        entries.last().unwrap().1["text"],
        "I was not allowed to run it."
    );
    assert_requests(&fake, &expected);
}

#[tokio::test]
async fn a_failed_response_is_committed_as_a_model_error() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("response_failed");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse("hello", true).await);

    let (kind, error) = entries.last().unwrap();
    assert_eq!(kind, kinds::ASSISTANT);
    assert_eq!(error["is_error"], true);
    let text = error["text"].as_str().unwrap();
    assert!(text.contains("The model crashed."), "{text}");
}

#[tokio::test]
async fn a_stream_cut_before_the_response_finished_is_an_error_not_a_hang() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("stream_cut");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse("hello", true).await);

    assert_eq!(entries.len(), 2, "{entries:#?}");
    let (_, error) = &entries[1];
    assert_eq!(error["is_error"], true);
    let text = error["text"].as_str().unwrap();
    assert!(
        text.contains("ended before the response finished"),
        "{text}"
    );
}

#[tokio::test]
async fn a_message_cut_off_by_a_failed_stream_does_not_stay_live() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("stream_cut");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    nisse.converse("hello", true).await;
    let late_live = nisse.live_within(LIVE_INTERVAL * 3).await;

    assert_eq!(late_live, None);
}

#[tokio::test]
async fn a_reached_usage_limit_says_so_plainly() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("usage_limit");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse("hello", true).await);

    let text = entries[1].1["text"].as_str().unwrap();
    assert!(
        text.contains("You have hit your ChatGPT usage limit (plus plan)."),
        "{text}"
    );
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_once_and_kept_for_later_turns() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    let expected = fake.play("refresh");
    fake.issue_tokens("second", 3600);
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let first = exchange(&nisse.converse("hello", true).await);
    let again = exchange(&nisse.converse("again", true).await);

    assert_eq!(first.last().unwrap().1["text"], "Hello there");
    assert_eq!(again.last().unwrap().1["text"], "Hello again");
    assert_requests(&fake, &expected);
    let bearers: Vec<String> = fake
        .received("/codex/responses")
        .iter()
        .map(|sent| sent.headers["authorization"].clone())
        .collect();
    let first_token = format!("Bearer {}", access_token("first"));
    let second_token = format!("Bearer {}", access_token("second"));
    assert_eq!(bearers, [first_token, second_token.clone(), second_token]);
    let refreshes: Vec<_> = fake
        .received("/oauth/token")
        .iter()
        .map(|sent| sent.form())
        .filter(|form| form["grant_type"] == "refresh_token")
        .collect();
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0]["refresh_token"], "first-refresh");
    let mode = std::fs::metadata(&auth_path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[tokio::test]
async fn an_expired_sign_in_is_refreshed_before_asking() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 0).await;
    let expected = fake.play("text_answer");
    fake.issue_tokens("second", 3600);
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse("hello", true).await);

    assert_eq!(entries.last().unwrap().1["text"], "Hello there");
    assert_requests(&fake, &expected);
    let sent = &fake.received("/codex/responses")[0];
    assert_eq!(
        sent.headers["authorization"],
        format!("Bearer {}", access_token("second"))
    );
}

#[tokio::test]
async fn without_a_sign_in_the_turn_says_to_sign_in() {
    let fake = Fake::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut nisse = Nisse::start(&fake, &home.path().join("openai.json")).await;

    let entries = exchange(&nisse.converse("hello", true).await);

    let text = entries[1].1["text"].as_str().unwrap();
    assert!(text.contains("not signed in to ChatGPT"), "{text}");
    assert!(fake.received("/codex/responses").is_empty());
}

#[tokio::test]
async fn a_recorded_turn_replays_as_a_fixture() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play("tool_call");
    let recordings = tempfile::tempdir().unwrap();
    let mut nisse = Nisse::recording(&fake, &auth_path, Some(recordings.path())).await;
    let recorded = exchange(&nisse.converse("what does echo say?", true).await);
    let files: Vec<_> = std::fs::read_dir(recordings.path())
        .unwrap()
        .map(|file| file.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1, "one fixture per turn");

    let replay = Fake::start().await;
    let (_home, auth_path) = signed_in(&replay, 3600).await;
    let expected = replay.play_file(&files[0]);
    let mut nisse = Nisse::start(&replay, &auth_path).await;
    let replayed = exchange(&nisse.converse("what does echo say?", true).await);

    assert_eq!(texts(&replayed), texts(&recorded));
    assert_eq!(expected.len(), 2);
    assert_eq!(expected[0]["instructions"], "<any>");
    assert_eq!(expected[0]["prompt_cache_key"], "<any>");
    assert_requests(&replay, &expected);
}

const RECORDED_PROMPT: &str = "what does `echo hi` print?";

#[tokio::test]
async fn a_real_chatgpt_answer_replays_as_the_assistants_message() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    let expected = fake.play("recorded_text_answer");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    let entries = exchange(&nisse.converse(RECORDED_PROMPT, true).await);

    assert_eq!(
        texts(&entries),
        [
            (kinds::USER, RECORDED_PROMPT),
            (kinds::ASSISTANT, "`echo hi` prints:\n\n```text\nhi\n```")
        ]
    );
    assert_requests(&fake, &expected);
}

#[tokio::test]
async fn recording_a_real_exchange_keeps_none_of_its_response_or_message_ids() {
    let committed = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/recorded_text_answer.ndjson"
    ))
    .unwrap();
    let as_served = committed
        .replace(
            "<resp:1>",
            "resp_00bd91aafa8ad59c016adbe32715d8819188c22535ac5ed206",
        )
        .replace(
            "<msg:1>",
            "msg_00bd91aafa8ad59c016adbe32841a48191bb5fbc1a23541f9b",
        )
        .replace(
            "<msg:2>",
            "msg_00bd91aafa8ad59c016adbe32716a88191a8205bd38af81e1c",
        );
    let served = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(served.path(), as_served).unwrap();
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake, 3600).await;
    fake.play_file(served.path());
    let recordings = tempfile::tempdir().unwrap();
    let mut nisse = Nisse::recording(&fake, &auth_path, Some(recordings.path())).await;

    nisse.converse(RECORDED_PROMPT, true).await;

    let recording = std::fs::read_dir(recordings.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let lines = |text: &str| -> Vec<Value> {
        text.lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    };
    assert_eq!(
        lines(&std::fs::read_to_string(recording).unwrap()),
        lines(&committed)
    );
}
