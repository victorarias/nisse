//! Code mode through a real Nisse server, with Codex's real code-mode host running each script,
//! against a fake ChatGPT backend.

mod common;

use std::{os::unix::fs::PermissionsExt, sync::Arc};

use common::{
    CODE_MODE_MODEL, Fake, Nisse, assert_requests, code_mode_host, exchange, in_code_mode, sign_in,
};
use nisse_core::{Hooks, NoHooks, ToolCall, ToolOutcome};
use nisse_openai::NestedTools;
use nisse_protocol::{Entry, kinds};
use serde_json::{Value, json};

async fn signed_in(fake: &Fake) -> (tempfile::TempDir, std::path::PathBuf) {
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    fake.issue_tokens("first", 3600);
    sign_in(fake, &auth_path).await;
    (home, auth_path)
}

fn of_kind<'a>(entries: &'a [Entry], kind: &str) -> Vec<&'a Value> {
    entries
        .iter()
        .filter(|entry| entry.kind == kind)
        .map(|entry| &entry.data)
        .collect()
}

#[tokio::test]
async fn a_code_mode_model_is_offered_exec_and_wait_with_nisses_tools_declared_inside_exec() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake).await;
    fake.play("code_mode_script");
    let mut nisse = Nisse::with(&fake, &auth_path, CODE_MODE_MODEL, in_code_mode).await;

    nisse.converse("what does echo say?", true).await;

    let sent = fake.received("/codex/responses")[0].json();
    let offered: Vec<(&str, &str)> = sent["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| {
            (
                tool["type"].as_str().unwrap(),
                tool["name"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(offered, [("custom", "exec"), ("function", "wait")]);
    let exec = sent["tools"][0]["description"].as_str().unwrap();
    for declared in [
        "Read(args: {",
        "Write(args: {",
        "Edit(args: {",
        "Bash(args: {",
        "Grep(args: {",
    ] {
        assert!(exec.contains(declared), "exec declares {declared}\n{exec}");
    }
    assert!(exec.contains("  // The shell command to run.\n  command: string;"));
}

#[tokio::test]
async fn a_scripts_nested_call_is_committed_approved_and_answered_and_the_model_sees_only_the_script()
 {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake).await;
    let expected = fake.play("code_mode_script");
    let mut nisse = Nisse::with(&fake, &auth_path, CODE_MODE_MODEL, in_code_mode).await;

    let entries = nisse.converse("what does echo say?", true).await;

    let calls = of_kind(&entries, kinds::TOOL_CALL);
    assert_eq!(calls[0]["name"], "exec");
    assert_eq!(
        (&calls[1]["name"], &calls[1]["args"], &calls[1]["parent"]),
        (
            &json!("Bash"),
            &json!({ "command": "echo hi" }),
            &calls[0]["id"]
        )
    );
    let asked = of_kind(&entries, kinds::APPROVAL_REQUEST);
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["call_id"], calls[1]["id"]);
    let results = of_kind(&entries, kinds::TOOL_RESULT);
    assert_eq!(results[0]["parent"], calls[0]["id"]);
    assert_eq!(results[0]["output"], "hi\n");
    let script = results[1]["output"].as_str().unwrap();
    assert!(script.starts_with("Script completed\n"), "{script}");
    assert!(script.ends_with("Output:\nhi\n"), "{script}");
    assert_eq!(exchange(&entries).last().unwrap().1["text"], "It says hi.");
    assert_requests(&fake, &expected);
}

struct DenyBash;

impl Hooks for DenyBash {
    fn tool_call(
        &self,
        call: ToolCall,
        engine: &(dyn Fn(ToolCall) -> ToolOutcome + Sync),
    ) -> ToolOutcome {
        match call.name.as_str() {
            "Bash" => ToolOutcome::denied("no shell today"),
            _ => engine(call),
        }
    }
}

#[tokio::test]
async fn a_hook_on_bash_covers_the_bash_calls_a_script_makes() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake).await;
    fake.play("code_mode_script");
    let mut nisse = Nisse::with_hooks(
        &fake,
        &auth_path,
        CODE_MODE_MODEL,
        in_code_mode,
        Arc::new(DenyBash),
    )
    .await;

    let entries = nisse.converse("what does echo say?", true).await;

    let results = of_kind(&entries, kinds::TOOL_RESULT);
    assert_eq!(results[0]["name"], "Bash");
    assert_eq!(results[0]["denied"], "no shell today");
    assert!(
        results[1]["output"]
            .as_str()
            .unwrap()
            .ends_with("Output:\nno shell today"),
        "the script saw the denial: {}",
        results[1]["output"]
    );
}

#[tokio::test]
async fn a_script_that_yields_is_resumed_by_wait() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake).await;
    let expected = fake.play("code_mode_wait");
    let mut nisse = Nisse::with(&fake, &auth_path, CODE_MODE_MODEL, in_code_mode).await;

    let entries = nisse.converse("count slowly", true).await;

    let results: Vec<&str> = of_kind(&entries, kinds::TOOL_RESULT)
        .iter()
        .map(|result| result["output"].as_str().unwrap())
        .collect();
    assert!(
        results[0].starts_with("Script running with cell ID 1\n")
            && results[0].ends_with("started"),
        "{}",
        results[0]
    );
    assert!(
        results[1].starts_with("Script completed\n") && results[1].ends_with("finished"),
        "{}",
        results[1]
    );
    assert_requests(&fake, &expected);
}

#[tokio::test]
async fn a_host_that_dies_mid_script_interrupts_it_with_the_nested_results_so_far() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake).await;
    fake.play("code_mode_host_dies");
    let launcher = tempfile::tempdir().unwrap();
    let pid_file = launcher.path().join("host.pid");
    let host = launcher.path().join("host");
    std::fs::write(
        &host,
        format!(
            "#!/bin/sh\necho $$ > '{}'\nexec '{}' \"$@\"\n",
            pid_file.display(),
            code_mode_host().display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&host, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut nisse = Nisse::with(&fake, &auth_path, CODE_MODE_MODEL, |options| {
        in_code_mode(options);
        options.code_mode_host = host.clone();
    })
    .await;

    nisse.submit("read the manifest, then wait").await;
    let read = nisse.next(kinds::TOOL_RESULT).await;
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    std::process::Command::new("kill")
        .args(["-9", pid.trim()])
        .status()
        .unwrap();
    let entries = nisse.finish(true).await;

    assert_eq!(read.data["name"], "Read");
    let script = of_kind(&entries, kinds::TOOL_RESULT)
        .into_iter()
        .find(|result| result["name"] == "exec")
        .unwrap();
    let output = script["output"].as_str().unwrap();
    assert!(
        output.starts_with("interrupted: the code-mode host stopped"),
        "{output}"
    );
    assert!(
        output.contains("The calls it made that finished:\n- Read (done):"),
        "{output}"
    );
    assert!(output.contains("[package]"), "{output}");
}

#[tokio::test]
async fn on_codex_tool_names_exec_command_is_committed_as_bash_so_bash_hooks_cover_it() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake).await;
    fake.play("code_mode_codex_tools");
    let mut nisse = Nisse::with(&fake, &auth_path, CODE_MODE_MODEL, |options| {
        in_code_mode(options);
        options.nested_tools = NestedTools::Codex;
    })
    .await;

    let entries = nisse.converse("what does echo say?", true).await;

    let sent = fake.received("/codex/responses")[0].json();
    let exec = sent["tools"][0]["description"].as_str().unwrap();
    assert!(exec.contains("exec_command(args: {"), "{exec}");
    assert!(exec.contains("apply_patch(input: string)"), "{exec}");
    let calls = of_kind(&entries, kinds::TOOL_CALL);
    assert_eq!(
        (&calls[1]["name"], &calls[1]["args"]),
        (&json!("Bash"), &json!({ "command": "echo hi" }))
    );
    assert!(
        of_kind(&entries, kinds::TOOL_RESULT)[1]["output"]
            .as_str()
            .unwrap()
            .ends_with("Output:\nhi\n")
    );
}

#[tokio::test]
async fn without_the_code_mode_host_a_code_mode_model_says_how_to_install_it() {
    let fake = Fake::start().await;
    let (_home, auth_path) = signed_in(&fake).await;
    let mut nisse = Nisse::with_hooks(
        &fake,
        &auth_path,
        CODE_MODE_MODEL,
        |options| {
            in_code_mode(options);
            options.code_mode_host = "/nowhere/codex-code-mode-host".into();
        },
        Arc::new(NoHooks),
    )
    .await;

    let entries = exchange(&nisse.converse("hello", true).await);

    let text = entries.last().unwrap().1["text"].as_str().unwrap();
    assert!(text.contains("scripts/code-mode-host.sh"), "{text}");
    assert!(fake.received("/codex/responses").is_empty());
}
