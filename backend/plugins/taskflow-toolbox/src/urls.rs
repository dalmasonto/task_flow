//! URL conf for the `taskflow-toolbox` plugin (#617).
//!
//! Human routes serve the Toolbox page; the `agents/toolbox/...` routes are
//! what the MCP tools call. Both go through the same save core, so the secret
//! scan and the redaction are the same two layers wherever an entry enters.

use umbral::web::{Router, get, post};

use crate::views;

pub fn router() -> Router {
    Router::new()
        // Human surface: list, one entry (full), versions, restore, status,
        // delete.
        .route("/api/taskflow/toolbox/{project}", get(views::list_entries))
        .route(
            "/api/taskflow/toolbox/{project}/entry/{name}",
            get(views::get_entry).post(views::save_entry).delete(views::delete_entry),
        )
        .route(
            "/api/taskflow/toolbox/{project}/entry/{name}/versions",
            get(views::list_versions),
        )
        .route(
            "/api/taskflow/toolbox/{project}/entry/{name}/versions/{version}",
            get(views::get_version),
        )
        .route(
            "/api/taskflow/toolbox/{project}/entry/{name}/versions/restore",
            post(views::restore_version),
        )
        .route(
            "/api/taskflow/toolbox/{project}/entry/{name}/status",
            post(views::set_status),
        )
        // Agent surface: the MCP tools. `{name}` is a path segment, so an
        // entry name is the lookup key everywhere.
        .route("/api/taskflow/agents/toolbox", get(views::agent_list))
        .route(
            "/api/taskflow/agents/toolbox/{name}",
            get(views::agent_get).post(views::agent_save),
        )
        .route(
            "/api/taskflow/agents/toolbox/{name}/run",
            post(views::agent_report_run),
        )
        .route(
            "/api/taskflow/agents/toolbox/{name}/deprecate",
            post(views::agent_deprecate),
        )
        .route(
            "/api/taskflow/agents/toolbox/{name}/versions",
            get(views::agent_list_versions),
        )
        .route(
            "/api/taskflow/agents/toolbox/{name}/vet",
            post(views::agent_vet),
        )
        .route(
            "/api/taskflow/agents/toolbox/{name}/versions/{version}",
            get(views::agent_get_version),
        )
}
