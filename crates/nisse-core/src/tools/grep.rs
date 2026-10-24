use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use ignore::{
    WalkBuilder,
    overrides::{Override, OverrideBuilder},
};
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

#[derive(Default)]
struct Matches {
    lines: Vec<String>,
    more: bool,
}

impl Matches {
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

/// Walks `path` with ripgrep's walker, honouring `.gitignore` and `.ignore` files even outside
/// a Git repository and skipping hidden and binary files, and searches what is left in path order.
pub fn grep(cwd: &Path, args: Grep) -> ToolOutcome {
    let regex = match Regex::new(&args.pattern) {
        Ok(regex) => regex,
        Err(error) => return ToolOutcome::error(format!("invalid pattern: {error}")),
    };
    let root = match &args.path {
        Some(path) => cwd.join(path),
        None => cwd.to_owned(),
    };
    if !root.exists() {
        let named = args.path.as_deref().unwrap_or(cwd);
        return ToolOutcome::error(format!("{} does not exist", named.display()));
    }
    let only = match only_matching(&root, args.glob.as_deref()) {
        Ok(only) => only,
        Err(error) => return ToolOutcome::error(format!("invalid glob: {error}")),
    };
    let shown = |path: &Path| {
        let below = path.strip_prefix(&root).unwrap_or(path);
        match &args.path {
            Some(named) if below.as_os_str().is_empty() => named.display().to_string(),
            Some(named) => named.join(below).display().to_string(),
            None => below.display().to_string(),
        }
    };
    let mut matches = Matches::default();
    let files = WalkBuilder::new(&root)
        .require_git(false)
        .overrides(only)
        .sort_by_file_name(|left, right| left.cmp(right))
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()));
    for file in files {
        search(&regex, file.path(), &shown(file.path()), &mut matches);
        if matches.more {
            break;
        }
    }
    matches.report()
}

fn only_matching(root: &Path, glob: Option<&str>) -> Result<Override, ignore::Error> {
    let mut only = OverrideBuilder::new(root);
    if let Some(glob) = glob {
        only.add(glob)?;
    }
    only.build()
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
        let content = line.strip_suffix(b"\n").unwrap_or(&line);
        let content = content.strip_suffix(b"\r").unwrap_or(content);
        if !regex.is_match(content) {
            continue;
        }
        let text = String::from_utf8_lossy(content);
        let text = match text.char_indices().nth(LINE_CHARS) {
            Some((cut, _)) => format!("{} [line cut]", &text[..cut]),
            None => text.into_owned(),
        };
        if !matches.add(format!("{shown}:{number}:{text}")) {
            return;
        }
    }
}
