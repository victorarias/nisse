//! `nisse login`, `nisse logout` and `nisse providers`: clients of the server's setup methods.

use std::{collections::BTreeMap, io::Write};

use anyhow::{Result, bail};
use nisse_client::Client;
use nisse_protocol::{
    AuthAccepted, AuthCancelParams, AuthInteraction, AuthLogoutParams, AuthMethod, AuthPhase,
    AuthRespondParams, AuthResponse, AuthStartParams, AuthState, ClientRequest, ProviderSnapshot,
    ProviderStatus, ProvidersListParams, ProvidersListResult, ServerNotification,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::mpsc,
};

/// Signs in to `provider` by `method`, or its preferred one, telling the person on the terminal
/// what to do, until the sign-in ends. Joins a sign-in another client already started.
pub async fn login(
    client: &Client,
    notifications: &mut mpsc::UnboundedReceiver<ServerNotification>,
    provider: String,
    method: Option<AuthMethod>,
) -> Result<()> {
    let mut state: AuthState = client
        .request(ClientRequest::AuthStart(AuthStartParams {
            provider,
            method,
        }))
        .await?;
    let mut pasted = BufReader::new(tokio::io::stdin()).lines();
    let mut shown = None;
    loop {
        if state.phase.is_over() {
            return finished(&state);
        }
        if state.interaction != shown {
            shown.clone_from(&state.interaction);
            if let Some(interaction) = &shown {
                follow(client, &state, interaction).await?;
            }
        }
        let awaits_paste = matches!(shown, Some(AuthInteraction::Browser { .. }));
        tokio::select! {
            notification = notifications.recv() => match notification {
                Some(ServerNotification::AuthState(next))
                    if next.provider == state.provider && next.flow_id == state.flow_id => state = next,
                Some(_) => {}
                None => bail!("the server hung up before the sign-in finished"),
            },
            Ok(Some(line)) = pasted.next_line(), if awaits_paste => {
                respond(client, &state, AuthResponse::Callback { url: line.trim().to_owned() }).await?;
            }
            _ = tokio::signal::ctrl_c() => {
                let _: AuthAccepted = client
                    .request(ClientRequest::AuthCancel(AuthCancelParams {
                        provider: state.provider.clone(),
                        flow_id: state.flow_id.clone(),
                    }))
                    .await?;
                bail!("cancelled");
            }
        }
    }
}

async fn follow(client: &Client, state: &AuthState, interaction: &AuthInteraction) -> Result<()> {
    match interaction {
        AuthInteraction::Browser { url } => eprintln!(
            "Open this link in your browser to sign in:\n\n  {url}\n\n\
             If that browser runs on another machine, paste the address it ends on here.\n"
        ),
        AuthInteraction::DeviceCode { url, code } => {
            eprintln!("On any device, open {url} and enter the code {code}\n")
        }
        AuthInteraction::Terminal { command, env } => {
            let success = run(command, env).await;
            respond(client, state, AuthResponse::TerminalExited { success }).await?;
        }
    }
    Ok(())
}

async fn run(command: &[String], env: &BTreeMap<String, String>) -> bool {
    let Some((program, args)) = command.split_first() else {
        return false;
    };
    tokio::process::Command::new(program)
        .args(args)
        .envs(env)
        .status()
        .await
        .is_ok_and(|status| status.success())
}

async fn respond(client: &Client, state: &AuthState, response: AuthResponse) -> Result<()> {
    let _: AuthAccepted = client
        .request(ClientRequest::AuthRespond(AuthRespondParams {
            provider: state.provider.clone(),
            flow_id: state.flow_id.clone(),
            response,
        }))
        .await?;
    Ok(())
}

fn finished(state: &AuthState) -> Result<()> {
    let message = state.message.as_deref().unwrap_or_default();
    match state.phase {
        AuthPhase::Succeeded if message.is_empty() => eprintln!("Signed in to {}.", state.provider),
        AuthPhase::Succeeded => eprintln!("Signed in to {} as {message}.", state.provider),
        AuthPhase::Cancelled => bail!("someone cancelled the sign-in"),
        _ => bail!("signing in to {} failed: {message}", state.provider),
    }
    Ok(())
}

pub async fn logout(client: &Client, provider: String, out: &mut impl Write) -> Result<()> {
    let snapshot: ProviderSnapshot = client
        .request(ClientRequest::AuthLogout(AuthLogoutParams { provider }))
        .await?;
    writeln!(out, "Signed out of {}.", snapshot.id)?;
    Ok(())
}

pub async fn list_providers(client: &Client, out: &mut impl Write) -> Result<()> {
    let listed: ProvidersListResult = client
        .request(ClientRequest::ProvidersList(ProvidersListParams {
            refresh: true,
        }))
        .await?;
    for provider in listed.providers {
        let health = &provider.health;
        let status = match health.status {
            ProviderStatus::Ready => "ready",
            ProviderStatus::SignedOut => "signed out",
            ProviderStatus::Unavailable => "unavailable",
        };
        let detail = health
            .account
            .as_deref()
            .or(health.message.as_deref())
            .unwrap_or_default();
        writeln!(
            out,
            "{:<16} {:<7} {status:<12} {detail}",
            provider.id, provider.driver
        )?;
    }
    Ok(())
}
