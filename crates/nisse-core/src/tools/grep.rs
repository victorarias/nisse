use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use globset::GlobMatcher;
use regex::bytes::Regex;
use serde::Deserialize;

use super::{ToolOutcome, files::next_line};

const MATCH_LIMIT: usize = 200;
const LINE_CHARS: usize = 300;
const SCANNED_LINE_BYTES: usize = 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8192;

#[derive(Deserialize)]
pub struct Grep {
    pattern: String,
    path: Option<PathBuf>,
    glob: Option<String>,
}

struct Matches {
    lines: Vec<String>,
    more: bool,
}

impl Matches {
    fn new() -> Self {
        Self {
            lines: Vec::new(),
            more: false,
        }
    }

    fn add(&mut self, line: String) -> bool {
        self.more = self.lines.len() == MATCH_LIMIT;
        if !self.more {
            self.lines.push(line);
        }
        !self.more
    }

    fn report(self) -> ToolOutcome {
        if self.lines.is_empty() {
            return ToolOutcome::ok("No matches.");
        }
        let mut output = self.lines.join("\n");
        if self.more {
            output.push_str(&format!(
                "\n[stopped after {MATCH_LIMIT} matches; narrow the pattern, path or glob]"
            ));
        }
        ToolOutcome::ok(output)
    }
}

pub fn grep(args: Grep) -> ToolOutcome {
    let regex = match Regex::new(&args.pattern) {
        Ok(regex) => regex,
        Err(error) => return ToolOutcome::error(format!("invalid pattern: {error}")),
    };
    let glob = match args.glob.as_deref().map(globset::Glob::new).transpose() {
        Ok(glob) => glob.map(|glob| glob.compile_matcher()),
        Err(error) => return ToolOutcome::error(format!("invalid glob: {error}")),
    };
    let named = args.path.is_some();
    let root = args.path.unwrap_or_else(|| PathBuf::from("."));
    if !root.exists() {
        return ToolOutcome::error(format!("{} does not exist", root.display()));
    }
    match ripgrep() {
        Some(rg) => with_ripgrep(&rg, &args.pattern, args.glob.as_deref(), &root, named),
        None => walk(&regex, glob.as_ref(), &root, named),
    }
}

fn ripgrep() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join("rg"))
        .find(|rg| rg.is_file())
}

fn with_ripgrep(
    rg: &Path,
    pattern: &str,
    glob: Option<&str>,
    root: &Path,
    named: bool,
) -> ToolOutcome {
    let mut command = Command::new(rg);
    command.args([
        "--line-number",
        "--no-heading",
        "--with-filename",
        "--color=never",
        "--no-messages",
        "--sort=path",
        "--max-columns-preview",
    ]);
    command.arg(format!("--max-columns={LINE_CHARS}"));
    command.arg("--regexp").arg(pattern);
    if let Some(glob) = glob {
        command.arg("--glob").arg(glob);
    }
    command.arg("--").arg(root);
    let mut child = match command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return ToolOutcome::error(format!("could not run rg: {error}")),
    };
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut matches = Matches::new();
    let mut line = Vec::new();
    while let Ok(Some(_)) = next_line(&mut stdout, SCANNED_LINE_BYTES, &mut line) {
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\n', '\r']);
        let text = match named {
            true => text,
            false => text.strip_prefix("./").unwrap_or(text),
        };
        if !matches.add(text.to_owned()) {
            break;
        }
    }
    if matches.more {
        let _ = child.kill();
    }
    let status = child.wait();
    if matches.lines.is_empty() && status.is_ok_and(|status| status.code() == Some(2)) {
        return ToolOutcome::error(format!("rg could not search {}", root.display()));
    }
    matches.report()
}

fn walk(regex: &Regex, glob: Option<&GlobMatcher>, root: &Path, named: bool) -> ToolOutcome {
    let shown = |path: &Path| match named {
        true => path.display().to_string(),
        false => path
            .strip_prefix(root)
            .unwrap_or(path)
            .display()
            .to_string(),
    };
    let wanted = |path: &Path| {
        path == root
            || glob.is_none_or(|glob| {
                glob.is_match(path.strip_prefix(root).unwrap_or(path))
                    || path.file_name().is_some_and(|name| glob.is_match(name))
            })
    };
    let mut matches = Matches::new();
    let Ok(root_kind) = std::fs::metadata(root).map(|metadata| metadata.file_type()) else {
        return matches.report();
    };
    let mut pending = vec![(root.to_path_buf(), root_kind)];
    while let Some((path, kind)) = pending.pop() {
        if kind.is_file() && wanted(&path) {
            search(regex, &path, &shown(&path), &mut matches);
            if matches.more {
                break;
            }
        }
        if !kind.is_dir() {
            continue;
        }
        let Ok(listing) = std::fs::read_dir(&path) else {
            continue;
        };
        let mut entries: Vec<_> = listing
            .filter_map(Result::ok)
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|entry| Some((entry.path(), entry.file_type().ok()?)))
            .collect();
        entries.sort_by(|(left, _), (right, _)| right.cmp(left));
        pending.extend(entries);
    }
    matches.report()
}

fn search(regex: &Regex, path: &Path, shown: &str, matches: &mut Matches) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut reader = BufReader::with_capacity(BINARY_SNIFF_BYTES, file);
    if reader.fill_buf().is_ok_and(|start| start.contains(&0)) {
        return;
    }
    let mut line = Vec::new();
    let mut number = 0;
    while let Ok(Some(_)) = next_line(&mut reader, SCANNED_LINE_BYTES, &mut line) {
        number += 1;
        if !regex.is_match(&line) {
            continue;
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\n', '\r']);
        let text = match text.char_indices().nth(LINE_CHARS) {
            Some((cut, _)) => format!("{} [line cut]", &text[..cut]),
            None => text.to_owned(),
        };
        if !matches.add(format!("{shown}:{number}:{text}")) {
            return;
        }
    }
}
