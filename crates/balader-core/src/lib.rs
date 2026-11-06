//! Balader core: everything that isn't pixels.
//!
//! ```text
//!  UI (Tauri webview) ─┐
//!  balader serve (HTTP)─┼─► Core::dispatch(cmd, json) ─► probe / jobs / engine / stores
//!  balader call (CLI) ──┘            │
//!                                     └─ events (CoreEvent) ─► Tauri emit / SSE / stdout
//! ```

pub mod core;
pub mod download;
pub mod engine;
pub mod error;
pub mod events;
pub mod formats;
pub mod model;
pub mod platform;
pub mod probe;
pub mod proc;
pub mod progress;
pub mod selector;
pub mod sniff;
pub mod store;
pub mod thumbs;
pub mod util;

pub use crate::core::{COMMANDS, Core, CorePaths, IDENTIFIER};
pub use crate::error::{CoreError, ErrorCode, ErrorPayload};
pub use crate::events::CoreEvent;
pub use crate::model::*;
