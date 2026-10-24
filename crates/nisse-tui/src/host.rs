use std::{
    collections::BTreeMap,
    future::Future,
    process::{Command, Stdio},
};

use crossterm::event::{Event, EventStream};
use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};

/// The terminal the TUI runs in, beyond what it draws there.
pub trait Host: Send {
    /// The next key or other event; `None` once the terminal is gone.
    fn next_event(&mut self) -> impl Future<Output = Option<Event>> + Send;

    /// Hands the terminal to `command` until it exits; true when it succeeded.
    fn foreground(
        &mut self,
        command: &[String],
        env: &BTreeMap<String, String>,
    ) -> impl Future<Output = bool> + Send;

    /// Opens `url` in a browser, when there is one to open.
    fn open(&mut self, url: &str);

    /// Whether the person sits at another machine, as over SSH, so a browser there can't call
    /// back to this one.
    fn is_remote(&self) -> bool;
}

/// The process's own terminal.
pub(crate) struct Tty {
    events: mpsc::UnboundedReceiver<Event>,
    pauses: mpsc::UnboundedSender<Pause>,
}

/// Asks the key reader to let go of the terminal: it answers on the first sender once it has,
/// and reads again once the second channel fires.
type Pause = (oneshot::Sender<()>, oneshot::Receiver<()>);

impl Tty {
    pub(crate) fn new() -> Self {
        let (keys, events) = mpsc::unbounded_channel();
        let (pauses, paused) = mpsc::unbounded_channel();
        tokio::spawn(read_events(keys, paused));
        Self { events, pauses }
    }
}

async fn read_events(
    keys: mpsc::UnboundedSender<Event>,
    mut pauses: mpsc::UnboundedReceiver<Pause>,
) {
    loop {
        let mut events = EventStream::new();
        let (released, resume) = loop {
            tokio::select! {
                event = events.next() => match event {
                    Some(Ok(event)) => {
                        if keys.send(event).is_err() {
                            return;
                        }
                    }
                    Some(Err(_)) | None => return,
                },
                pause = pauses.recv() => match pause {
                    Some(pause) => break pause,
                    None => return,
                },
            }
        };
        drop(events);
        let _ = released.send(());
        if resume.await.is_err() {
            return;
        }
    }
}

impl Host for Tty {
    async fn next_event(&mut self) -> Option<Event> {
        self.events.recv().await
    }

    async fn foreground(&mut self, command: &[String], env: &BTreeMap<String, String>) -> bool {
        let Some((program, args)) = command.split_first() else {
            return false;
        };
        let (released, let_go) = oneshot::channel();
        let (resume, resumed) = oneshot::channel();
        if self.pauses.send((released, resumed)).is_err() || let_go.await.is_err() {
            return false;
        }
        ratatui::restore();
        let succeeded = tokio::process::Command::new(program)
            .args(args)
            .envs(env)
            .status()
            .await
            .is_ok_and(|status| status.success());
        let _ = crossterm::terminal::enable_raw_mode();
        let _ = crossterm::execute!(std::io::stdout(), crossterm::terminal::EnterAlternateScreen);
        let _ = resume.send(());
        succeeded
    }

    fn open(&mut self, url: &str) {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        let opened = Command::new(opener)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut opener) = opened {
            std::thread::spawn(move || opener.wait());
        }
    }

    fn is_remote(&self) -> bool {
        std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some()
    }
}
