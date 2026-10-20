//! Nisse's core: a store that commits atomically and publishes only what it committed,
//! and a harness that runs conversations on it.

mod harness;
mod model;
mod store;
mod tools;

pub use harness::{Harness, HarnessOptions, SubmitError};
pub use model::{EchoModel, Model, ModelFuture, ModelResponse};
pub use store::Store;
pub use tools::{Hooks, NoHooks, ToolCall, ToolOutcome, run_builtin_tool};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
