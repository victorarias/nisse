use std::{
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use rustix::process::{Pid, Signal, kill_process_group};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdin, ChildStdout},
    sync::mpsc,
};

use crate::record::Recorder;

const STDERR_TAIL: usize = 4096;
const INBOUND_BACKLOG: usize = 256;
const EXIT_PATIENCE: Duration = Duration::from_secs(2);
const EXIT_POLL: Duration = Duration::from_millis(50);
const STOP_PATIENCE: Duration = Duration::from_secs(5);

/// Variables through which a Claude Code session hands its own identity to the processes it
/// starts. A claude that inherits them joins its parent's session instead of keeping its own.
const PARENT_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
    "CLAUDE_CODE_PROJECTS_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_DIAGNOSTICS_FILE",
    "CLAUDE_CODE_TEE_SDK_STDOUT",
    "CLAUDE_CODE_SYNC_SESSION_REFS",
    "CLAUDE_AFTER_LAST_COMPACT",
    "CLAUDE_PID",
];

/// One claude process in its own process group. Dropping it stops claude with SIGTERM, which
/// lets it stop the tools it runs in groups of their own, and kills the group if claude has not
/// exited by `STOP_PATIENCE`. The process is reaped only here, so its pid stays ours until then.
pub(crate) struct Process {
    child: Option<Child>,
    pub(crate) inbound: mpsc::Receiver<Value>,
    pub(crate) outbound: mpsc::UnboundedSender<Value>,
    stderr: Arc<Mutex<String>>,
}

impl Process {
    pub(crate) fn spawn(
        binary: &Path,
        cwd: &Path,
        args: &[String],
        recorder: Option<Arc<Recorder>>,
    ) -> Result<Self> {
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        for name in PARENT_SESSION_VARS {
            command.env_remove(name);
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("could not start {}", binary.display()))?;
        let pipes = (|| -> Result<_> {
            Ok((
                ChildStdin::from_std(child.stdin.take().context("claude has no stdin")?)?,
                ChildStdout::from_std(child.stdout.take().context("claude has no stdout")?)?,
                ChildStderr::from_std(child.stderr.take().context("claude has no stderr")?)?,
            ))
        })();
        let (stdin, stdout, stderr_pipe) = match pipes {
            Ok(pipes) => pipes,
            Err(error) => {
                stop(child);
                return Err(error);
            }
        };

        let (outbound, writes) = mpsc::unbounded_channel();
        tokio::spawn(write_frames(stdin, writes, recorder.clone()));
        let (frames, inbound) = mpsc::channel(INBOUND_BACKLOG);
        tokio::spawn(read_frames(stdout, frames, recorder));
        let stderr = Arc::new(Mutex::new(String::new()));
        tokio::spawn(keep_stderr_tail(stderr_pipe, stderr.clone()));

        Ok(Self {
            child: Some(child),
            inbound,
            outbound,
            stderr,
        })
    }

    pub(crate) fn send(&self, frame: Value) {
        let _ = self.outbound.send(frame);
    }

    pub(crate) fn has_exited(&mut self) -> bool {
        let exited = self
            .child
            .as_mut()
            .is_none_or(|child| !matches!(child.try_wait(), Ok(None)));
        exited || self.inbound.is_closed()
    }

    /// Why the process stopped answering, for the model error a person sees.
    pub(crate) async fn exit_reason(&mut self) -> String {
        let deadline = Instant::now() + EXIT_PATIENCE;
        let mut status = None;
        while let Some(child) = self.child.as_mut() {
            status = child.try_wait().ok().flatten();
            if status.is_some() || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(EXIT_POLL).await;
        }
        let status = status.map_or_else(
            || "it closed its output".to_owned(),
            |status| status.to_string(),
        );
        let stderr = self.stderr.lock().expect("stderr lock").trim().to_owned();
        if stderr.is_empty() {
            format!("claude stopped ({status})")
        } else {
            format!("claude stopped ({status}): {stderr}")
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            stop(child);
        }
    }
}

fn stop(mut child: Child) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    let group = Pid::from_child(&child);
    let _ = kill_process_group(group, Signal::TERM);
    std::thread::spawn(move || {
        let deadline = Instant::now() + STOP_PATIENCE;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(EXIT_POLL);
        }
        let _ = kill_process_group(group, Signal::KILL);
        let _ = child.kill();
        let _ = child.wait();
    });
}

async fn write_frames(
    mut stdin: ChildStdin,
    mut writes: mpsc::UnboundedReceiver<Value>,
    recorder: Option<Arc<Recorder>>,
) {
    while let Some(frame) = writes.recv().await {
        if let Some(recorder) = &recorder {
            recorder.outbound(&frame);
        }
        let mut line = frame.to_string();
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

async fn read_frames(
    stdout: ChildStdout,
    frames: mpsc::Sender<Value>,
    recorder: Option<Arc<Recorder>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(recorder) = &recorder {
            recorder.inbound(&frame);
        }
        if frames.send(frame).await.is_err() {
            return;
        }
    }
}

async fn keep_stderr_tail(mut stderr: ChildStderr, tail: Arc<Mutex<String>>) {
    let mut chunk = [0u8; 1024];
    while let Ok(read) = stderr.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        let mut tail = tail.lock().expect("stderr lock");
        tail.push_str(&String::from_utf8_lossy(&chunk[..read]));
        if tail.len() > STDERR_TAIL {
            let cut = tail.ceil_char_boundary(tail.len() - STDERR_TAIL);
            tail.drain(..cut);
        }
    }
}
