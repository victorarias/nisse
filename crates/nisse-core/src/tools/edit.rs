use std::{fmt, path::PathBuf};

use serde::Deserialize;

use super::ToolOutcome;

#[derive(Deserialize)]
pub struct Edit {
    file_path: PathBuf,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

pub fn edit(args: Edit) -> ToolOutcome {
    let path = args.file_path.display();
    let content = match std::fs::read(&args.file_path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => return ToolOutcome::error(format!("{path} is not UTF-8 text")),
        },
        Err(error) => return ToolOutcome::error(format!("could not read {path}: {error}")),
    };
    let (edited, replaced) = match replace(
        &content,
        &args.old_string,
        &args.new_string,
        args.replace_all,
    ) {
        Ok(done) => done,
        Err(error) => return ToolOutcome::error(format!("{error} in {path}")),
    };
    match std::fs::write(&args.file_path, edited) {
        Ok(()) => ToolOutcome::ok(match replaced {
            1 => format!("Replaced 1 occurrence in {path}."),
            many => format!("Replaced {many} occurrences in {path}."),
        }),
        Err(error) => ToolOutcome::error(format!("could not write {path}: {error}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Refusal {
    EmptyOld,
    Unchanged,
    NotFound,
    NotUnique(usize),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyOld => f.write_str("old_string is empty; give the exact text to replace"),
            Self::Unchanged => f.write_str("old_string and new_string are the same; nothing to do"),
            Self::NotFound => {
                f.write_str("old_string was not found; it must match exactly, whitespace included")
            }
            Self::NotUnique(count) => write!(
                f,
                "old_string appears {count} times; include more surrounding text to pick one, \
                 or set replace_all"
            ),
        }
    }
}

/// Replaces `old` with `new` in `content`, returning the result and how many were replaced.
///
/// `old` must be non-empty and differ from `new`. Matching is exact, byte for byte. Without
/// `replace_all`, `old` must start at exactly one position, counting overlapping occurrences,
/// so that the edit is never ambiguous. With it, every non-overlapping occurrence is replaced,
/// scanning from the start, and there must be at least one.
fn replace(
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<(String, usize), Refusal> {
    if old.is_empty() {
        return Err(Refusal::EmptyOld);
    }
    if old == new {
        return Err(Refusal::Unchanged);
    }
    if replace_all {
        return match content.matches(old).count() {
            0 => Err(Refusal::NotFound),
            count => Ok((content.replace(old, new), count)),
        };
    }
    let step = old.chars().next().map_or(1, char::len_utf8);
    let mut starts = Vec::new();
    let mut from = 0;
    while let Some(found) = content[from..].find(old) {
        starts.push(from + found);
        from += found + step;
    }
    match starts.as_slice() {
        [] => Err(Refusal::NotFound),
        [start] => Ok((
            format!(
                "{}{new}{}",
                &content[..*start],
                &content[start + old.len()..]
            ),
            1,
        )),
        many => Err(Refusal::NotUnique(many.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::{Refusal, replace};

    type Case = (
        &'static str,
        &'static str,
        &'static str,
        bool,
        Result<(&'static str, usize), Refusal>,
    );

    #[test]
    fn edits_follow_the_matching_rules() {
        let cases: &[Case] = &[
            ("a b c", "b", "x", false, Ok(("a x c", 1))),
            ("fn a() {}\n", "fn a", "fn b", false, Ok(("fn b() {}\n", 1))),
            ("  indented", "indented", "moved", false, Ok(("  moved", 1))),
            ("x\n", "x\n", "", false, Ok(("", 1))),
            ("héllo wörld", "ö", "o", false, Ok(("héllo world", 1))),
            ("a b a", "a", "x", false, Err(Refusal::NotUnique(2))),
            ("aaa", "aa", "b", false, Err(Refusal::NotUnique(2))),
            ("aaa", "aa", "b", true, Ok(("ba", 1))),
            ("a b a", "a", "x", true, Ok(("x b x", 2))),
            ("abc", "abd", "x", false, Err(Refusal::NotFound)),
            ("abc", "abd", "x", true, Err(Refusal::NotFound)),
            ("  a", "\ta", "b", false, Err(Refusal::NotFound)),
            ("a\r\nb", "a\nb", "c", false, Err(Refusal::NotFound)),
            ("Abc", "abc", "x", false, Err(Refusal::NotFound)),
            ("abc", "", "x", false, Err(Refusal::EmptyOld)),
            ("abc", "", "x", true, Err(Refusal::EmptyOld)),
            ("abc", "b", "b", false, Err(Refusal::Unchanged)),
            ("", "a", "b", false, Err(Refusal::NotFound)),
        ];
        for (content, old, new, replace_all, expected) in cases {
            assert_eq!(
                replace(content, old, new, *replace_all),
                expected
                    .clone()
                    .map(|(text, count)| (text.to_owned(), count)),
                "replace({content:?}, {old:?}, {new:?}, replace_all: {replace_all})"
            );
        }
    }
}
