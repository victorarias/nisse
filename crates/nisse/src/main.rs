use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use nisse_client::Client;
use nisse_core::{Echo, Harness, HarnessOptions};
use nisse_lua::LuaHost;
use nisse_protocol::{
    Actor, ClientRequest, Conversation, ConversationCreateParams, ConversationReadResult,
    ConversationSubmitParams, ConversationSubmitResult, ConversationSubscribeParams, Input,
    ServerNotification, WhenBusy, kinds,
};
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
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = match cli.home {
        Some(home) => home,
        None => PathBuf::from(std::env::var_os("HOME").context("set HOME or NISSE_HOME")?)
            .join(".nisse"),
    };
    match cli.command {
        Some(Command::Serve { stdio }) => serve(&home, stdio).await,
        Some(Command::Exec { prompt }) => {
            let (client, notifications, _server) = connect(&home, cli.connect).await?;
            exec(client, notifications, prompt).await
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
            let (client, notifications, _server) = connect(&home, cli.connect).await?;
            nisse_tui::run(
                client,
                notifications,
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

fn start_server(home: &std::path::Path) -> Result<Arc<Server>> {
    std::fs::create_dir_all(home).with_context(|| format!("creating {}", home.display()))?;
    let (ui, _) = broadcast::channel(256);
    let sink = ui.clone();
    let roots = [home.join("extensions"), PathBuf::from(".nisse/extensions")];
    let hooks = LuaHost::load(&roots, Arc::new(move |changed| drop(sink.send(changed))))?;
    let think = std::env::var("NISSE_ECHO_THINK_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .unwrap_or(600);
    let harness = Harness::open(
        &home.join("nisse.sqlite"),
        HarnessOptions {
            provider: Arc::new(Echo {
                think: Duration::from_millis(think),
            }),
            hooks: Arc::new(hooks),
        },
    )?;
    harness.resume()?;
    Ok(Server::new(harness, ui, owner()))
}

async fn serve(home: &std::path::Path, stdio: bool) -> Result<()> {
    let server = start_server(home)?;
    if stdio {
        server.serve_stdio().await;
        return Ok(());
    }
    let socket = home.join("nisse.sock");
    let listener = Server::bind_unix(&socket)?;
    eprintln!("nisse: serving on {}", socket.display());
    tokio::select! {
        served = server.serve_unix(listener) => served,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}

/// Attaches to a running server when there is one; otherwise runs one in this process.
async fn connect(
    home: &std::path::Path,
    socket: Option<PathBuf>,
) -> Result<(
    Client,
    mpsc::UnboundedReceiver<ServerNotification>,
    Option<Arc<Server>>,
)> {
    let explicit = socket.is_some();
    let socket = socket.unwrap_or_else(|| home.join("nisse.sock"));
    let (client, notifications, server) = match Client::connect_unix(&socket).await {
        Ok((client, notifications)) => (client, notifications, None),
        Err(error) if explicit => return Err(error),
        Err(_) => {
            let server = start_server(home)?;
            let (client, notifications) = Client::new(server.connect_in_process());
            (client, notifications, Some(server))
        }
    };
    client.initialize("nisse-cli").await?;
    Ok((client, notifications, server))
}

async fn exec(
    client: Client,
    mut notifications: mpsc::UnboundedReceiver<ServerNotification>,
    prompt: String,
) -> Result<()> {
    let conversation: Conversation = client
        .request(ClientRequest::ConversationCreate(
            ConversationCreateParams::default(),
        ))
        .await?;
    let _: ConversationReadResult = client
        .request(ClientRequest::ConversationSubscribe(
            ConversationSubscribeParams {
                conversation_id: conversation.id.clone(),
                since_seq: 0,
            },
        ))
        .await?;
    let _: ConversationSubmitResult = client
        .request(ClientRequest::ConversationSubmit(
            ConversationSubmitParams {
                conversation_id: conversation.id.clone(),
                input: Input::Text { text: prompt },
                request_id: uuid::Uuid::now_v7().to_string(),
                when_busy: WhenBusy::Reject,
            },
        ))
        .await?;
    while let Some(notification) = notifications.recv().await {
        let ServerNotification::Committed(commit) = notification else {
            continue;
        };
        for entry in commit.entries {
            let text = entry.data["text"].as_str().unwrap_or_default();
            match entry.kind.as_str() {
                kinds::USER => println!("> {text}"),
                kinds::TOOL_CALL => println!(
                    "⚡ {} {}",
                    entry.data["name"].as_str().unwrap_or("tool"),
                    entry.data["args"]
                ),
                kinds::TOOL_RESULT => println!(
                    "{}",
                    entry.data["denied"]
                        .as_str()
                        .unwrap_or(entry.data["output"].as_str().unwrap_or_default())
                        .trim_end()
                ),
                kinds::ASSISTANT => {
                    println!("{text}");
                    println!("conversation {}", conversation.id);
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    Ok(())
}
