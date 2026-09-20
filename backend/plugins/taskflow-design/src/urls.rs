//! URL conf for the `taskflow-design` plugin — the route table.
//!
//! Chrome-facing JSON lives under `/api/design/{project}/...`; the sandbox
//! origin serves `/s/{token}/...`. Map each path to a handler in `views.rs` so
//! this file reads as the single index of everything the plugin serves.

use umbral::web::{Router, get, patch, post, put};

use crate::{agent_views, views};

/// Build this plugin's route table.
pub fn router() -> Router {
    Router::new()
        // --- chrome-facing (authed, membership-gated) ------------------------
        .route(
            "/api/design/{project}/manifest",
            get(views::get_manifest),
        )
        .route(
            "/api/design/{project}/sandbox-token",
            get(views::mint_sandbox_token),
        )
        .route(
            "/api/design/{project}/agents",
            get(views::list_project_agents),
        )
        .route(
            "/api/design/{project}/screenshots",
            post(views::create_screenshot),
        )
        .route("/api/design/{project}/files", get(views::list_files))
        .route("/api/design/{project}/file", get(views::get_file).put(views::put_file))
        .route(
            "/api/design/{project}/tokens.css",
            get(views::export_tokens_css),
        )
        .route(
            "/api/design/{project}/comments",
            get(views::list_comments).post(views::create_comment),
        )
        .route(
            "/api/design/{project}/comments/{id}",
            patch(views::update_comment),
        )
        .route("/api/design/{project}/events", get(views::design_events))
        .route(
            "/api/design/{project}/dispatch",
            post(crate::dispatch::dispatch_comments),
        )
        .route(
            "/api/design/{project}/prompt",
            post(crate::dispatch::send_prompt),
        )
        // --- agent-facing (MCP tools; credential-gated) ----------------------
        // Reads: context bundles tokens + registry; pages/components read by
        // route/name. Writes: same validator, required `reason` on the
        // registry-level writes.
        .route(
            "/api/taskflow/agents/design/context",
            get(agent_views::context),
        )
        .route("/api/taskflow/agents/design/page", get(agent_views::read_page).put(agent_views::write_page))
        .route(
            "/api/taskflow/agents/design/component",
            get(agent_views::read_component).put(agent_views::write_component),
        )
        .route(
            "/api/taskflow/agents/design/tokens",
            put(agent_views::write_tokens),
        )
        .route(
            "/api/taskflow/agents/design/screenshot",
            get(agent_views::screenshot),
        )
        .route(
            "/api/taskflow/agents/design/comments",
            get(agent_views::list_comments_as_targets),
        )
        .route(
            "/api/taskflow/agents/design/comments/{id}/resolve",
            post(agent_views::resolve_comment),
        )
        // --- sandbox-facing (token-granted, distinct origin) -----------------
        // The app's SlashRedirect::Append turns /s/{tok} into /s/{tok}/, so
        // both shapes must resolve to the project root route.
        .route("/s/{token}", get(views::serve_page_root))
        .route("/s/{token}/", get(views::serve_page_root))
        .route("/s/{token}/{route}", get(views::serve_page))
        .route("/s/{token}/preview/{name}", get(views::serve_component_preview))
        .route("/s/{token}/f/{*path}", get(views::serve_file))
}
