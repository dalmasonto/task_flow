//! Realtime wiring for the TaskFlow workspace API.
//!
//! The browser subscribes over the Umbral realtime helper at `/realtime/client.js`.
//! We broadcast id-only model change events and let the frontend refetch through
//! the normal authenticated REST client. That keeps the stream small and avoids
//! leaking fields through a side channel.

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
const AGENTS_GROUP: &str = "taskflow:agents";

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
        // Initial implementation: any authenticated user may join TaskFlow
        // project rooms. Row-level membership checks can replace this once the
        // project-member API starts enforcing ownership server-side.
        .group_policy_fn(|user, group| {
            user.is_some()
                && (group == PROJECTS_GROUP
                    || group == AGENTS_GROUP
                    || group
                        .strip_prefix("project:")
                        .is_some_and(|id| !id.is_empty()))
        })
        .with_presence(PresenceSpec::matching(|group| {
            group.starts_with("project:")
        }))
        // Project list changes. Payload is `{ id }`; clients refetch via REST.
        .expose::<TaskflowProject>(Expose::to_group(PROJECTS_GROUP))
        // Project-scoped workspace resources.
        .expose::<TaskflowProjectMember>(Expose::to_group_with(project_group))
        .expose::<TaskflowProjectInvite>(Expose::to_group_with(project_group))
        .expose::<TaskflowProjectApiEndpoint>(Expose::to_group_with(project_group))
        .expose::<TaskflowTask>(Expose::to_group_with(project_group))
        .expose::<TaskflowTaskRelation>(Expose::to_group_with(project_group))
        .expose::<TaskflowTaskActivity>(Expose::to_group_with(project_group))
        .expose::<TaskflowTaskSession>(Expose::to_group_with(project_group))
        .expose::<TaskflowAgent>(Expose::to_group_with(project_group))
        .expose::<TaskflowAgentCredential>(Expose::to_group_with(project_group))
        .expose::<TaskflowAgentSession>(Expose::to_group_with(project_group))
        .expose::<TaskflowAgentChannel>(Expose::to_group_with(project_group))
        .expose::<TaskflowAgentMessage>(Expose::to_group_with(project_group))
        .expose::<TaskflowAgentTerminalFrame>(Expose::to_group_with(project_group))
        // Channel members only carry `channel`, not `project`, so they use the
        // authenticated agent-wide feed until channel-scoped rooms exist.
        .expose::<TaskflowAgentChannelMember>(Expose::to_group(AGENTS_GROUP))
}

fn project_group(ev: &umbral_realtime::ModelEvent) -> String {
    ev.instance
        .get("project")
        .and_then(value_to_group_id)
        .map(|id| format!("project:{id}"))
        .unwrap_or_else(|| PROJECTS_GROUP.to_string())
}

fn value_to_group_id(value: &Value) -> Option<String> {
    match value {
        Value::Number(n) => n.as_i64().map(|id| id.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(obj) => obj.get("id").and_then(value_to_group_id),
        _ => None,
    }
}
