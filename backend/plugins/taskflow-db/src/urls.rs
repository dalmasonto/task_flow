//! Route table for `taskflow-db` (#885).

use umbral::web::{Router, get, post, put};

use crate::{agent_views, views};

pub fn router() -> Router {
    Router::new()
        // --- human (authed, membership-gated) --------------------------------
        .route("/api/db/{project}/schema", get(views::get_schema).put(views::put_schema))
        .route("/api/db/{project}/versions", get(views::list_versions))
        .route("/api/db/{project}/versions/{version}", get(views::read_version))
        .route("/api/db/{project}/restore", post(views::restore))
        .route("/api/db/{project}/room", get(views::get_room))
        // --- agents (credential-scoped to one project) -----------------------
        .route("/api/taskflow/agents/db/schema", get(agent_views::schema))
        .route(
            "/api/taskflow/agents/db/model",
            put(agent_views::write_model).delete(agent_views::delete_model),
        )
        .route("/api/taskflow/agents/db/samples", put(agent_views::write_samples))
}
