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
        // Read receipts / unread cursors. The human path is auth-gated; the agent
        // path is `RequireAgent`-gated. Both upsert the caller's own cursor
        // forward-only; the channel comes from the path.
        .route(
            "/api/taskflow/channels/{channel}/read",
            post(views::mark_channel_read),
        )
        .route(
            "/api/taskflow/channels/{channel}/agent/read",
            post(views::mark_channel_read_as_agent),
        )
        // Live sessions (agent-authed via `RequireAgent`). Register/reconnect a
        // session, heartbeat its liveness, stream terminal frames, and close it.
        // Every op after register verifies the session belongs to the caller.
        .route(
            "/api/taskflow/agents/sessions",
            post(views::register_session),
        )
        .route(
            "/api/taskflow/agents/sessions/{session}/heartbeat",
            post(views::session_heartbeat),
        )
        .route(
            "/api/taskflow/agents/sessions/{session}/frames",
            post(views::append_session_frames),
        )
        .route(
            "/api/taskflow/agents/sessions/{session}/close",
            post(views::close_session),
        )
        // Agent-authored tasks (agent-authed via `RequireAgent`). Create a task
        // in the agent's own project (optionally self-claiming it), advance its
        // status, or claim it. Each emits a task activity as the agent.
        .route(
            "/api/taskflow/agents/tasks",
            post(views::create_task_as_agent),
        )
        .route(
            "/api/taskflow/agents/tasks/{task}/status",
            post(views::update_task_status_as_agent),
        )
        .route(
            "/api/taskflow/agents/tasks/{task}/claim",
            post(views::claim_task_as_agent),
        )
        // Review workflow. The human path is auth-gated (active project member);
        // the agent path is `RequireAgent`-gated (task in the agent's project).
        // Both record a review, transition the task, report back to the assigned
        // agent via a project-room message, and log a `reviewed` activity.
        .route(
            "/api/taskflow/tasks/{task}/review",
            post(views::review_task),
        )
        .route(
            "/api/taskflow/tasks/{task}/agent/review",
            post(views::review_task_as_agent),
        )
        // Agent activity ingest (agent-authed via `RequireAgent`). An agent posts
        // its real actions — single or batch — as `TaskflowTaskActivity` stamped
        // with the agent; a task link is kept only if the task is in the agent's
        // project. JSON only and modestly sized, so the default body limit is fine.
        .route(
            "/api/taskflow/agents/activity",
            post(views::post_activity_as_agent),
        )
}
