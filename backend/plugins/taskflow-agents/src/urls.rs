//! URL conf for the `taskflow-agents` plugin — the route table.
//! `router()` returns the axum `Router` that
//! `Plugin::routes()` in lib.rs hands back to the framework.
//!
//! Convention: `/<name>/...` for HTML pages, `/api/<name>/...` for JSON.
//! Map each path to a handler in `views.rs` so this file reads as the
//! single index of everything the plugin serves.

use axum::extract::DefaultBodyLimit;
use umbral::web::{Router, delete, get, patch, post, put};

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
        // #43: mint a one-time SSE ticket (token-authed) so EventSource can
        // authenticate the realtime handshake without the bearer token in the URL.
        .route("/api/taskflow/realtime/ticket", post(views::mint_realtime_ticket))
        // #1126: the claim lease length, for the board's lease chip.
        .route("/api/taskflow/claim-lease", get(crate::leases::lease_info))
        // The only trusted write path for messages. Auto-REST's
        // POST /api/taskflow_agent_message/ lets the client assert its own
        // sender fields; this route derives them.
        .route(
            "/api/taskflow/agents/messages",
            post(views::send_message)
                // Agent-authed read of a channel's messages (Stage 6). Shares the
                // path with the human send; the GET is `RequireAgent`-gated.
                .get(views::list_messages_as_agent)
                .layer(DefaultBodyLimit::max(SEND_MESSAGE_BODY_LIMIT)),
        )
        // Stage 6 — agent-authed READ surface the MCP needs. Every handler is
        // `RequireAgent`-gated and scopes its query to the agent's own project.
        // `whoami`, `channels`, `agents` are new paths; `tasks`, `messages`, and
        // `activity` add a GET alongside their existing agent-authed POST.
        .route("/api/taskflow/agents/whoami", get(views::whoami_as_agent))
        // Long-lived SSE: an agent holds this open for its whole session so
        // messages reach it the moment they are sent, instead of on its next poll.
        .route("/api/taskflow/agents/events", get(views::agent_event_stream))
        .route(
            "/api/taskflow/agents/channels",
            get(views::list_channels_as_agent),
        )
        .route("/api/taskflow/agents/agents", get(views::list_agents_as_agent))
        // #127: authoritative open-prompt state for the MCP to hydrate its message
        // gate on connect/reconnect (realtime prompt events are not replayed).
        .route("/api/taskflow/agents/prompts", get(views::list_open_prompts_as_agent))
        // The only authorized way to CREATE a channel. Auto-REST's
        // POST /api/taskflow_agent_channel/ creates a channel with no roster —
        // an orphan its own creator cannot see — and leaves the roster table
        // client-writable, which `visible_channel_ids` then trusts.
        .route("/api/taskflow/channels", post(views::create_channel))
        // The only authorized way to add a person to a channel roster. Membership
        // and identity are resolved server-side; the channel comes from the path.
        .route(
            "/api/taskflow/channels/{channel}/members",
            post(views::add_channel_member),
        )
        // #5918: room administration (see channel_admin.rs for who may).
        .route("/api/taskflow/channels/{channel}", patch(crate::channel_admin::patch))
        .route(
            "/api/taskflow/channels/{channel}/members/{member}",
            delete(crate::channel_admin::remove_member),
        )
        .route("/api/taskflow/channels/{channel}/archive", post(crate::channel_admin::archive))
        // #5949: pins and reactions, people and agents (pins.rs).
        .route("/api/taskflow/channels/{channel}/pins", get(crate::pins::user_list_pins).post(crate::pins::user_pin))
        .route("/api/taskflow/channels/{channel}/pins/{message}", delete(crate::pins::user_unpin))
        .route("/api/taskflow/channels/{channel}/messages/{message}/reactions", post(crate::pins::user_react))
        .route("/api/taskflow/channels/{channel}/reactions", get(crate::pins::user_reactions))
        // #5983: the chat list's Unread / Mentions counts.
        .route("/api/taskflow/projects/{project}/channels/summary", get(crate::summary::for_user))
        .route("/api/taskflow/agents/channels/summary", get(crate::summary::for_agent))
        .route("/api/taskflow/agents/channels/{channel}/pins", get(crate::pins::agent_list_pins).post(crate::pins::agent_pin))
        .route("/api/taskflow/agents/channels/{channel}/pins/{message}", delete(crate::pins::agent_unpin))
        .route("/api/taskflow/agents/channels/{channel}/messages/{message}/reactions", post(crate::pins::agent_react))
        .route("/api/taskflow/agents/channels/{channel}/reactions", get(crate::pins::agent_reactions))
        .route("/api/taskflow/channels/{channel}/unarchive", post(crate::channel_admin::unarchive))
        // #660: a conversation's files, newest first — the Files tab's source.
        // A dedicated route (not auto-REST) because each item carries the
        // SENDER of the message it arrived on, and because the tab wants a
        // keyset cursor rather than page numbers.
        .route(
            "/api/taskflow/channels/{channel}/attachments",
            get(views::list_channel_attachments),
        )
        // Chat threads: one thread (root + replies), and reply counts for the
        // roots on screen. The agent twin reads the same thread.
        .route(
            "/api/taskflow/channels/{channel}/messages/{message}/thread",
            get(crate::threads::get_thread),
        )
        .route(
            "/api/taskflow/agents/channels/{channel}/messages/{message}/thread",
            get(crate::threads::agent_get_thread),
        )
        .route("/api/taskflow/channels/{channel}/threads", get(crate::threads::get_summaries))
        // #5983: following threads.
        .route(
            "/api/taskflow/channels/{channel}/threads/{root}/follow",
            post(crate::follows::follow).delete(crate::follows::unfollow),
        )
        .route("/api/taskflow/channels/{channel}/threads/{root}/read", post(crate::follows::mark_read))
        .route("/api/taskflow/projects/{project}/threads/following", get(crate::follows::following))
        // Mint an agent identity (human-authed): create/reuse a stable
        // `TaskflowAgent` + a fresh credential; returns the raw key once.
        .route("/api/taskflow/agents/link", post(views::link_agent))
        // #605: the agent-authed management routes — an agent whose credential
        // carries `agents:manage` runs the project's agent setup itself: mint
        // agents (`create_agent_as_agent`; never with scopes), write their role
        // instructions, and revoke them. All three are RequireAgent-gated and
        // scoped to the agent's own project; a plain key gets 403.
        .route(
            "/api/taskflow/agents/agent/agents",
            post(views::create_agent_as_agent),
        )
        .route(
            "/api/taskflow/agents/agent/agents/{agent}/instructions",
            put(views::set_agent_instructions_as_agent),
        )
        .route(
            "/api/taskflow/agents/agent/agents/{agent}",
            delete(views::delete_agent_as_agent),
        )
        // Remove an agent (human-authed): owner/admin, or whoever linked it.
        // #1078: PATCH renames / sets provider and model.
        .route("/api/taskflow/agents/{agent}", delete(views::delete_agent).patch(crate::profile::patch))
        // #1136: rotate an agent's key, or stop one, without deleting the agent.
        .route("/api/taskflow/agents/{agent}/rotate-key", post(crate::keys::rotate_key))
        .route("/api/taskflow/agents/{agent}/credentials/{credential}/revoke", post(crate::keys::revoke_key))
        .route(
            "/api/taskflow/projects/{project}/members/{user}",
            umbral::web::patch(crate::members::set_role).delete(crate::members::remove),
        )
        // #1078 / group 9: change an agent's capabilities without a new key (owner/admin).
        .route("/api/taskflow/agents/{agent}/scopes", umbral::web::patch(views::set_agent_scopes))
        // #615: replace an agent's role instructions (human-authed): owner/admin,
        // or whoever linked it — the delete rule. No agent-authed write exists.
        .route(
            "/api/taskflow/agents/{agent}/instructions",
            put(views::set_agent_instructions),
        )
        // Agent-authored send (agent-authed via `RequireAgent`). Accepts JSON or
        // multipart with attachments, so it needs the same raised body limit as
        // the human send — axum's 2 MiB default would reject uploads well under
        // the 25 MB per-file cap.
        .route(
            "/api/taskflow/agents/agent/messages",
            post(views::send_message_as_agent)
                .layer(DefaultBodyLimit::max(SEND_MESSAGE_BODY_LIMIT)),
        )
        // Human-authed: edit your OWN message's body. Authorship is the gate —
        // channel membership grants reading, never revising someone else's
        // words. Stamps `edited_at`; the update fans out over realtime so the
        // UI reconciles in place and the MCP redelivers to agent panes.
        .route(
            "/api/taskflow/messages/{message}/edit",
            post(views::edit_message),
        )
        // #1099: answer a message's questions in place. Append-only rows in
        // `taskflow_message_answer`; the question message itself is never
        // written (an update would re-type it into every agent pane as an
        // edit). Each submit posts one auto-reply to the asker.
        .route(
            "/api/taskflow/messages/{message}/answers",
            get(crate::answers::get_answers).post(crate::answers::answer),
        )
        .route(
            "/api/taskflow/agents/messages/{message}/answers",
            get(crate::answers::get_answers_as_agent).post(crate::answers::answer_as_agent),
        )
        .route(
            "/api/taskflow/channels/{channel}/answers",
            get(crate::answers::channel_answers),
        )
        // #1095: claim a message ("answering…"). One open claim per message,
        // enforced by a partial unique index (claims::install_claim_guard).
        .route(
            "/api/taskflow/messages/{message}/claim",
            get(crate::claims::get_as_user).post(crate::claims::claim_as_user).delete(crate::claims::release_as_user),
        )
        .route(
            "/api/taskflow/agents/messages/{message}/claim",
            get(crate::claims::get_as_agent).post(crate::claims::claim_as_agent).delete(crate::claims::release_as_agent),
        )
        .route(
            "/api/taskflow/channels/{channel}/claims",
            get(crate::claims::channel_claims),
        )
        // #1096: a channel's pinned current state (append-only history).
        .route(
            "/api/taskflow/channels/{channel}/state",
            get(crate::channel_state::get_as_user).post(crate::channel_state::set_as_user),
        )
        .route(
            "/api/taskflow/agents/channels/{channel}/state",
            get(crate::channel_state::get_as_agent).post(crate::channel_state::set_as_agent),
        )
        // #1113: wake-up rules. Humans (members) manage any rule in the project;
        // agents manage the rules they made or that wake them.
        .route(
            "/api/taskflow/wakeups/{project}",
            get(crate::wakeups::list_as_user).post(crate::wakeups::create_as_user),
        )
        .route(
            "/api/taskflow/wakeups/{project}/{rule}/{action}",
            post(crate::wakeups::act_as_user),
        )
        .route(
            "/api/taskflow/agents/wakeups",
            get(crate::wakeups::list_as_agent).post(crate::wakeups::create_as_agent),
        )
        .route(
            "/api/taskflow/agents/wakeups/{rule}/{action}",
            post(crate::wakeups::act_as_agent),
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
        // A question the agent's terminal is blocked on: reported when it
        // appears, cleared when it leaves the screen.
        .route(
            "/api/taskflow/agents/sessions/{session}/prompt",
            post(views::report_session_prompt),
        )
        .route(
            "/api/taskflow/agents/sessions/{session}/prompt/clear",
            post(views::clear_session_prompt),
        )
        // Human-authed: answer what the agent is waiting on.
        .route(
            "/api/taskflow/prompts/{prompt}/answer",
            post(views::answer_prompt),
        )
        // Human-authed: DISMISS a prompt (not answer it) — for a card whose
        // question the agent's terminal already resolved and the MCP missed the
        // transition for. The only human-driven way to open the #127 message
        // gate on a prompt that is stuck `pending`; emits the same `:prompts`
        // event the agent-driven clears do, so a running agent un-blocks without
        // a reconnect.
        .route(
            "/api/taskflow/prompts/{prompt}/cancel",
            post(views::cancel_prompt),
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
            post(views::create_task_as_agent).get(views::list_tasks_as_agent),
        )
        .route(
            "/api/taskflow/agents/tasks/{task}/status",
            post(views::update_task_status_as_agent),
        )
        // Edit a task's content (title/description/notes/priority). Partial:
        // only the fields present in the body are written.
        .route(
            "/api/taskflow/agents/tasks/{task}",
            post(views::update_task_as_agent),
        )
        // Human-authed: send one key to an agent's terminal. Broadcast on the
        // project's terminal_inputs realtime group; the target agent's mirror
        // types it into its pane. Allowlisted keys only.
        .route(
            "/api/taskflow/agents/{agent}/terminal-input",
            post(views::send_terminal_key),
        )
        // Human-authed: attach files (usually images) to a task via multipart, so
        // a human can hand the agent visual context. Needs the raised body limit
        // like the message send — the 2 MiB default would reject real uploads.
        .route(
            "/api/taskflow/tasks/{task}/attachments",
            post(views::upload_task_attachment)
                .layer(DefaultBodyLimit::max(SEND_MESSAGE_BODY_LIMIT)),
        )
        .route(
            "/api/taskflow/agents/tasks/{task}/claim",
            post(views::claim_task_as_agent),
        )
        // Agent-authed: an agent attaches files to a task in its own project —
        // the counterpart of the human route above, so an agent can hang the
        // spec it just wrote on the task it belongs to. Same raised body limit.
        .route(
            "/api/taskflow/agents/tasks/{task}/attachments",
            post(views::upload_task_attachment_as_agent)
                .layer(DefaultBodyLimit::max(SEND_MESSAGE_BODY_LIMIT)),
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
        // #1098: review requests — ask a named reviewer, cancel, and the
        // agent's own list. Answered by that reviewer's review above.
        .route(
            "/api/taskflow/tasks/{task}/review-requests",
            post(crate::review_requests::request_review),
        )
        .route(
            "/api/taskflow/tasks/{task}/agent/review-requests",
            post(crate::review_requests::agent_request_review),
        )
        .route(
            "/api/taskflow/review-requests/{id}/cancel",
            post(crate::review_requests::cancel_request),
        )
        .route(
            "/api/taskflow/agents/review-requests/{id}/cancel",
            post(crate::review_requests::agent_cancel_request),
        )
        .route(
            "/api/taskflow/agents/review-requests",
            get(crate::review_requests::agent_list),
        )
        // #1117: evidence for review — add, list, withdraw (author only).
        .route(
            "/api/taskflow/tasks/{task}/evidence",
            post(crate::evidence::add_evidence).get(crate::evidence::list_evidence),
        )
        .route(
            "/api/taskflow/tasks/{task}/agent/evidence",
            post(crate::evidence::agent_add_evidence).get(crate::evidence::agent_list_evidence),
        )
        .route("/api/taskflow/evidence/{id}", delete(crate::evidence::delete_evidence))
        .route("/api/taskflow/agents/evidence/{id}", delete(crate::evidence::agent_delete_evidence))
        // Agent activity ingest (agent-authed via `RequireAgent`). An agent posts
        // its real actions — single or batch — as `TaskflowTaskActivity` stamped
        // with the agent; a task link is kept only if the task is in the agent's
        // project. JSON only and modestly sized, so the default body limit is fine.
        .route(
            "/api/taskflow/agents/activity",
            post(views::post_activity_as_agent).get(views::list_activity_as_agent),
        )
}
