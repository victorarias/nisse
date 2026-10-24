//! Codex's patch format: `*** Begin Patch`, then files to add, delete or update, each update a
//! series of `@@` chunks of context, `-` and `+` lines, then `*** End Patch`.

use std::path::Path;

use nisse_core::ToolOutcome;

enum Change {
    Add {
        path: String,
        content: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        chunks: Vec<Chunk>,
    },
}

#[derive(Default)]
struct Chunk {
    context: Option<String>,
    old: Vec<String>,
    new: Vec<String>,
    at_end: bool,
}

pub fn apply_patch(cwd: &Path, patch: &str) -> ToolOutcome {
    let changes = match parse(patch) {
        Ok(changes) => changes,
        Err(error) => return ToolOutcome::error(format!("invalid patch: {error}")),
    };
    let mut summary = vec!["Success. Updated the following files:".to_owned()];
    for change in changes {
        match apply(cwd, &change) {
            Ok(line) => summary.push(line),
            Err(error) => return ToolOutcome::error(error),
        }
    }
    ToolOutcome::ok(summary.join("\n"))
}

fn parse(patch: &str) -> Result<Vec<Change>, String> {
    let lines: Vec<&str> = patch.trim().lines().collect();
    let (Some(&"*** Begin Patch"), Some(&"*** End Patch")) = (
        lines.first().map(|line| line.trim()).as_ref(),
        lines.last().map(|line| line.trim()).as_ref(),
    ) else {
        return Err("a patch starts with `*** Begin Patch` and ends with `*** End Patch`".into());
    };
    let mut body = lines[1..lines.len() - 1].iter().peekable();
    let mut changes = Vec::new();
    while let Some(line) = body.next() {
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let mut content = String::new();
            while let Some(added) = body.peek().and_then(|line| line.strip_prefix('+')) {
                content.push_str(added);
                content.push('\n');
                body.next();
            }
            changes.push(Change::Add {
                path: path.trim().into(),
                content,
            });
        } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
            changes.push(Change::Delete {
                path: path.trim().into(),
            });
        } else if let Some(path) = line.strip_prefix("*** Update File: ") {
            let move_to = body
                .next_if(|line| line.starts_with("*** Move to: "))
                .map(|line| line["*** Move to: ".len()..].trim().to_owned());
            let mut chunks: Vec<Chunk> = Vec::new();
            while let Some(line) =
                body.next_if(|line| !line.starts_with("*** ") || *line == &"*** End of File")
            {
                if *line == "*** End of File" {
                    if let Some(chunk) = chunks.last_mut() {
                        chunk.at_end = true;
                    }
                    continue;
                }
                if let Some(context) = line.strip_prefix("@@") {
                    let context = context.trim();
                    chunks.push(Chunk {
                        context: (!context.is_empty()).then(|| context.to_owned()),
                        ..Chunk::default()
                    });
                    continue;
                }
                if chunks.is_empty() {
                    chunks.push(Chunk::default());
                }
                let chunk = chunks.last_mut().expect("a chunk");
                match line.split_at_checked(1) {
                    Some(("+", added)) => chunk.new.push(added.into()),
                    Some(("-", removed)) => chunk.old.push(removed.into()),
                    Some((" ", kept)) => {
                        chunk.old.push(kept.into());
                        chunk.new.push(kept.into());
                    }
                    None => {
                        chunk.old.push(String::new());
                        chunk.new.push(String::new());
                    }
                    Some(_) => return Err(format!("unexpected line in {path}: {line}")),
                }
            }
            if chunks.is_empty() {
                return Err(format!("the update of {path} changes nothing"));
            }
            changes.push(Change::Update {
                path: path.trim().into(),
                move_to,
                chunks,
            });
        } else if !line.trim().is_empty() {
            return Err(format!("unexpected line: {line}"));
        }
    }
    Ok(changes)
}

fn apply(cwd: &Path, change: &Change) -> Result<String, String> {
    let failed = |path: &str, error: std::io::Error| format!("could not change {path}: {error}");
    let at = |path: &str| cwd.join(path);
    match change {
        Change::Add { path, content } => {
            if let Some(parent) = at(path).parent() {
                std::fs::create_dir_all(parent).map_err(|error| failed(path, error))?;
            }
            std::fs::write(at(path), content).map_err(|error| failed(path, error))?;
            Ok(format!("A {path}"))
        }
        Change::Delete { path } => {
            std::fs::remove_file(at(path)).map_err(|error| failed(path, error))?;
            Ok(format!("D {path}"))
        }
        Change::Update {
            path,
            move_to,
            chunks,
        } => {
            let original =
                std::fs::read_to_string(at(path)).map_err(|error| failed(path, error))?;
            let updated = updated(&original, chunks).map_err(|error| format!("{path}: {error}"))?;
            let target = move_to.as_deref().unwrap_or(path);
            if let Some(parent) = at(target).parent() {
                std::fs::create_dir_all(parent).map_err(|error| failed(target, error))?;
            }
            std::fs::write(at(target), updated).map_err(|error| failed(target, error))?;
            if target != path {
                std::fs::remove_file(at(path)).map_err(|error| failed(path, error))?;
            }
            Ok(format!("M {target}"))
        }
    }
}

fn updated(original: &str, chunks: &[Chunk]) -> Result<String, String> {
    let mut lines: Vec<String> = original.lines().map(str::to_owned).collect();
    let mut replacements: Vec<(usize, usize, &[String])> = Vec::new();
    let mut from = 0;
    for chunk in chunks {
        if let Some(context) = &chunk.context {
            let found = seek(&lines, std::slice::from_ref(context), from, false)
                .ok_or_else(|| format!("could not find the context `{context}`"))?;
            from = found + 1;
        }
        if chunk.old.is_empty() {
            replacements.push((lines.len(), 0, &chunk.new));
            continue;
        }
        let found = seek(&lines, &chunk.old, from, chunk.at_end).ok_or_else(|| {
            format!(
                "could not find the lines to change:\n{}",
                chunk.old.join("\n")
            )
        })?;
        replacements.push((found, chunk.old.len(), &chunk.new));
        from = found + chunk.old.len();
    }
    replacements.sort_by_key(|(at, _, _)| *at);
    for (at, removed, added) in replacements.into_iter().rev() {
        lines.splice(at..at + removed, added.iter().cloned());
    }
    let mut text = lines.join("\n");
    text.push('\n');
    Ok(text)
}

/// Where `wanted` starts in `lines` at or after `from`, comparing exactly, then ignoring
/// trailing whitespace, then ignoring surrounding whitespace.
fn seek(lines: &[String], wanted: &[String], from: usize, at_end: bool) -> Option<usize> {
    if wanted.len() > lines.len() {
        return None;
    }
    let last = lines.len() - wanted.len();
    let starts: Vec<usize> = match at_end {
        true => vec![last],
        false => (from.min(last + 1)..=last).collect(),
    };
    let comparisons: [fn(&str, &str) -> bool; 3] = [
        |a, b| a == b,
        |a, b| a.trim_end() == b.trim_end(),
        |a, b| a.trim() == b.trim(),
    ];
    comparisons.into_iter().find_map(|same| {
        starts.iter().copied().find(|&start| {
            wanted
                .iter()
                .zip(&lines[start..])
                .all(|(wanted, line)| same(line, wanted))
        })
    })
}
