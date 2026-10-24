use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use futures_util::future::join_all;
use nisse_core::{Provider, SignIn};
use nisse_protocol::{
    AuthCancelParams, AuthInteraction, AuthMethod, AuthPhase, AuthRespondParams, AuthResponse,
    AuthStartParams, AuthState, ProviderId, ProviderModels, ProviderSnapshot, ProviderStatus,
    RpcError,
};
use tokio::{
    sync::{broadcast, mpsc},
    task::AbortHandle,
};

const STATE_BACKLOG: usize = 64;

/// A named provider, as conversations name it.
type Instance = (ProviderId, Arc<dyn Provider>);

/// The server's providers and the sign-ins running on them, one per provider, which any of the
/// owner's connections can follow, answer or cancel.
pub(crate) struct Setup {
    instances: Vec<Instance>,
    flows: Mutex<HashMap<ProviderId, Flow>>,
    states: broadcast::Sender<AuthState>,
}

struct Flow {
    state: AuthState,
    responses: mpsc::UnboundedSender<AuthResponse>,
    task: AbortHandle,
}

impl Setup {
    pub(crate) fn new(instances: Vec<Instance>) -> Arc<Self> {
        Arc::new(Self {
            instances,
            flows: Mutex::default(),
            states: broadcast::channel(STATE_BACKLOG).0,
        })
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<AuthState> {
        self.states.subscribe()
    }

    pub(crate) async fn list(&self, refresh: bool) -> Vec<ProviderSnapshot> {
        join_all(
            self.instances
                .iter()
                .map(|(id, provider)| snapshot(id, provider, refresh)),
        )
        .await
    }

    pub(crate) async fn models(&self, refresh: bool) -> Vec<ProviderModels> {
        join_all(self.instances.iter().map(|(id, provider)| async move {
            ProviderModels {
                provider: id.clone(),
                default_model: provider.default_model().map(str::to_owned),
                models: provider.models(refresh).await,
            }
        }))
        .await
    }

    pub(crate) async fn logout(&self, id: &str) -> Result<ProviderSnapshot, RpcError> {
        let (id, provider) = self.instance(id)?;
        provider
            .sign_out()
            .await
            .map_err(|error| RpcError::new(RpcError::INTERNAL, format!("{error:#}")))?;
        Ok(snapshot(id, provider, true).await)
    }

    /// Starts signing in to the instance, or answers with the sign-in already running on it.
    pub(crate) fn start(self: &Arc<Self>, params: AuthStartParams) -> Result<AuthState, RpcError> {
        let (id, provider) = self.instance(&params.provider)?.clone();
        let methods = provider.sign_in_methods();
        let method = match params.method {
            Some(method) if methods.contains(&method) => method,
            Some(method) => {
                return Err(invalid(format!("{id} can't sign in by {method:?}")));
            }
            None => *methods
                .first()
                .ok_or_else(|| invalid(format!("{id} has nothing to sign in to")))?,
        };
        let mut flows = self.flows.lock().expect("flows lock");
        if let Some(flow) = flows.get(&id) {
            return Ok(flow.state.clone());
        }
        let state = AuthState {
            provider: id.clone(),
            flow_id: nisse_core::new_id(),
            phase: AuthPhase::Starting,
            interaction: None,
            message: None,
        };
        let (responses, answered) = mpsc::unbounded_channel();
        let task = tokio::spawn(self.clone().sign_in(
            id,
            provider,
            method,
            state.flow_id.clone(),
            answered,
        ))
        .abort_handle();
        flows.insert(
            state.provider.clone(),
            Flow {
                state: state.clone(),
                responses,
                task,
            },
        );
        let _ = self.states.send(state.clone());
        Ok(state)
    }

    pub(crate) fn respond(&self, params: AuthRespondParams) -> bool {
        let flows = self.flows.lock().expect("flows lock");
        flows
            .get(&params.provider)
            .filter(|flow| {
                flow.state.flow_id == params.flow_id && flow.state.phase == AuthPhase::Waiting
            })
            .is_some_and(|flow| flow.responses.send(params.response).is_ok())
    }

    pub(crate) fn cancel(&self, params: AuthCancelParams) -> bool {
        self.end(
            &params.provider,
            &params.flow_id,
            AuthPhase::Cancelled,
            None,
        )
    }

    async fn sign_in(
        self: Arc<Self>,
        id: ProviderId,
        provider: Arc<dyn Provider>,
        method: AuthMethod,
        flow_id: String,
        answered: mpsc::UnboundedReceiver<AuthResponse>,
    ) {
        let shown = {
            let setup = self.clone();
            let (id, flow_id) = (id.clone(), flow_id.clone());
            move |interaction| setup.update(&id, &flow_id, AuthPhase::Waiting, Some(interaction))
        };
        let flow = SignIn::new(shown, answered);
        let (phase, message) = match provider.sign_in(method, flow).await {
            Ok(()) => {
                self.update(&id, &flow_id, AuthPhase::Verifying, None);
                let health = provider.health(true).await;
                if health.status == ProviderStatus::Ready {
                    (AuthPhase::Succeeded, health.account)
                } else {
                    let message = health.message.unwrap_or_else(|| "still signed out".into());
                    (AuthPhase::Failed, Some(message))
                }
            }
            Err(error) => (AuthPhase::Failed, Some(format!("{error:#}"))),
        };
        self.end(&id, &flow_id, phase, message);
    }

    fn update(
        &self,
        id: &str,
        flow_id: &str,
        phase: AuthPhase,
        interaction: Option<AuthInteraction>,
    ) {
        let mut flows = self.flows.lock().expect("flows lock");
        let Some(flow) = flows
            .get_mut(id)
            .filter(|flow| flow.state.flow_id == flow_id)
        else {
            return;
        };
        flow.state.phase = phase;
        flow.state.interaction = interaction;
        let _ = self.states.send(flow.state.clone());
    }

    fn end(&self, id: &str, flow_id: &str, phase: AuthPhase, message: Option<String>) -> bool {
        let mut flows = self.flows.lock().expect("flows lock");
        if flows
            .get(id)
            .is_none_or(|flow| flow.state.flow_id != flow_id)
        {
            return false;
        }
        let flow = flows.remove(id).expect("the flow was just found");
        if phase == AuthPhase::Cancelled {
            flow.task.abort();
        }
        let _ = self.states.send(AuthState {
            phase,
            interaction: None,
            message,
            ..flow.state
        });
        true
    }

    fn instance(&self, id: &str) -> Result<&Instance, RpcError> {
        self.instances
            .iter()
            .find(|(known, _)| known == id)
            .ok_or_else(|| invalid(format!("no provider {id}")))
    }
}

async fn snapshot(id: &str, provider: &Arc<dyn Provider>, refresh: bool) -> ProviderSnapshot {
    ProviderSnapshot {
        id: id.to_owned(),
        driver: provider.driver().to_owned(),
        sign_in: provider.sign_in_methods(),
        health: provider.health(refresh).await,
    }
}

fn invalid(message: String) -> RpcError {
    RpcError::new(RpcError::INVALID_PARAMS, message)
}
