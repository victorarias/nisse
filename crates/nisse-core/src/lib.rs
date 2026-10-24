//! Nisse's core: a store that commits atomically and publishes only what it committed,
//! and a harness that runs conversations on it.

mod harness;
mod provider;
mod store;
mod tools;
mod turn;

pub use harness::{Harness, HarnessOptions, LoadHooks, StartError, SubmitError, same_hooks};
pub use provider::{Echo, Provider, ProviderFuture};
pub use store::Store;
pub use tools::{
    Hooks, NoHooks, ToolCall, ToolOutcome, ToolSpec, approval_for, builtin_tools, run_builtin_tool,
};
pub use turn::{Approval, Decision, LIVE_INTERVAL, Turn};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
