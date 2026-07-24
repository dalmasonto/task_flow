//! URL conf for the `taskflow-tasks` plugin — the route table.
//! `router()` returns the axum `Router` that
//! `Plugin::routes()` in lib.rs hands back to the framework.
//!
//! Convention: `/<name>/...` for HTML pages, `/api/<name>/...` for JSON.
//! Map each path to a handler in `views.rs` so this file reads as the
//! single index of everything the plugin serves.

use umbral::web::{Router, get};

use crate::views;

/// Build this plugin's route table. Add one `.route(path, method(handler))`
/// line per endpoint.
pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/tasks/health", get(views::health))
        // #56: distinct action names, so the activity page's tool filter has a
        // stable option list that does not depend on the filter's own result.
        .route(
            "/api/taskflow/projects/{project}/activity/actions",
            get(views::activity_actions),
        )
}
