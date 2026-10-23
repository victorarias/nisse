//! The Nisse app server protocol: JSON-RPC 2.0 without the `jsonrpc` field.
//! These types are the only definition of the wire; JSON Schema is generated from them.

mod rpc;
#[cfg(feature = "transport")]
pub mod transport;
mod types;

pub use rpc::*;
pub use types::*;

pub const PROTOCOL_VERSION: u32 = 2;
