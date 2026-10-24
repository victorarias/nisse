//! What the OpenAI provider reads from the conversation's workspace: AGENTS.md files and skills.

mod common;

use std::path::{Path, PathBuf};

use common::{Fake, INSTRUCTIONS, Nisse, sign_in};
use nisse_core::{AGENTS_MD_LIMIT, Workspace};
use nisse_protocol::{ClientRequest, Skill, SkillsListParams, SkillsListResult, kinds};
use serde_json::Value;

/// A home and a repository with a folder inside it, where the conversation works.
struct Folders {
    _root: tempfile::TempDir,
    home: PathBuf,
    repo: PathBuf,
    cwd: PathBuf,
}

impl Folders {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let repo = root.path().join("repo");
        let cwd = repo.join("crates/app");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir(repo.join(".git")).unwrap();
        Self {
            _root: root,
            home,
            repo,
            cwd,
        }
    }

    fn write(&self, path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn skill(&self, folder: &Path, name: &str, description: &str, body: &str) -> PathBuf {
        let path = folder.join(name).join("SKILL.md");
        self.write(
            &path,
            &format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"),
        );
        path
    }

    async fn nisse(&self, fake: &Fake) -> Nisse {
        let auth_path = self.home.join("auth/openai.json");
        fake.issue_tokens("first", 3600);
        sign_in(fake, &auth_path).await;
        let workspace = Workspace {
            cwd: self.cwd.clone(),
            home: self.home.clone(),
        };
        Nisse::in_workspace(fake, &auth_path, workspace).await
    }
}

fn sent_instructions(fake: &Fake) -> String {
    fake.received("/codex/responses")[0].json()["instructions"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn sent_input(fake: &Fake, request: usize) -> Value {
    fake.received("/codex/responses")[request].json()["input"].clone()
}

#[tokio::test]
async fn agents_md_files_follow_nisses_instructions_from_the_home_down_to_the_directory() {
    let folders = Folders::new();
    folders.write(&folders.home.join("AGENTS.md"), "Home: answer in English.");
    folders.write(&folders.repo.join("AGENTS.md"), "Repo: run cargo test.");
    folders.write(&folders.repo.join("crates/AGENTS.md"), "Crates: replaced.");
    folders.write(
        &folders.repo.join("crates/AGENTS.override.md"),
        "Crates: the override wins.",
    );
    folders.write(&folders.cwd.join("AGENTS.md"), "App: keep it small.");
    folders.write(
        &folders.repo.parent().unwrap().join("AGENTS.md"),
        "Outside the repository.",
    );
    let fake = Fake::start().await;
    fake.play("text_answer");
    let mut nisse = folders.nisse(&fake).await;

    nisse.converse("hello", true).await;

    let instructions = sent_instructions(&fake);
    let section = |path: PathBuf, text: &str| {
        format!(
            "\n# AGENTS.md instructions from {}\n\n{text}\n",
            path.display()
        )
    };
    assert_eq!(
        instructions,
        [
            format!(
                "{INSTRUCTIONS}\nThe working directory is {}.\n",
                folders.cwd.display()
            ),
            section(folders.home.join("AGENTS.md"), "Home: answer in English."),
            section(folders.repo.join("AGENTS.md"), "Repo: run cargo test."),
            section(
                folders.repo.join("crates/AGENTS.override.md"),
                "Crates: the override wins."
            ),
            section(folders.cwd.join("AGENTS.md"), "App: keep it small."),
        ]
        .concat()
    );
}

#[tokio::test]
async fn agents_md_files_stop_at_32_kib_together() {
    let folders = Folders::new();
    let long = "~".repeat(AGENTS_MD_LIMIT + 100);
    folders.write(&folders.repo.join("AGENTS.md"), &long);
    folders.write(&folders.cwd.join("AGENTS.md"), "Past the limit.");
    let fake = Fake::start().await;
    fake.play("text_answer");
    let mut nisse = folders.nisse(&fake).await;

    nisse.converse("hello", true).await;

    let instructions = sent_instructions(&fake);
    assert_eq!(instructions.matches('~').count(), AGENTS_MD_LIMIT);
    assert!(!instructions.contains("Past the limit."));
}

#[tokio::test]
async fn skills_are_listed_from_agents_and_claude_folders_up_to_the_repository_then_the_home() {
    let folders = Folders::new();
    let review = folders.skill(
        &folders.cwd.join(".claude/skills"),
        "review",
        "Review a change for bugs",
        "Read the diff.",
    );
    let lint = folders.skill(
        &folders.repo.join(".agents/skills"),
        "lint",
        "Lint the repository",
        "Run the linter.",
    );
    folders.skill(
        &folders.home.join("skills"),
        "lint",
        "The home's lint, shadowed by the repository's",
        "Lint differently.",
    );
    let notes = folders.skill(
        &folders.home.join("skills"),
        "notes",
        "\"Keep notes: one file per day\"",
        "Write notes.",
    );
    let fake = Fake::start().await;
    fake.play("text_answer");
    let mut nisse = folders.nisse(&fake).await;

    let listed: SkillsListResult = nisse
        .client
        .request(ClientRequest::SkillsList(SkillsListParams {
            conversation_id: nisse.conversation.id.clone(),
        }))
        .await
        .unwrap();
    nisse.converse("hello", true).await;

    let skill = |name: &str, description: &str, path: &PathBuf| Skill {
        name: name.into(),
        description: description.into(),
        path: path.display().to_string(),
    };
    assert_eq!(
        listed.skills,
        [
            skill("lint", "Lint the repository", &lint),
            skill("notes", "Keep notes: one file per day", &notes),
            skill("review", "Review a change for bugs", &review),
        ]
    );
    let instructions = sent_instructions(&fake);
    for skill in &listed.skills {
        let line = format!(
            "- {}: {} (file: {})\n",
            skill.name, skill.description, skill.path
        );
        assert!(instructions.contains(&line), "{line:?} in {instructions}");
    }
    assert!(!instructions.contains("shadowed"));
}

#[tokio::test]
async fn a_named_skill_is_committed_with_the_input_and_sent_unchanged_after_its_file_changes() {
    let folders = Folders::new();
    let review = folders.skill(
        &folders.repo.join(".claude/skills"),
        "review",
        "Review a change",
        "Read the diff first.",
    );
    let original = std::fs::read_to_string(&review).unwrap();
    let fake = Fake::start().await;
    fake.play("text_answer");
    fake.play("text_answer");
    let mut nisse = folders.nisse(&fake).await;

    let entries = nisse.converse("/review the parser", true).await;
    std::fs::write(&review, "---\nname: review\n---\nChanged since.\n").unwrap();
    nisse.converse("and $review the lexer", true).await;

    let user = entries
        .iter()
        .find(|entry| entry.kind == kinds::USER)
        .unwrap();
    assert_eq!(user.data["text"], "/review the parser");
    assert_eq!(user.data["skills"][0]["name"], "review");
    assert_eq!(user.data["skills"][0]["text"], original);
    let attached = format!(
        "<skill>\n<name>review</name>\n<path>{}</path>\n{}\n</skill>",
        review.display(),
        original.trim_end()
    );
    let content = |input: &Value, message: usize| -> Vec<String> {
        input[message]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part["text"].as_str().unwrap().to_owned())
            .collect()
    };
    let first = sent_input(&fake, 0);
    assert_eq!(
        content(&first, 0),
        ["/review the parser", attached.as_str()]
    );
    let second = sent_input(&fake, 1);
    assert_eq!(
        content(&second, 0),
        ["/review the parser", attached.as_str()]
    );
    let changed = format!(
        "<skill>\n<name>review</name>\n<path>{}</path>\n---\nname: review\n---\nChanged since.\n</skill>",
        review.display()
    );
    assert_eq!(
        content(&second, 2),
        ["and $review the lexer", changed.as_str()]
    );
}

#[tokio::test]
async fn input_that_names_no_known_skill_goes_as_typed() {
    let folders = Folders::new();
    let fake = Fake::start().await;
    fake.play("text_answer");
    let mut nisse = folders.nisse(&fake).await;

    let entries = nisse.converse("/usr/bin costs $5", true).await;

    let user = entries
        .iter()
        .find(|entry| entry.kind == kinds::USER)
        .unwrap();
    assert!(user.data.get("skills").is_none());
    assert_eq!(
        sent_input(&fake, 0)[0]["content"].as_array().unwrap().len(),
        1
    );
}
