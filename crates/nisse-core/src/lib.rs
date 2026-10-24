//! Nisse's core: a store that commits atomically and publishes only what it committed,
//! and a harness that runs conversations on it.

mod agents;
mod harness;
mod provider;
mod store;
mod tools;
mod turn;
mod workspace;

pub use agents::{AgentType, Limits, is_agent_tool};
pub use harness::{
    DefaultModel, Harness, HarnessOptions, LoadHooks, StartError, SubmitError, no_default_model,
    same_hooks, with_nested_results,
};
pub use provider::{Echo, HealthFuture, ModelsFuture, Provider, ProviderFuture, SignIn};
pub use store::Store;
pub use tools::{
    CallContext, Hooks, NoHooks, ToolCall, ToolOutcome, ToolSpec, approval_for, builtin_tools,
    run_builtin_tool,
};
pub use turn::{Approval, Decision, LIVE_INTERVAL, Turn};
pub use workspace::{AGENTS_MD_LIMIT, AgentsMd, AttachedSkill, Workspace};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
