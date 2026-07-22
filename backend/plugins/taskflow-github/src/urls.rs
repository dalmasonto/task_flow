//! URL conf for the taskflow-github plugin — the route table.
//! `router(deps)` returns the axum `Router` (with injected `GithubDeps` state)
//! that `Plugin::routes()` hands to the framework and tests drive directly.
//!
//! Convention: `/api/taskflow/github/...` for JSON, matching the other plugins.

use umbral::web::{Router, get, post};

use crate::{GithubDeps, views};

pub fn router(deps: GithubDeps) -> Router {
    Router::new()
        // Publish a task as a GitHub issue (owner / tracking key).
        .route(
            "/api/taskflow/github/projects/{project}/tasks/{task}/publish",
            post(views::publish_issue),
        )
        // Comment on the task's issue, attributed to the acting user (opt-in).
        .route(
            "/api/taskflow/github/projects/{project}/tasks/{task}/comment",
            post(views::comment_on_issue),
        )
        // Per-project opt-in: may the agent post to GitHub as this user here?
        .route(
            "/api/taskflow/github/projects/{project}/pref",
            get(views::get_pref).post(views::set_pref),
        )
        .with_state(deps)
}
