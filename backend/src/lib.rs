//! backend — library surface.
//!
//! `main.rs` is the binary and owns the App builder. This library target exists
//! so integration tests under `tests/` can reach the wiring modules without a
//! running server. Only modules with logic worth testing in isolation are
//! declared here; `seed`, `views`, and `widgets` stay private to the binary.

pub mod media_access;
pub mod realtime;
pub mod rest;
