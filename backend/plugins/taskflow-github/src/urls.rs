//! URL conf for the taskflow-github plugin — the route table.
//! `router(deps)` returns the axum `Router` (with injected `GithubDeps` state)
//! that `Plugin::routes()` hands to the framework and tests drive directly.
//!
//! Convention: `/api/taskflow/github/...` for JSON, matching the other plugins.

use umbral::web::{Router, post};

use crate::{GithubDeps, views};

pub fn router(deps: GithubDeps) -> Router {
    Router::new()
        // Publish a task as a GitHub issue (owner / tracking key).
        .route(
            "/api/taskflow/github/projects/{project}/tasks/{task}/publish",
            post(views::publish_issue),
        )
        .with_state(deps)
}
