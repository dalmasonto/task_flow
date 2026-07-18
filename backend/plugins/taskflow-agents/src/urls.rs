//! URL conf for the `taskflow-agents` plugin — the route table.
//! `router()` returns the axum `Router` that
//! `Plugin::routes()` in lib.rs hands back to the framework.
//!
//! Convention: `/<name>/...` for HTML pages, `/api/<name>/...` for JSON.
//! Map each path to a handler in `views.rs` so this file reads as the
//! single index of everything the plugin serves.

use axum::extract::DefaultBodyLimit;
use umbral::web::{Router, get, post};

use crate::views;

/// Upper bound on the send-message request body. Axum's `Bytes` extractor
/// otherwise caps the body at its 2 MiB default, so any upload whose multipart
/// body crossed 2 MiB was rejected before the handler ran (surfacing as a
/// "buffer limit exceeded" error) — well below the 25 MiB per-file cap the
/// handler itself enforces. Match the framework's 32 MiB multipart ceiling so
/// legitimate uploads reach the handler and get a clean, specific error.
const SEND_MESSAGE_BODY_LIMIT: usize = 32 * 1024 * 1024;

/// Build this plugin's route table. Add one `.route(path, method(handler))`
/// line per endpoint.
pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/agents/health", get(views::health))
        // The only trusted write path for messages. Auto-REST's
        // POST /api/taskflow_agent_message/ lets the client assert its own
        // sender fields; this route derives them.
        .route(
            "/api/taskflow/agents/messages",
            post(views::send_message).layer(DefaultBodyLimit::max(SEND_MESSAGE_BODY_LIMIT)),
        )
        // The only authorized way to add a person to a channel roster. Membership
        // and identity are resolved server-side; the channel comes from the path.
        .route(
            "/api/taskflow/channels/{channel}/members",
            post(views::add_channel_member),
        )
        // Mint an agent identity (human-authed): create/reuse a stable
        // `TaskflowAgent` + a fresh credential; returns the raw key once.
        .route("/api/taskflow/agents/link", post(views::link_agent))
        // Agent-authored send (agent-authed via `RequireAgent`). JSON only and
        // small, so the framework's default body limit is fine.
        .route(
            "/api/taskflow/agents/agent/messages",
            post(views::send_message_as_agent),
        )
}
