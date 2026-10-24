use std::{
    io::{ErrorKind, Read},
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

use rustix::{
    io::Errno,
    process::{Pid, Signal, WaitId, WaitIdOptions, kill_process_group, waitid},
};
use serde::Deserialize;

use super::ToolOutcome;

const OUTPUT_LIMIT: usize = 16 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
const GRACE: Duration = Duration::from_secs(1);

#[derive(Deserialize)]
pub struct Bash {
    command: String,
    timeout: Option<u64>,
}

enum Event {
    Exited,
    OutputClosed,
}

#[derive(Default)]
struct Tail {
    kept: Vec<u8>,
    cut: usize,
}

impl Tail {
    fn push(&mut self, bytes: &[u8]) {
        self.kept.extend_from_slice(bytes);
        if self.kept.len() > 2 * OUTPUT_LIMIT {
            self.trim();
        }
    }

    fn trim(&mut self) {
        let excess = self.kept.len().saturating_sub(OUTPUT_LIMIT);
        self.kept.drain(..excess);
        self.cut += excess;
    }

    fn text(&mut self) -> String {
        self.trim();
        let text = String::from_utf8_lossy(&self.kept).into_owned();
        match self.cut {
            0 => text,
            cut => format!("[{cut} bytes cut]\n{text}"),
        }
    }
}

/// Ends when the shell exits, with the output written so far; processes it left running keep running.
/// On a timeout, kills the command's process group: the command and what it started, nothing else.
pub fn bash(cwd: &Path, args: Bash) -> ToolOutcome {
    let timeout_ms = args
        .timeout
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let (mut reader, writer) = match std::io::pipe() {
        Ok(pipe) => pipe,
        Err(error) => return ToolOutcome::error(format!("could not open a pipe: {error}")),
    };
    let spawned = writer.try_clone().and_then(|stderr| {
        Command::new("sh")
            .arg("-c")
            .arg(&args.command)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(stderr)
            .process_group(0)
            .spawn()
    });
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return ToolOutcome::error(format!("could not run sh: {error}")),
    };
    let leader = Pid::from_child(&child);

    let (events, event) = mpsc::channel();
    let tail = Arc::new(Mutex::new(Tail::default()));
    {
        let tail = tail.clone();
        let events = events.clone();
        std::thread::spawn(move || {
            let mut chunk = [0; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => tail.lock().expect("tail lock").push(&chunk[..read]),
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            let _ = events.send(Event::OutputClosed);
        });
    }
    std::thread::spawn(move || {
        let options = WaitIdOptions::EXITED | WaitIdOptions::NOWAIT;
        while let Err(Errno::INTR) = waitid(WaitId::Pid(leader), options) {}
        let _ = events.send(Event::Exited);
    });

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut closed = false;
    let mut timed_out = false;
    loop {
        let wait = match timed_out {
            false => deadline.saturating_duration_since(Instant::now()),
            true => GRACE,
        };
        match event.recv_timeout(wait) {
            Ok(Event::Exited) => break,
            Ok(Event::OutputClosed) => closed = true,
            Err(mpsc::RecvTimeoutError::Timeout) if !timed_out => {
                timed_out = true;
                let _ = kill_process_group(leader, Signal::KILL);
            }
            Err(_) => break,
        }
    }
    if !closed {
        let _ = event.recv_timeout(GRACE);
    }
    let status = child.wait();
    let mut output = tail.lock().expect("tail lock").text();
    if timed_out {
        output.push_str(&format!(
            "\n[timed out after {timeout_ms} ms; the command and its processes were killed]"
        ));
    }
    ToolOutcome {
        output,
        is_error: timed_out || !status.is_ok_and(|status| status.success()),
        denied: None,
    }
}
