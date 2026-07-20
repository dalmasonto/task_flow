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
//! **What may be projected.** A projected column reaches every subscriber of the
//! group, and groups here are per-PROJECT. So a table may carry fields only if
//! every project member is entitled to every row of it. Terminal frames, agent
//! sessions, prompts and task activity qualify — they are shared workspace state
//! and already readable project-wide over REST.
//!
//! The chat tables do NOT. They are channel-scoped (`rest.rs`), so projecting
//! them broadcast every DM to the whole project; they are id-only and refetched
//! over channel-scoped REST. See `tests/realtime_dm_privacy.rs`.
//!
//! The group policy below admits a caller to `project:{id}:*` only when they are
//! an active member of project `{id}` (superuser: any) — see `may_join`. That
//! gate is necessary but NOT sufficient for row privacy: it distinguishes
//! members from non-members and knows nothing about channel rosters.

use serde_json::Value;
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentPrompt, TaskflowAgentSession, TaskflowAgentTerminalFrame,
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
const PROMPTS: &str = "prompts";
const PROJECT_MEMBERS: &str = "project_members";
const PROJECT_INVITES: &str = "project_invites";
const API_ENDPOINTS: &str = "api_endpoints";
const PRESENCE: &str = "presence";

// The chat tables carry NO projected fields — see the `expose` calls below for
// why. Their former `*_FIELDS` whitelists are deliberately gone rather than
// trimmed: any whitelist here is delivered to the whole project room, so there
// is no subset of a DM's columns that is safe to name.

/// Agent sessions are projected inline for the same reason as terminal frames,
/// but the trigger is subtler: appending a frame BUMPS the session's
/// `last_seen_at`, so a streaming agent emits a session event for every frame it
/// sends. Left id-only, each of those cost the frontend a REST refetch of the
/// same row — a request per frame, which reads as "the UI is polling" even
/// though nothing is on a timer. Every column here is already readable over REST
/// by any project member; projecting them adds no exposure, only saves the trip.
/// Deliberately the COMPLETE row, not a subset: the frontend replaces its stored
/// session with whatever the event carries, so any column omitted here would be
/// silently blanked on the first live update (`connected_by` drives an "Unlinked"
/// label, and would have started lying the moment an agent streamed).
const AGENT_SESSION_FIELDS: &[&str] = &[
    "id",
    "project",
    "agent",
    "connected_by",
    "created_at",
    "session_identifier",
    "host",
    "pid",
    "cwd",
    "transport",
    "status",
    "connected_at",
    "last_seen_at",
    "disconnected_at",
];
/// Everything about a pending question. The complete row for the same reason as
/// sessions: the frontend replaces its stored copy with the event payload.
const PROMPT_FIELDS: &[&str] = &[
    "id", "project", "agent", "session", "question", "options_json", "kind", "fingerprint",
    "status", "answer", "answer_json", "answered_by", "answered_at", "created_at",
];

/// The whole activity row. Complete, not a subset, for the same reason as
/// sessions: the frontend replaces its stored copy with the event payload, so an
/// omitted column would be blanked on the first live update. `metadata_json` is
/// included because the detail sheet renders it.
const TASK_ACTIVITY_FIELDS: &[&str] = &[
    "id",
    "project",
    "task",
    "actor_kind",
    "actor_user",
    "actor_agent",
    "actor_label",
    "action",
    "body_markdown",
    "metadata_json",
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
        // Chat: id-only, and it must stay that way.
        //
        // These four tables are CHANNEL-scoped (`rest.rs::CHANNEL_SCOPED_TABLES`)
        // but they route to a PROJECT group, because `group_for` can only see the
        // row's `project` FK. So every subscriber in the project receives every
        // chat event — a DM between two members included. Projecting fields here
        // handed the whole project each DM's `body_markdown`, roster row, title
        // and attachment storage key, which is precisely what `channel_scope`
        // exists to prevent over REST.
        //
        // Id-only makes REST the single arbiter of who reads what: the client
        // learns "row N changed" and refetches, and `visible_channel_ids` decides
        // whether it gets anything. A caller off the roster gets a denial, which
        // the frontend treats as expected rather than as a sync error.
        //
        // Do NOT add `.fields(...)` back without making the group per-channel
        // first. See `tests/realtime_dm_privacy.rs`.
        .expose::<TaskflowAgentMessage>(Expose::to_group_with(|ev| {
            group_for(MESSAGES, &ev.instance)
        }))
        .expose::<TaskflowAgentChannel>(Expose::to_group_with(|ev| {
            group_for(CHANNELS, &ev.instance)
        }))
        .expose::<TaskflowAgentChannelMember>(Expose::to_group_with(|ev| {
            group_for(CHANNEL_MEMBERS, &ev.instance)
        }))
        .expose::<TaskflowMessageAttachment>(Expose::to_group_with(|ev| {
            group_for(MESSAGE_ATTACHMENTS, &ev.instance)
        }))
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
        // Activity is projected inline: the feed is append-only and high volume
        // (a row per tool call), so an id-only ping would cost the activity page
        // one REST round-trip PER EVENT just to prepend a line it could already
        // have been handed.
        .expose::<TaskflowTaskActivity>(
            Expose::to_group_with(|ev| group_for(TASK_ACTIVITY, &ev.instance))
                .fields(TASK_ACTIVITY_FIELDS),
        )
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
        // Sessions: projected inline — a frame append bumps `last_seen_at`, so
        // these fire once per streamed frame and must not each cost a refetch.
        .expose::<TaskflowAgentSession>(
            Expose::to_group_with(|ev| group_for(AGENT_SESSIONS, &ev.instance))
                .fields(AGENT_SESSION_FIELDS),
        )
        // Prompts: projected inline in BOTH directions — the browser renders the
        // options from the event, and the agent reads the answer off it to know
        // which keys to press. An id-only ping would make answering a question
        // cost a refetch on the critical path.
        .expose::<TaskflowAgentPrompt>(
            Expose::to_group_with(|ev| group_for(PROMPTS, &ev.instance)).fields(PROMPT_FIELDS),
        )
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
    PROMPTS,
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
