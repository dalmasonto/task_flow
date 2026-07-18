//! Realtime wiring for the TaskFlow workspace API.
//!
//! The browser subscribes over the Umbral realtime helper at `/realtime/client.js`.
//!
//! **Why per-table groups.** `Expose` sends the *action* as the event name
//! ("created"/"updated"/"deleted") with a projected payload; the table name
//! never reaches the wire, and the client's `model(name, …)` treats `name` as a
//! label only. So a single shared `project:{id}` group means every subscriber
//! receives every model's events and cannot tell them apart — ids collide
//! across tables. The group carries the discriminator instead:
//! `project:{id}:{suffix}`.
//!
//! Chat tables project their fields so the frontend renders straight from the
//! event. Everything else stays id-only and is refetched over authenticated
//! REST. Projected columns reach every group member, so the group policy below
//! admits a caller to `project:{id}:*` only when they are an active member of
//! project `{id}` (superuser: any) — see `may_join`.

use serde_json::Value;
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentSession, TaskflowAgentTerminalFrame,
    TaskflowChannelReadCursor, TaskflowMessageAttachment, TaskflowTaskReview,
};
use taskflow_projects::models::{
    TaskflowProject, TaskflowProjectApiEndpoint, TaskflowProjectInvite, TaskflowProjectMember,
};
use taskflow_tasks::models::{
    TaskflowTask, TaskflowTaskActivity, TaskflowTaskRelation, TaskflowTaskSession,
};
use umbral_realtime::{Expose, PresenceSpec, RealtimePlugin};

const PROJECTS_GROUP: &str = "taskflow:projects";

/// Group suffixes. These strings are a contract with the frontend's
/// `taskflowGroups` builder in `v2_fe/src/lib/taskflow-api.ts` — they are short
/// labels, not table names, and the two lists must stay identical.
const MESSAGES: &str = "messages";
const MESSAGE_ATTACHMENTS: &str = "message_attachments";
const CHANNELS: &str = "channels";
const CHANNEL_MEMBERS: &str = "channel_members";
const READ_CURSORS: &str = "read_cursors";
const TASKS: &str = "tasks";
const TASK_RELATIONS: &str = "task_relations";
const TASK_ACTIVITY: &str = "task_activity";
const TASK_SESSIONS: &str = "task_sessions";
const TASK_REVIEWS: &str = "task_reviews";
const AGENTS: &str = "agents";
const AGENT_SESSIONS: &str = "agent_sessions";
const AGENT_CREDENTIALS: &str = "agent_credentials";
const TERMINAL_FRAMES: &str = "terminal_frames";
const PROJECT_MEMBERS: &str = "project_members";
const PROJECT_INVITES: &str = "project_invites";
const API_ENDPOINTS: &str = "api_endpoints";
const PRESENCE: &str = "presence";

/// Fields the chat tables put on the wire. Whitelists, not `all_fields()` —
/// every column named here is visible to everyone in the room.
const MESSAGE_FIELDS: &[&str] = &[
    "id",
    "project",
    "channel",
    "task",
    "client_nonce",
    "sender_kind",
    "sender_user",
    "sender_agent",
    "sender_label",
    "body_markdown",
    "priority",
    "created_at",
];
const CHANNEL_FIELDS: &[&str] = &[
    "id",
    "project",
    "title",
    "topic",
    "kind",
    "task",
    "archived",
    "created_at",
];
const CHANNEL_MEMBER_FIELDS: &[&str] = &[
    "id",
    "project",
    "channel",
    "member_kind",
    "user",
    "agent",
    "display_name",
    "role",
    "joined_at",
];
/// Attachment columns the frontend needs to render an inline image or a
/// download row. `file` is the storage key; the client resolves the display URL
/// as `/media/<key>` (the same value `FileField::url()` produces).
const MESSAGE_ATTACHMENT_FIELDS: &[&str] = &[
    "id",
    "message",
    "project",
    "file",
    "name",
    "content_type",
    "size_bytes",
    "created_at",
];
/// Terminal frames stream live: a producing agent posts one frame per line, and
/// refetching each over REST would be a round-trip per line. So the frame's
/// fields are projected inline (like the chat tables) and the frontend renders
/// straight from the event. Every column named here is visible to every member
/// of the room — terminal output is already shared workspace state.
const TERMINAL_FRAME_FIELDS: &[&str] = &[
    "id",
    "project",
    "agent",
    "session",
    "task",
    "stream",
    "sequence",
    "content",
    "created_at",
];

/// Build the configured realtime plugin.
pub fn plugin() -> RealtimePlugin {
    RealtimePlugin::new()
        // The SPA uses bearer tokens for REST, so accept the same Authorization
        // header for SSE/WS handshakes. Session cookies still work for /admin.
        .identity_resolver(|headers| async move {
            umbral_auth::resolve_identity(&headers)
                .await
                .map(|identity| identity.user_id)
        })
        // Membership-gated: a caller may join `project:{id}:*` only if they are
        // an active member of project `{id}` (or a superuser). The projects-list
        // group stays open to any authenticated user — it carries id-only
        // events and the details behind them are refetched over REST, which is
        // itself membership-scoped. See `may_join`.
        .group_policy_fn(|user, group| may_join(user, group))
        // Presence gets its own group. Matching every `project:` prefix would
        // now spin up one presence set per table.
        .with_presence(PresenceSpec::matching(|group| {
            group.starts_with("project:") && group.ends_with(":presence")
        }))
        // Project list changes. Id-only; clients refetch via REST.
        .expose::<TaskflowProject>(Expose::to_group(PROJECTS_GROUP))
        // Chat: fields projected so the frontend never refetches.
        .expose::<TaskflowAgentMessage>(
            Expose::to_group_with(|ev| group_for(MESSAGES, &ev.instance)).fields(MESSAGE_FIELDS),
        )
        .expose::<TaskflowAgentChannel>(
            Expose::to_group_with(|ev| group_for(CHANNELS, &ev.instance)).fields(CHANNEL_FIELDS),
        )
        .expose::<TaskflowAgentChannelMember>(
            Expose::to_group_with(|ev| group_for(CHANNEL_MEMBERS, &ev.instance))
                .fields(CHANNEL_MEMBER_FIELDS),
        )
        // Attachments: fields projected so other clients merge new files by
        // their `message` FK without a refetch (same posture as chat).
        .expose::<TaskflowMessageAttachment>(
            Expose::to_group_with(|ev| group_for(MESSAGE_ATTACHMENTS, &ev.instance))
                .fields(MESSAGE_ATTACHMENT_FIELDS),
        )
        // Everything else: id-only, client refetches the one row that changed.
        .expose::<TaskflowProjectMember>(Expose::to_group_with(|ev| {
            group_for(PROJECT_MEMBERS, &ev.instance)
        }))
        .expose::<TaskflowProjectInvite>(Expose::to_group_with(|ev| {
            group_for(PROJECT_INVITES, &ev.instance)
        }))
        .expose::<TaskflowProjectApiEndpoint>(Expose::to_group_with(|ev| {
            group_for(API_ENDPOINTS, &ev.instance)
        }))
        .expose::<TaskflowTask>(Expose::to_group_with(|ev| group_for(TASKS, &ev.instance)))
        .expose::<TaskflowTaskRelation>(Expose::to_group_with(|ev| {
            group_for(TASK_RELATIONS, &ev.instance)
        }))
        .expose::<TaskflowTaskActivity>(Expose::to_group_with(|ev| {
            group_for(TASK_ACTIVITY, &ev.instance)
        }))
        .expose::<TaskflowTaskSession>(Expose::to_group_with(|ev| {
            group_for(TASK_SESSIONS, &ev.instance)
        }))
        // Task reviews: id-only ping so subscribers refetch the reviewed task
        // and its new review row over authenticated REST.
        .expose::<TaskflowTaskReview>(Expose::to_group_with(|ev| {
            group_for(TASK_REVIEWS, &ev.instance)
        }))
        .expose::<TaskflowAgent>(Expose::to_group_with(|ev| group_for(AGENTS, &ev.instance)))
        .expose::<TaskflowAgentCredential>(Expose::to_group_with(|ev| {
            group_for(AGENT_CREDENTIALS, &ev.instance)
        }))
        .expose::<TaskflowAgentSession>(Expose::to_group_with(|ev| {
            group_for(AGENT_SESSIONS, &ev.instance)
        }))
        // Terminal frames: fields projected so a subscribed terminal panel
        // renders each line straight from the event (no per-frame REST refetch).
        .expose::<TaskflowAgentTerminalFrame>(
            Expose::to_group_with(|ev| group_for(TERMINAL_FRAMES, &ev.instance))
                .fields(TERMINAL_FRAME_FIELDS),
        )
        // Read cursors: id-only ping so the other side learns a read happened and
        // refetches the cursor rows to recompute unread counts.
        .expose::<TaskflowChannelReadCursor>(Expose::to_group_with(|ev| {
            group_for(READ_CURSORS, &ev.instance)
        }))
}

/// `project:{id}:{suffix}` for a row carrying a `project` FK, else the
/// project-level group.
pub fn group_for(suffix: &str, instance: &Value) -> String {
    instance
        .get("project")
        .and_then(value_to_group_id)
        .map(|id| format!("project:{id}:{suffix}"))
        .unwrap_or_else(|| PROJECTS_GROUP.to_string())
}

/// The full join policy: a well-formed group name (see [`can_join_group`]) AND,
/// for a project room, an active membership in that project.
///
/// `user` is the caller's pk string (or `None` for anonymous). Split from
/// [`can_join_group`] so the pure name-shape checks stay synchronous and
/// trivially unit-testable, while the membership check — which needs a DB
/// round-trip — is isolated here.
///
/// ## Why a blocking DB call
///
/// `GroupPolicy::can_join` is **synchronous** in `umbral-realtime`, so the
/// membership query cannot be `.await`ed directly. The server runs on the
/// multi-threaded Tokio runtime (`#[tokio::main]`), where
/// [`tokio::task::block_in_place`] + a runtime handle is the sanctioned way to
/// drive a future to completion from a sync context: it hands the worker's other
/// tasks to a sibling thread first, so it does not stall the executor. It would
/// **panic** on a current-thread runtime, which is why the membership tests run
/// under `#[tokio::test(flavor = "multi_thread")]`.
///
/// The clean long-term fix is an async `GroupPolicy` upstream in
/// `umbral-realtime`; until then this closes the leak (a non-member receiving
/// projected `body_markdown` over SSE) without a per-join thread stall in
/// production.
pub fn may_join(user: Option<&str>, group: &str) -> bool {
    // Reject malformed / unknown group names up front — no DB work for them.
    if !can_join_group(group) {
        return false;
    }
    // Anonymous callers get nothing (the projects-list group included: SSE
    // needs an identity to be useful, and REST is the scoped source of truth).
    let Some(uid) = user else {
        return false;
    };
    // The projects-list group is not project-specific; any authenticated user
    // may listen to id-only project events.
    if group == PROJECTS_GROUP {
        return true;
    }
    // `project:{id}:{suffix}` — `can_join_group` already validated the shape,
    // so the split and the non-empty id are guaranteed here.
    let Some((id, _suffix)) = group
        .strip_prefix("project:")
        .and_then(|rest| rest.split_once(':'))
    else {
        return false;
    };
    let (Ok(user_id), Ok(project_id)) = (uid.parse::<i64>(), id.parse::<i64>()) else {
        return false; // non-integer pk or project id: fail closed
    };
    membership_gate(user_id, project_id)
}

/// Run the async membership check from `can_join`'s synchronous context. Safe
/// only on the multi-threaded runtime — see [`may_join`].
fn membership_gate(user_id: i64, project_id: i64) -> bool {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current()
            .block_on(async move {
                taskflow_projects::scope::can_access_project(user_id, project_id).await
            })
    })
}

/// Which groups are well-formed and known — a pure name-shape check with no
/// membership component. Extracted so it is testable without a running server;
/// [`may_join`] layers the membership gate on top.
pub fn can_join_group(group: &str) -> bool {
    if group == PROJECTS_GROUP {
        return true;
    }
    let Some(rest) = group.strip_prefix("project:") else {
        return false;
    };
    let Some((id, suffix)) = rest.split_once(':') else {
        return false;
    };
    !id.is_empty() && ALL_SUFFIXES.contains(&suffix)
}

const ALL_SUFFIXES: &[&str] = &[
    MESSAGES,
    MESSAGE_ATTACHMENTS,
    CHANNELS,
    CHANNEL_MEMBERS,
    READ_CURSORS,
    TASKS,
    TASK_RELATIONS,
    TASK_ACTIVITY,
    TASK_SESSIONS,
    TASK_REVIEWS,
    AGENTS,
    AGENT_SESSIONS,
    AGENT_CREDENTIALS,
    TERMINAL_FRAMES,
    PROJECT_MEMBERS,
    PROJECT_INVITES,
    API_ENDPOINTS,
    PRESENCE,
];

fn value_to_group_id(value: &Value) -> Option<String> {
    match value {
        Value::Number(n) => n.as_i64().map(|id| id.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(obj) => obj.get("id").and_then(value_to_group_id),
        _ => None,
    }
}
