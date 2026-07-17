//! URL conf for the `taskflow-projects` plugin — the route table.
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
        .route("/api/taskflow/projects/health", get(views::health))
        // Invite accept/decline — token in the path, caller from the auth token.
        .route(
            "/api/taskflow/projects/invites/{token}/accept",
            post(views::accept_invite),
        )
        .route(
            "/api/taskflow/projects/invites/{token}/decline",
            post(views::decline_invite),
        )
        // The caller's invite inbox (pending, addressed to their email).
        .route(
            "/api/taskflow/projects/invites/mine",
            get(views::my_invites),
        )
        // Per-user settings: get-or-create on read, identity-keyed update on
        // write. Both derive the user from the auth token — no `user` in the body.
        .route(
            "/api/taskflow/user/settings",
            get(views::get_user_settings).post(views::update_user_settings),
        )
}
