use std::path::{Path, PathBuf};

use nisse_protocol::Skill;
use serde::{Deserialize, Serialize};

/// Codex's limit for the AGENTS.md files of one conversation, together.
pub const AGENTS_MD_LIMIT: usize = 32 * 1024;

/// Where a conversation's instructions and skills come from: its directory, the repository
/// around it, and the Nisse home.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub cwd: PathBuf,
    pub home: PathBuf,
}

/// One AGENTS.md file, as the model is given it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentsMd {
    pub path: PathBuf,
    pub text: String,
}

/// A skill's `SKILL.md` as it was when a person named it, committed with their input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachedSkill {
    pub name: String,
    pub path: String,
    pub text: String,
}

impl Workspace {
    /// `NISSE_HOME/AGENTS.md`, then each folder's `AGENTS.override.md` or else `AGENTS.md`, from
    /// the repository root down to the directory, cut off once they reach `AGENTS_MD_LIMIT`.
    pub fn agents_md(&self) -> Vec<AgentsMd> {
        let project = self.project_dirs().into_iter().map(|dir| {
            let override_file = dir.join("AGENTS.override.md");
            if override_file.is_file() {
                override_file
            } else {
                dir.join("AGENTS.md")
            }
        });
        let mut room = AGENTS_MD_LIMIT;
        let mut files = Vec::new();
        for path in std::iter::once(self.home.join("AGENTS.md")).chain(project) {
            if room == 0 {
                break;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            let kept = text.floor_char_boundary(room);
            room -= kept;
            files.push(AgentsMd {
                path,
                text: text[..kept].to_owned(),
            });
        }
        files
    }

    /// The skills in `.agents/skills/` and `.claude/skills/`, from the directory up to the
    /// repository root, then in `NISSE_HOME/skills/`, by name. Of two with one name, the one
    /// nearer the directory wins.
    pub fn skills(&self) -> Vec<Skill> {
        let project = self
            .project_dirs()
            .into_iter()
            .rev()
            .flat_map(|dir| [dir.join(".agents/skills"), dir.join(".claude/skills")]);
        let mut skills: Vec<Skill> = Vec::new();
        for root in project.chain([self.home.join("skills")]) {
            let Ok(folders) = std::fs::read_dir(&root) else {
                continue;
            };
            for folder in folders.flatten() {
                let Some(skill) = read_skill(&folder.path()) else {
                    continue;
                };
                if skills.iter().all(|known| known.name != skill.name) {
                    skills.push(skill);
                }
            }
        }
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        skills
    }

    /// The folders from the repository root down to the directory; only the directory when it
    /// is in no repository.
    fn project_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        for dir in self.cwd.ancestors() {
            dirs.push(dir.to_owned());
            if dir.join(".git").exists() {
                dirs.reverse();
                return dirs;
            }
        }
        vec![self.cwd.clone()]
    }
}

/// The skills `text` names, each once: `/name` at its start, as in Claude Code, and `$name`
/// anywhere, as in Codex.
pub fn named_skills<'a>(text: &str, skills: &'a [Skill]) -> Vec<&'a Skill> {
    let text = text.trim_start();
    let slash = text.strip_prefix('/').map(skill_name);
    let dollars = text
        .match_indices('$')
        .map(|(at, _)| skill_name(&text[at + 1..]));
    let mut named: Vec<&Skill> = Vec::new();
    for name in slash.into_iter().chain(dollars) {
        if let Some(skill) = skills.iter().find(|skill| skill.name == name)
            && !named.contains(&skill)
        {
            named.push(skill);
        }
    }
    named
}

pub fn attach(skill: &Skill) -> Option<AttachedSkill> {
    Some(AttachedSkill {
        name: skill.name.clone(),
        path: skill.path.clone(),
        text: std::fs::read_to_string(&skill.path).ok()?,
    })
}

fn skill_name(text: &str) -> &str {
    let end = text
        .find(|char: char| !(char.is_alphanumeric() || "-_.:".contains(char)))
        .unwrap_or(text.len());
    text[..end].trim_end_matches(['.', ':'])
}

fn read_skill(folder: &Path) -> Option<Skill> {
    let path = folder.join("SKILL.md");
    let text = std::fs::read_to_string(&path).ok()?;
    let fields = frontmatter(&text);
    let field = |key: &str| {
        fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    let name = field("name")
        .filter(|name| !name.is_empty())
        .or_else(|| Some(folder.file_name()?.to_string_lossy().into_owned()))?;
    Some(Skill {
        name,
        description: field("description").unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// The top-level `key: value` pairs of a YAML frontmatter block. A value may be quoted, or
/// continue on indented lines, as a `|` or `>` block does; its lines are joined with spaces.
fn frontmatter(text: &str) -> Vec<(String, String)> {
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Vec::new();
    }
    let mut fields: Vec<(String, String)> = Vec::new();
    for line in lines.take_while(|line| line.trim_end() != "---") {
        if line.starts_with([' ', '\t']) {
            if let Some((_, value)) = fields.last_mut() {
                let more = line.trim();
                if !value.is_empty() && !more.is_empty() {
                    value.push(' ');
                }
                value.push_str(more);
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let value = match value {
            "|" | ">" | "|-" | ">-" | "|+" | ">+" => "",
            quoted
                if quoted.len() >= 2
                    && (quoted.starts_with('"') && quoted.ends_with('"')
                        || quoted.starts_with('\'') && quoted.ends_with('\'')) =>
            {
                &quoted[1..quoted.len() - 1]
            }
            plain => plain,
        };
        fields.push((key.trim().to_owned(), value.to_owned()));
    }
    fields
}
