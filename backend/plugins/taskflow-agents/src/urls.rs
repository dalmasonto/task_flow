//! URL conf for the `taskflow-agents` plugin — the route table.
//! `router()` returns the axum `Router` that
//! `Plugin::routes()` in lib.rs hands back to the framework.
//!
//! Convention: `/<name>/...` for HTML pages, `/api/<name>/...` for JSON.
//! Map each path to a handler in `views.rs` so this file reads as the
//! single index of everything the plugin serves.

use umbral::web::{Router, get, post};

use crate::views;

/// Build this plugin's route table. Add one `.route(path, method(handler))`
/// line per endpoint.
pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/agents/health", get(views::health))
        // The only trusted write path for messages. Auto-REST's
        // POST /api/taskflow_agent_message/ lets the client assert its own
        // sender fields; this route derives them.
        .route("/api/taskflow/agents/messages", post(views::send_message))
        // The only authorized way to add a person to a channel roster. Membership
        // and identity are resolved server-side; the channel comes from the path.
        .route(
            "/api/taskflow/channels/{channel}/members",
            post(views::add_channel_member),
        )
}
