mod providers;

use std::{
    fs::File,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use nisse_client::Client;
use nisse_core::{Harness, HarnessOptions, Hooks};
use nisse_lua::LuaHost;
use nisse_openai::NestedTools;
use nisse_protocol::{
    Actor, AuthMethod, ClientRequest, ConversationStartParams, ServerNotification,
    ServerStopParams, ServerStopResult,
};
use nisse_server::Server;
use tokio::sync::{broadcast, mpsc};

/// How long a server with nothing to do waits for a client before it exits.
const IDLE_GRACE: Duration = Duration::from_secs(30);
/// How long a client waits for the server it started to answer.
const STARTUP_PATIENCE: Duration = Duration::from_secs(10);
/// How long an exiting server waits for its clients to take what it already committed.
const CLOSE_PATIENCE: Duration = Duration::from_secs(5);
/// `nisse serve` exits with this when another process already serves the home.
const ALREADY_SERVED: i32 = 75;

#[derive(Parser)]
#[command(name = "nisse", version, about = "A durable, multiplayer coding agent")]
struct Cli {
    /// Where conversations, extensions and the server socket live.
    #[arg(long, env = "NISSE_HOME", global = true)]
    home: Option<PathBuf>,
    /// Attach to a running server's socket instead of looking in the home.
    #[arg(long, global = true)]
    connect: Option<PathBuf>,
    /// Open this conversation instead of starting a new one.
    #[arg(long)]
    conversation: Option<String>,
    /// Who answers a new conversation: `claude` (the default), `openai`, `echo` (which echoes and
    /// runs `!command` without a model), or a provider `NISSE_HOME/config.toml` names.
    #[arg(long, env = "NISSE_PROVIDER", global = true)]
    provider: Option<String>,
    /// The new conversation's model; each provider has its own default.
    #[arg(long, env = "NISSE_MODEL", global = true)]
    model: Option<String>,
    /// Save every provider exchange in this folder as a replayable fixture, when this starts the
    /// server.
    #[arg(long, env = "NISSE_RECORD", global = true)]
    record: Option<PathBuf>,
    /// The `claude` binary to drive, when this starts the server.
    #[arg(long, env = "NISSE_CLAUDE", default_value = "claude", global = true)]
    claude: PathBuf,
    /// Codex's code-mode host, which OpenAI's code-mode models run their scripts in. Default
    /// NISSE_HOME/bin/codex-code-mode-host when it is there, otherwise the one on PATH.
    #[arg(long, env = "NISSE_CODE_MODE_HOST", global = true)]
    code_mode_host: Option<PathBuf>,
    /// The tools a code-mode script calls: `claude-code` (Read, Write, Edit, Bash, Grep) or
    /// `codex` (exec_command, apply_patch).
    #[arg(
        long,
        env = "NISSE_NESTED_TOOLS",
        default_value = "claude-code",
        global = true,
        hide = true
    )]
    nested_tools: NestedTools,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the app server on the home's socket; it exits once no client has needed it for a
    /// while. Clients start one when none runs.
    Serve {
        /// Serve one client on stdin and stdout.
        #[arg(long)]
        stdio: bool,
        /// Replace the running server once its runs settle, such as after an upgrade.
        #[arg(long, conflicts_with = "stdio")]
        restart: bool,
        /// Leave the terminal's session: set by a client that starts the server for itself.
        #[arg(long, hide = true)]
        detached: bool,
    },
    /// Send one prompt and print the run as it commits.
    Exec { prompt: String },
    /// Print the protocol's JSON Schema.
    Schema,
    /// Sign in to a provider: ChatGPT for `openai`, Claude Code's own sign-in for `claude`.
    Login {
        /// The provider, as `nisse providers` lists it.
        provider: String,
        /// Sign in on another device with a code, for a machine without a browser.
        #[arg(long)]
        device: bool,
    },
    /// Sign out of a provider.
    Logout { provider: String },
    /// List the providers and how each stands.
    Providers,
}

struct ServerConfig {
    home: PathBuf,
    record: Option<PathBuf>,
    claude: PathBuf,
    code_mode_host: Option<PathBuf>,
    nested_tools: NestedTools,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = match cli.home {
        Some(home) => home,
        None => PathBuf::from(std::env::var_os("HOME").context("set HOME or NISSE_HOME")?)
            .join(".nisse"),
    };
    let config = ServerConfig {
        home,
        record: cli.record,
        claude: cli.claude,
        code_mode_host: cli.code_mode_host,
        nested_tools: cli.nested_tools,
    };
    let start = ConversationStartParams {
        title: None,
        cwd: std::env::current_dir()?,
        provider: cli.provider,
        model: cli.model,
    };
    match cli.command {
        Some(Command::Serve {
            stdio,
            restart,
            detached,
        }) => serve(&config, stdio, restart, detached).await,
        Some(Command::Exec { prompt }) => {
            let (client, mut notifications, notice) = attach(&config, cli.connect).await?;
            if let Some(notice) = notice {
                eprintln!("nisse: {notice}");
            }
            nisse::exec(
                &client,
                &mut notifications,
                start,
                prompt,
                tokio::io::BufReader::new(tokio::io::stdin()),
                &mut std::io::stdout(),
            )
            .await
        }
        Some(Command::Login { provider, device }) => {
            let (client, mut notifications, _) = attach(&config, cli.connect).await?;
            let method = device.then_some(AuthMethod::DeviceCode);
            nisse::login(&client, &mut notifications, provider, method).await
        }
        Some(Command::Logout { provider }) => {
            let (client, _, _) = attach(&config, cli.connect).await?;
            nisse::logout(&client, provider, &mut std::io::stdout()).await
        }
        Some(Command::Providers) => {
            let (client, _, _) = attach(&config, cli.connect).await?;
            nisse::list_providers(&client, &mut std::io::stdout()).await
        }
        Some(Command::Schema) => {
            let schema = serde_json::json!({
                "message": schemars::schema_for!(nisse_protocol::Message),
                "client_request": schemars::schema_for!(nisse_protocol::ClientRequest),
                "server_notification": schemars::schema_for!(nisse_protocol::ServerNotification),
            });
            println!("{}", serde_json::to_string_pretty(&schema)?);
            Ok(())
        }
        None => {
            let (client, notifications, notice) = attach(&config, cli.connect).await?;
            let open = match cli.conversation {
                Some(id) => nisse_tui::Open::Existing(id),
                None => nisse_tui::Open::New(start),
            };
            nisse_tui::run(
                client,
                notifications,
                open,
                notice,
                nisse_tui::Theme::from_env(),
            )
            .await
        }
    }
}

fn owner() -> Actor {
    let name = std::env::var("USER").unwrap_or_else(|_| "you".into());
    Actor::Person {
        id: "owner".into(),
        name,
    }
}

static HELD_HOME: OnceLock<File> = OnceLock::new();

/// Takes the home for this process, waiting for it when `wait` is set; otherwise only unless
/// another process holds it. One process serves a home's store and runs at a time, and holds
/// it until it exits.
async fn hold_home(home: &Path, wait: bool) -> Result<bool> {
    std::fs::create_dir_all(home).with_context(|| format!("creating {}", home.display()))?;
    let hold = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join("nisse.lock"))?;
    if wait {
        let hold = tokio::task::spawn_blocking(move || hold.lock().map(|()| hold)).await??;
        return Ok(HELD_HOME.set(hold).is_ok());
    }
    match hold.try_lock() {
        Ok(()) => Ok(HELD_HOME.set(hold).is_ok()),
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

fn start_server(config: &ServerConfig) -> Result<Arc<Server>> {
    let home = &config.home;
    let (ui, _) = broadcast::channel(256);
    let sink = ui.clone();
    let extensions = home.join("extensions");
    let hooks = Arc::new(move |cwd: &Path| -> Result<Arc<dyn Hooks>> {
        let sink = sink.clone();
        let roots = [extensions.clone(), cwd.join(".nisse/extensions")];
        Ok(Arc::new(LuaHost::load(
            &roots,
            Arc::new(move |changed| drop(sink.send(changed))),
        )?))
    });
    let harness = Harness::open(
        &home.join("nisse.sqlite"),
        HarnessOptions {
            providers: providers::named(config)?,
            hooks,
        },
    )?;
    harness.resume()?;
    Ok(Server::new(harness, ui, owner()))
}

/// Serves the home on its socket until no client needs it, or one client on stdio. The socket
/// is bound before the server starts, so a client that arrives meanwhile waits for it.
async fn serve(config: &ServerConfig, stdio: bool, restart: bool, detached: bool) -> Result<()> {
    if detached {
        let _ = rustix::process::setsid();
    }
    if restart {
        stop_running(&config.home).await?;
    }
    if !hold_home(&config.home, restart).await? {
        eprintln!(
            "nisse: another nisse already serves {}",
            config.home.display()
        );
        std::process::exit(ALREADY_SERVED);
    }
    if stdio {
        start_server(config)?.serve_stdio().await;
        return Ok(());
    }
    let socket = config.home.join("nisse.sock");
    let listener = Server::bind_unix(&socket)?;
    let server = start_server(config)?;
    eprintln!("nisse: serving on {}", socket.display());
    let grace = std::env::var("NISSE_IDLE_GRACE_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .map_or(IDLE_GRACE, Duration::from_millis);
    tokio::select! {
        served = server.clone().serve_unix(listener) => served,
        () = server.until_idle(grace) => {
            eprintln!("nisse: nothing to do; exiting");
            server.close(CLOSE_PATIENCE).await;
            Ok(())
        }
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}

/// Asks the home's running server to exit once its runs settle. Taking the home afterwards
/// waits for it to have exited.
async fn stop_running(home: &Path) -> Result<()> {
    let Ok((client, _notifications)) = Client::connect_unix(&home.join("nisse.sock")).await else {
        return Ok(());
    };
    client.initialize("nisse-restart").await?;
    let _: ServerStopResult = client
        .request(ClientRequest::ServerStop(ServerStopParams {}))
        .await?;
    eprintln!("nisse: waiting for the running server's work to settle");
    Ok(())
}

/// Attaches to the home's server, starting one when nothing answers on its socket. The notice
/// says when that server is another version than this client.
async fn attach(
    config: &ServerConfig,
    socket: Option<PathBuf>,
) -> Result<(
    Client,
    mpsc::UnboundedReceiver<ServerNotification>,
    Option<String>,
)> {
    let (client, notifications) = match socket {
        Some(socket) => Client::connect_unix(&socket).await?,
        None => {
            let socket = config.home.join("nisse.sock");
            match Client::connect_unix(&socket).await {
                Ok(connected) => connected,
                Err(_) => start_detached(config, &socket).await?,
            }
        }
    };
    let hello = client.initialize("nisse-cli").await?;
    let ours = env!("CARGO_PKG_VERSION");
    let notice = (hello.server.version != ours).then(|| {
        format!(
            "this home is served by nisse {}, and this is {ours}; `nisse serve --restart` \
             switches once its work settles",
            hello.server.version
        )
    });
    Ok((client, notifications, notice))
}

/// Starts `nisse serve` for the home in its own session, logging to `nisse.log`, and connects
/// once it answers. When another client started one at the same moment, the one that took the
/// home serves it and the other exits, so either way this ends up attached to the winner.
async fn start_detached(
    config: &ServerConfig,
    socket: &Path,
) -> Result<(Client, mpsc::UnboundedReceiver<ServerNotification>)> {
    std::fs::create_dir_all(&config.home)
        .with_context(|| format!("creating {}", config.home.display()))?;
    let log_path = config.home.join("nisse.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("opening {}", log_path.display()))?;
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .arg("--home")
        .arg(&config.home)
        .arg("--claude")
        .arg(&config.claude);
    if let Some(record) = &config.record {
        command.arg("--record").arg(record);
    }
    if let Some(host) = &config.code_mode_host {
        command.arg("--code-mode-host").arg(host);
    }
    let nested_tools = match config.nested_tools {
        NestedTools::ClaudeCode => "claude-code",
        NestedTools::Codex => "codex",
    };
    command.args(["--nested-tools", nested_tools]);
    let mut server = command
        .args(["serve", "--detached"])
        .current_dir(&config.home)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
        .context("starting nisse serve")?;
    let deadline = Instant::now() + STARTUP_PATIENCE;
    let mut lost_the_home = false;
    loop {
        match Client::connect_unix(socket).await {
            Ok(connected) => return Ok(connected),
            Err(error) if Instant::now() >= deadline => {
                return Err(error.context(format!(
                    "the server did not answer in time; see {}",
                    log_path.display()
                )));
            }
            Err(_) => {}
        }
        if !lost_the_home && let Some(exited) = server.try_wait()? {
            if exited.code() != Some(ALREADY_SERVED) {
                bail!(
                    "nisse serve exited ({exited}) before it answered; see {}",
                    log_path.display()
                );
            }
            lost_the_home = true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
