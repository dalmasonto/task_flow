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
//! REST — projected columns reach every group member, and the group policy
//! below still admits any authenticated user to any project room.

use serde_json::Value;
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentSession, TaskflowAgentTerminalFrame,
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
const CHANNELS: &str = "channels";
const CHANNEL_MEMBERS: &str = "channel_members";
const TASKS: &str = "tasks";
const TASK_RELATIONS: &str = "task_relations";
const TASK_ACTIVITY: &str = "task_activity";
const TASK_SESSIONS: &str = "task_sessions";
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
        // Still permissive: any authenticated user may join any project room.
        // Row-level membership checks land with the permissions sub-project.
        .group_policy_fn(|user, group| user.is_some() && can_join_group(group))
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
        .expose::<TaskflowAgent>(Expose::to_group_with(|ev| group_for(AGENTS, &ev.instance)))
        .expose::<TaskflowAgentCredential>(Expose::to_group_with(|ev| {
            group_for(AGENT_CREDENTIALS, &ev.instance)
        }))
        .expose::<TaskflowAgentSession>(Expose::to_group_with(|ev| {
            group_for(AGENT_SESSIONS, &ev.instance)
        }))
        .expose::<TaskflowAgentTerminalFrame>(Expose::to_group_with(|ev| {
            group_for(TERMINAL_FRAMES, &ev.instance)
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

/// Which groups a client may join. Extracted so it is testable without a
/// running server.
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
    CHANNELS,
    CHANNEL_MEMBERS,
    TASKS,
    TASK_RELATIONS,
    TASK_ACTIVITY,
    TASK_SESSIONS,
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
