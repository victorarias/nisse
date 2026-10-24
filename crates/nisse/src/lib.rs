//! `nisse exec`: one prompt, run headless against a server; and the setup commands.

mod login;

use std::io::Write;

use anyhow::{Result, bail};
use nisse_client::Client;
use nisse_protocol::{
    ApprovalResolveParams, ApprovalResolveResult, ClientRequest, Conversation,
    ConversationReadResult, ConversationStartParams, ConversationStatus, ConversationSubmitParams,
    ConversationSubmitResult, ConversationSubscribeParams, Entry, Input, ServerNotification,
    WhenBusy, kinds,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, Lines},
    sync::mpsc,
};

pub use login::{list_models, list_providers, login, logout};

/// Sends `prompt` to a conversation started with `start` and writes the run to `out` as it
/// commits, until the conversation is idle again. Each approval is asked on stderr and answered by the next line of
/// `answers`: `y` or `yes` allows, anything else or no line at all denies.
pub async fn exec(
    client: &Client,
    notifications: &mut mpsc::UnboundedReceiver<ServerNotification>,
    start: ConversationStartParams,
    prompt: String,
    answers: impl AsyncBufRead + Unpin,
    out: &mut impl Write,
) -> Result<()> {
    let conversation: Conversation = client
        .request(ClientRequest::ConversationStart(start))
        .await?;
    let subscribed: ConversationReadResult = client
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
    let mut answers = answers.lines();
    while let Some(notification) = notifications.recv().await {
        match notification {
            ServerNotification::Committed(commit) if commit.conversation_id == conversation.id => {
                for entry in &commit.entries {
                    print_entry(entry, out)?;
                    if entry.kind == kinds::APPROVAL_REQUEST {
                        let allow = ask(entry, &mut answers).await?;
                        let _: ApprovalResolveResult = client
                            .request(ClientRequest::ApprovalResolve(ApprovalResolveParams {
                                conversation_id: conversation.id.clone(),
                                call_id: entry.data["call_id"].as_str().unwrap_or_default().into(),
                                allow,
                                reason: None,
                            }))
                            .await?;
                    }
                }
            }
            ServerNotification::Status(changed)
                if changed.conversation_id == conversation.id
                    && changed.seq > subscribed.seq
                    && changed.status == ConversationStatus::Idle =>
            {
                writeln!(out, "conversation {}", conversation.id)?;
                return Ok(());
            }
            _ => {}
        }
    }
    bail!("the server hung up before the run finished")
}

fn print_entry(entry: &Entry, out: &mut impl Write) -> std::io::Result<()> {
    let data = &entry.data;
    match entry.kind.as_str() {
        kinds::USER => writeln!(out, "> {}", data["text"].as_str().unwrap_or_default()),
        kinds::ASSISTANT => writeln!(out, "{}", data["text"].as_str().unwrap_or_default()),
        kinds::TOOL_CALL => writeln!(
            out,
            "⚡ {} {}",
            data["name"].as_str().unwrap_or("tool"),
            match &data["args"] {
                serde_json::Value::String(script) => format!("\n{script}"),
                args => args.to_string(),
            }
        ),
        kinds::TOOL_RESULT => writeln!(
            out,
            "{}",
            data["denied"]
                .as_str()
                .unwrap_or(data["output"].as_str().unwrap_or_default())
                .trim_end()
        ),
        _ => Ok(()),
    }
}

async fn ask(request: &Entry, answers: &mut Lines<impl AsyncBufRead + Unpin>) -> Result<bool> {
    eprint!(
        "Allow {} {}? [y/N] ",
        request.data["name"].as_str().unwrap_or("tool"),
        request.data["args"]
    );
    let answer = answers.next_line().await?.unwrap_or_default();
    Ok(matches!(answer.trim(), "y" | "Y" | "yes"))
}
