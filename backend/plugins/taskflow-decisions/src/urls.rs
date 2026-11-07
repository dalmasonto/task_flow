//! URL conf for `taskflow-decisions` (#1094).
//!
//! `{key}` is the decision's slug. Human routes put it under `/d/`, so a key
//! can never collide with a literal segment such as `/blocking`.

use umbral::web::{Router, get, post};

use crate::views;

pub fn router() -> Router {
    Router::new()
        // Human surface.
        .route("/api/taskflow/decisions/{project}", get(views::list).post(views::ask))
        .route("/api/taskflow/decisions/{project}/blocking", get(views::blocking))
        .route("/api/taskflow/decisions/{project}/d/{key}", get(views::get))
        .route("/api/taskflow/decisions/{project}/d/{key}/options", post(views::add_option))
        .route("/api/taskflow/decisions/{project}/d/{key}/recommend", post(views::recommend))
        .route("/api/taskflow/decisions/{project}/d/{key}/comments", post(views::comment))
        .route("/api/taskflow/decisions/{project}/d/{key}/tasks", post(views::link))
        .route("/api/taskflow/decisions/{project}/d/{key}/rule", post(views::rule))
        .route("/api/taskflow/decisions/{project}/d/{key}/supersede", post(views::supersede))
        // Agent surface: the MCP tools. No rule, no supersede.
        .route("/api/taskflow/agents/decisions", get(views::agent_list).post(views::agent_ask))
        .route("/api/taskflow/agents/decisions/{key}", get(views::agent_get))
        .route("/api/taskflow/agents/decisions/{key}/options", post(views::agent_add_option))
        .route("/api/taskflow/agents/decisions/{key}/recommend", post(views::agent_recommend))
        .route("/api/taskflow/agents/decisions/{key}/comments", post(views::agent_comment))
        .route("/api/taskflow/agents/decisions/{key}/tasks", post(views::agent_link))
}
