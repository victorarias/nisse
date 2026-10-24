use std::{
    fs::File,
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde::Deserialize;

use super::ToolOutcome;

pub const READ_LINES: usize = 2000;
const READ_BYTES: usize = 64 * 1024;
const LINE_BYTES: usize = 2000;

#[derive(Deserialize)]
pub struct Read {
    file_path: PathBuf,
    offset: Option<usize>,
    limit: Option<usize>,
}

pub fn read(cwd: &Path, args: Read) -> ToolOutcome {
    let path = args.file_path.display();
    let file_path = cwd.join(&args.file_path);
    if file_path.is_dir() {
        return ToolOutcome::error(format!(
            "{path} is a directory; use Grep or Bash to list it"
        ));
    }
    let file = match File::open(&file_path) {
        Ok(file) => file,
        Err(error) => return ToolOutcome::error(format!("could not open {path}: {error}")),
    };
    let first = args.offset.unwrap_or(1).max(1);
    let limit = args.limit.unwrap_or(READ_LINES).clamp(1, READ_LINES);
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut output = String::new();
    let mut number = 0;
    let mut shown = 0;
    loop {
        let cut = match next_line(&mut reader, LINE_BYTES, &mut line) {
            Ok(Some(cut)) => cut,
            Ok(None) => break,
            Err(error) => return ToolOutcome::error(format!("could not read {path}: {error}")),
        };
        number += 1;
        if number < first {
            continue;
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\n', '\r']);
        output.push_str(&format!("{number:>6}\t{text}"));
        if cut {
            output.push_str(" [line cut]");
        }
        output.push('\n');
        shown += 1;
        if shown == limit || output.len() >= READ_BYTES {
            if reader.fill_buf().is_ok_and(|rest| !rest.is_empty()) {
                output.push_str(&format!(
                    "[more lines follow; continue with offset {}]\n",
                    number + 1
                ));
            }
            return ToolOutcome::ok(output);
        }
    }
    match (number, shown) {
        (0, _) => ToolOutcome::ok("(empty file)"),
        (_, 0) => ToolOutcome::error(format!(
            "offset {first} is past the end of {path}, which has {number} lines"
        )),
        _ => ToolOutcome::ok(output),
    }
}

/// Reads the next line, newline included, into `line`, keeping at most `keep` bytes of it.
/// Returns whether the line was cut, or `None` at the end of the input.
pub fn next_line(
    reader: &mut impl BufRead,
    keep: usize,
    line: &mut Vec<u8>,
) -> io::Result<Option<bool>> {
    line.clear();
    let mut cut = false;
    let mut any = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(any.then_some(cut));
        }
        any = true;
        let (taken, ended) = match available.iter().position(|&byte| byte == b'\n') {
            Some(newline) => (newline + 1, true),
            None => (available.len(), false),
        };
        let room = keep.saturating_sub(line.len());
        line.extend_from_slice(&available[..taken.min(room)]);
        cut |= taken > room;
        reader.consume(taken);
        if ended {
            return Ok(Some(cut));
        }
    }
}

#[derive(Deserialize)]
pub struct Write {
    file_path: PathBuf,
    content: String,
}

pub fn write(cwd: &Path, args: Write) -> ToolOutcome {
    let path = args.file_path.display();
    let file_path = cwd.join(&args.file_path);
    if let Some(parent) = file_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        return ToolOutcome::error(format!("could not create {}: {error}", parent.display()));
    }
    match std::fs::write(&file_path, &args.content) {
        Ok(()) => ToolOutcome::ok(format!("Wrote {} bytes to {path}.", args.content.len())),
        Err(error) => ToolOutcome::error(format!("could not write {path}: {error}")),
    }
}
