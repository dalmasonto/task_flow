//! Access control for `/media/<key>` — the `StoragePlugin::media_access` gate.
//!
//! Until 2026-07-31 the media mount was fully public: anyone with a URL got
//! the file, permanently (the classic leaked-link IDOR). This module closes
//! that with the policy dalmas chose: a caller must be authenticated (a human
//! session/bearer token, or an agent key) AND be entitled to the specific file
//! through what it is attached to:
//!
//!   * message attachment → CHANNEL-scoped, mirroring the REST rule in
//!     `rest.rs::visible_channel_ids`: a Direct or Group channel follows its
//!     roster (project membership is deliberately NOT enough — the model
//!     comment on `TaskflowMessageAttachment.channel` records how
//!     project-scoping made every DM's files readable by every member), while
//!     every other kind (Project room, Task, Incident) follows project
//!     membership — the same rule that decides whether the caller can read
//!     the channel's messages at all. A gate stricter than message visibility
//!     403s files the UI legitimately shows (found live: the Project room's
//!     roster held only agents, so every human member was denied).
//!   * task attachment → PROJECT-scoped: an active project member (human) or
//!     an agent belonging to that project.
//!   * superusers bypass both.
//!   * a key that maps to NO attachment row is DENIED (not "public"): orphans
//!     become invisible rather than leaked — the same failure direction the
//!     REST scope chose for NULL channels.
//!
//! Callers: browsers send the session cookie on `<img src>` loads (the FE and
//! API share the site supercodehive.com, so SameSite=Lax still applies);
//! the MCP sends `Authorization: Agent <key>` (see mcp/src/attachment-download.ts,
//! which anticipated exactly this gate).

use axum::http::HeaderMap;
use taskflow_agents::agent_auth::{AgentIdentity, agent_key_from_headers, resolve_agent};
use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowChannelKind,
    taskflow_agent_channel, taskflow_agent_channel_member, TaskflowMessageAttachment,
    taskflow_message_attachment,
};
use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use taskflow_tasks::models::{TaskflowTaskAttachment, taskflow_task_attachment};
use umbral_auth::resolve_identity;

/// Membership status literal — same convention as the plugins' views.
const ACTIVE_MEMBERSHIP: &str = "active";

/// The resolved caller of a media GET.
enum Caller {
    User { id: i64, superuser: bool },
    Agent(AgentIdentity),
}

/// Resolve who is asking. Humans first (session cookie, then bearer token —
/// `resolve_identity`'s own precedence), agents second. `None` = anonymous.
async fn resolve_caller(headers: &HeaderMap) -> Option<Caller> {
    if let Some(identity) = resolve_identity(headers).await {
        // The active user model's pk is i64 here; a non-parsing id would mean
        // a framework contract break, which we treat as unauthenticated
        // rather than crashing the media path.
        let id = identity.user_id.parse::<i64>().ok()?;
        return Some(Caller::User {
            id,
            superuser: identity.is_superuser,
        });
    }
    let raw = agent_key_from_headers(headers)?;
    resolve_agent(&raw).await.map(Caller::Agent)
}

/// May `caller` read files of `channel_id`? Mirrors
/// `rest.rs::visible_channel_ids`, the rule that governs whether the caller
/// can read the channel's MESSAGES: Direct/Group follow their roster; every
/// other kind (Project room, Task, Incident) follows project membership. An
/// unknown channel id denies.
async fn channel_allows(caller: &Caller, channel_id: i64) -> bool {
    let Ok(Some(channel)) = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel_id))
        .first()
        .await
    else {
        return false;
    };
    if matches!(
        channel.kind,
        TaskflowChannelKind::Direct | TaskflowChannelKind::Group
    ) {
        return is_channel_member(caller, channel_id).await;
    }
    has_project_access(caller, channel.project.id()).await
}

/// Is `caller` on `channel_id`'s roster? One indexed row probe; user and
/// agent memberships live in the same roster table.
async fn is_channel_member(caller: &Caller, channel_id: i64) -> bool {
    let base = taskflow_agent_channel_member::CHANNEL.eq(channel_id);
    let filter = match caller {
        Caller::User { id, .. } => base & taskflow_agent_channel_member::USER.eq(*id),
        Caller::Agent(agent) => base & taskflow_agent_channel_member::AGENT.eq(agent.agent_id),
    };
    matches!(
        TaskflowAgentChannelMember::objects().filter(filter).first().await,
        Ok(Some(_))
    )
}

/// Is `caller` entitled to `project_id`? Humans need an ACTIVE membership row;
/// an agent is minted into exactly one project, so a simple id compare.
async fn has_project_access(caller: &Caller, project_id: i64) -> bool {
    match caller {
        Caller::User { id, .. } => matches!(
            TaskflowProjectMember::objects()
                .filter(
                    taskflow_project_member::PROJECT.eq(project_id)
                        & taskflow_project_member::USER.eq(*id)
                        & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
                )
                .first()
                .await,
            Ok(Some(_))
        ),
        Caller::Agent(agent) => agent.project_id == project_id,
    }
}

/// The `media_access` decision for `GET /media/<key>`. `false` → 403 before
/// any bytes are served.
pub async fn media_access_allowed(headers: &HeaderMap, key: &str) -> bool {
    let Some(caller) = resolve_caller(headers).await else {
        return false; // anonymous → denied, whatever the key
    };
    if let Caller::User { superuser: true, .. } = caller {
        return true;
    }

    // Message attachment? Channel-scoped.
    if let Ok(Some(attachment)) = TaskflowMessageAttachment::objects()
        .filter(taskflow_message_attachment::FILE.eq(key))
        .first()
        .await
    {
        // A NULL channel is denied, not allowed — `RestrictIn` never matches
        // it either, so the failure mode stays "invisible", never "leaked".
        let Some(channel) = attachment.channel.as_ref() else {
            return false;
        };
        return channel_allows(&caller, channel.id()).await;
    }

    // Task attachment? Project-scoped.
    if let Ok(Some(attachment)) = TaskflowTaskAttachment::objects()
        .filter(taskflow_task_attachment::FILE.eq(key))
        .first()
        .await
    {
        return has_project_access(&caller, attachment.project.id()).await;
    }

    // Unmapped key: nothing links it to a project or channel, so nobody but a
    // superuser has a claim to it. Deny.
    false
}
