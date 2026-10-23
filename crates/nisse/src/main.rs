use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use nisse_claude::{Claude, ClaudeOptions};
use nisse_client::Client;
use nisse_core::{Echo, Harness, HarnessOptions, Provider};
use nisse_lua::LuaHost;
use nisse_openai::{LoginMethod, LoginPrompt, OpenAi, OpenAiOptions};
use nisse_protocol::{Actor, InitializeResult, ServerNotification};
use nisse_server::Server;
use tokio::sync::{broadcast, mpsc};

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
    /// Who answers, when this process runs the server.
    #[arg(long, env = "NISSE_PROVIDER", value_enum, default_value_t = ProviderName::Claude, global = true)]
    provider: ProviderName,
    /// The provider's model; each provider has its own default.
    #[arg(long, env = "NISSE_MODEL", global = true)]
    model: Option<String>,
    /// Save every provider exchange in this folder as a replayable fixture.
    #[arg(long, env = "NISSE_RECORD", global = true)]
    record: Option<PathBuf>,
    /// The `claude` binary to drive.
    #[arg(long, env = "NISSE_CLAUDE", default_value = "claude", global = true)]
    claude: PathBuf,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the app server.
    Serve {
        /// Serve one client on stdin and stdout.
        #[arg(long)]
        stdio: bool,
    },
    /// Send one prompt and print the run as it commits.
    Exec { prompt: String },
    /// Print the protocol's JSON Schema.
    Schema,
    /// Sign in to a provider.
    Login {
        #[command(subcommand)]
        provider: LoginProvider,
    },
}

#[derive(Subcommand)]
enum LoginProvider {
    /// Sign in with ChatGPT; usage counts against your plan.
    Openai {
        /// Sign in on another device with a code, for a machine without a browser.
        #[arg(long)]
        device: bool,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum ProviderName {
    /// Claude through the Claude Code CLI, with its own tools.
    Claude,
    /// OpenAI through a ChatGPT sign-in (`nisse login openai`).
    Openai,
    /// Echoes input and runs `!command`; for trying Nisse out without a model.
    Echo,
}

struct ServerConfig {
    home: PathBuf,
    provider: ProviderName,
    model: Option<String>,
    record: Option<PathBuf>,
    claude: PathBuf,
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
        provider: cli.provider,
        model: cli.model,
        record: cli.record,
        claude: cli.claude,
    };
    match cli.command {
        Some(Command::Serve { stdio }) => serve(&config, stdio).await,
        Some(Command::Exec { prompt }) => {
            let (client, mut notifications, _, _embedded) = connect(&config, cli.connect).await?;
            nisse::exec(
                &client,
                &mut notifications,
                prompt,
                tokio::io::BufReader::new(tokio::io::stdin()),
                &mut std::io::stdout(),
            )
            .await
        }
        Some(Command::Login {
            provider: LoginProvider::Openai { device },
        }) => {
            std::fs::create_dir_all(&config.home)?;
            let method = if device {
                LoginMethod::DeviceCode
            } else {
                LoginMethod::Browser
            };
            nisse_openai::login(&openai_auth(&config.home), method, |prompt| match prompt {
                LoginPrompt::OpenUrl { url } => {
                    eprintln!(
                        "Open this link in your browser to sign in with ChatGPT:\n\n  {url}\n"
                    )
                }
                LoginPrompt::EnterCode { url, code } => {
                    eprintln!("On any device, open {url} and enter the code {code}\n")
                }
            })
            .await?;
            eprintln!("Signed in. Start Nisse with --provider openai.");
            Ok(())
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
            let (client, notifications, hello, _embedded) = connect(&config, cli.connect).await?;
            nisse_tui::run(
                client,
                notifications,
                hello.model,
                cli.conversation,
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

fn openai_auth(home: &std::path::Path) -> PathBuf {
    home.join("auth").join("openai.json")
}

fn provider(config: &ServerConfig) -> Result<Arc<dyn Provider>> {
    let cwd = std::env::current_dir()?;
    Ok(match config.provider {
        ProviderName::Claude => Arc::new(Claude::new(ClaudeOptions {
            binary: config.claude.clone(),
            cwd,
            model: config.model.clone(),
            record: config.record.clone(),
        })),
        ProviderName::Openai => {
            let mut options = OpenAiOptions::new(openai_auth(&config.home), instructions(&cwd));
            if let Some(model) = &config.model {
                options.model.clone_from(model);
            }
            options.record.clone_from(&config.record);
            Arc::new(OpenAi::new(options)?)
        }
        ProviderName::Echo => {
            let think = std::env::var("NISSE_ECHO_THINK_MS")
                .ok()
                .and_then(|ms| ms.parse().ok())
                .unwrap_or(600);
            Arc::new(Echo {
                think: Duration::from_millis(think),
            })
        }
    })
}

fn instructions(cwd: &std::path::Path) -> String {
    format!(
        "{}\nThe working directory is {}.\n",
        include_str!("instructions.md"),
        cwd.display()
    )
}

fn start_server(config: &ServerConfig) -> Result<Arc<Server>> {
    let home = &config.home;
    std::fs::create_dir_all(home).with_context(|| format!("creating {}", home.display()))?;
    let (ui, _) = broadcast::channel(256);
    let sink = ui.clone();
    let roots = [home.join("extensions"), PathBuf::from(".nisse/extensions")];
    let hooks = LuaHost::load(&roots, Arc::new(move |changed| drop(sink.send(changed))))?;
    let harness = Harness::open(
        &home.join("nisse.sqlite"),
        HarnessOptions {
            provider: provider(config)?,
            hooks: Arc::new(hooks),
        },
    )?;
    harness.resume()?;
    Ok(Server::new(harness, ui, owner()))
}

async fn serve(config: &ServerConfig, stdio: bool) -> Result<()> {
    let server = start_server(config)?;
    if stdio {
        server.serve_stdio().await;
        return Ok(());
    }
    let socket = config.home.join("nisse.sock");
    let listener = Server::bind_unix(&socket)?;
    eprintln!("nisse: serving on {}", socket.display());
    tokio::select! {
        served = server.serve_unix(listener) => served,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}

/// Attaches to a running server when there is one; otherwise runs one in this process.
async fn connect(
    config: &ServerConfig,
    socket: Option<PathBuf>,
) -> Result<(
    Client,
    mpsc::UnboundedReceiver<ServerNotification>,
    InitializeResult,
    Option<Arc<Server>>,
)> {
    let explicit = socket.is_some();
    let socket = socket.unwrap_or_else(|| config.home.join("nisse.sock"));
    let (client, notifications, server) = match Client::connect_unix(&socket).await {
        Ok((client, notifications)) => (client, notifications, None),
        Err(error) if explicit => return Err(error),
        Err(_) => {
            let server = start_server(config)?;
            let (client, notifications) = Client::new(server.connect_in_process());
            (client, notifications, Some(server))
        }
    };
    let hello = client.initialize("nisse-cli").await?;
    Ok((client, notifications, hello, server))
}
