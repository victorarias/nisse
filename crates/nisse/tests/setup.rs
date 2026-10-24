//! Providers from `NISSE_HOME/config.toml`, as the `nisse` binary lists and names them.

use std::{path::Path, process::Command};

fn nisse(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nisse"));
    command
        .arg("--home")
        .arg(home)
        .args(["--claude", "/nonexistent/claude"])
        .env("NISSE_IDLE_GRACE_MS", "1000")
        .current_dir(home);
    command
}

#[test]
fn the_config_file_adds_providers_after_the_built_in_ones() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.toml"),
        r#"
[providers.openai-work]
driver = "openai"

[providers.claude-personal]
driver = "claude"
binary = "/nonexistent/claude-personal"
config_dir = "~/.claude-personal"
"#,
    )
    .unwrap();

    let output = nisse(home.path()).arg("providers").output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let listed = String::from_utf8(output.stdout).unwrap();
    let rows: Vec<Vec<&str>> = listed
        .lines()
        .map(|line| line.split_whitespace().take(3).collect())
        .collect();
    assert_eq!(
        rows,
        [
            ["claude", "claude", "unavailable"],
            ["openai", "openai", "signed"],
            ["echo", "echo", "ready"],
            ["claude-personal", "claude", "unavailable"],
            ["openai-work", "openai", "signed"],
        ],
        "{listed}"
    );
    assert!(listed.contains("/nonexistent/claude-personal"), "{listed}");
}

#[test]
fn a_provider_nobody_configured_is_refused_with_the_ones_there_are() {
    let home = tempfile::tempdir().unwrap();

    let output = nisse(home.path())
        .args(["--provider", "work", "exec", "hello"])
        .output()
        .unwrap();

    assert!(!output.status.success());
    let said = String::from_utf8(output.stderr).unwrap();
    assert!(
        said.contains("no provider named work; this server has claude, openai, echo"),
        "{said}"
    );
}

#[test]
fn a_setting_that_only_claude_takes_is_refused_on_openai() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.toml"),
        "[providers.openai]\ndriver = \"openai\"\nconfig_dir = \"/somewhere\"\n",
    )
    .unwrap();

    let output = nisse(home.path()).arg("serve").output().unwrap();

    assert!(!output.status.success());
    let said = String::from_utf8(output.stderr).unwrap();
    assert!(said.contains("only claude providers take"), "{said}");
}

#[test]
fn a_project_s_default_model_wins_over_the_config_file_s() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.toml"),
        "default_model = { provider = \"echo\" }\n",
    )
    .unwrap();
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir(project.path().join(".nisse")).unwrap();
    std::fs::write(
        project.path().join(".nisse/config.toml"),
        "[default_model]\nprovider = \"claude\"\nmodel = \"opus\"\n",
    )
    .unwrap();
    let secretive = tempfile::tempdir().unwrap();
    std::fs::create_dir(secretive.path().join(".nisse")).unwrap();
    std::fs::write(
        secretive.path().join(".nisse/config.toml"),
        "[providers.claude]\ndriver = \"claude\"\nbinary = \"/somewhere/else\"\n",
    )
    .unwrap();
    let exec = |cwd: &Path| {
        let output = nisse(home.path())
            .args(["exec", "hello"])
            .current_dir(cwd)
            .output()
            .unwrap();
        (
            output.status.success(),
            String::from_utf8(output.stdout).unwrap(),
            String::from_utf8(output.stderr).unwrap(),
        )
    };

    let (_, outside, _) = exec(home.path());
    let (_, inside, _) = exec(project.path());
    let (refused, _, why) = exec(secretive.path());

    assert!(outside.contains("You said: hello"), "{outside}");
    assert!(inside.contains("Model error"), "{inside}");
    assert!(!refused);
    assert!(why.contains("unknown field `providers`"), "{why}");
}
