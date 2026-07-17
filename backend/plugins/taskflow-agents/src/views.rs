//! HTTP handlers for the `taskflow-agents` plugin.

use serde::Deserialize;
use serde_json::json;
use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use umbral::orm::ForeignKey;
use umbral::web::{IntoResponse, Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use crate::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind,
    TaskflowChannelMemberKind, TaskflowMessagePriority, taskflow_agent_channel,
    taskflow_agent_channel_member, taskflow_agent_message,
};

/// The stored value of `TaskflowMembershipStatus::Active` — the status column is
/// a string at the DB layer, so we compare against this literal (same convention
/// as `taskflow_projects::scope`).
const ACTIVE_MEMBERSHIP: &str = "active";

/// The model caps `body_markdown` at 20000 chars. Rejecting at the edge turns
/// what would otherwise be truncation or a DB-level error into an honest 400.
const MAX_BODY_CHARS: usize = 20_000;

pub async fn health() -> &'static str {
    "taskflow-agents:ok"
}

/// The client says what it wants to say — never who it is. Sender identity,
/// project scope, and membership are all resolved server-side.
///
/// The fields a client is NOT allowed to assert (`sender_kind`, `sender_user`,
/// `sender_label`, `project`) are simply absent from this struct, so serde
/// drops them. That is the whole point of the endpoint: there is no field to
/// lie in.
#[derive(Debug, Deserialize)]
pub struct SendMessageInput {
    pub channel: i64,
    pub body_markdown: String,
    #[serde(default)]
    pub priority: Option<TaskflowMessagePriority>,
    #[serde(default)]
    pub client_nonce: Option<String>,
}

/// `POST /api/taskflow/agents/messages` — the only trusted write path for
/// messages.
///
/// `RequireAuth<i64>` is the authentication gate: it hands back the caller's
/// user id already typed and rejects anonymous callers with a 401, so there is
/// no unauthenticated code path here to forget.
pub async fn send_message(
    RequireAuth(user_id): RequireAuth<i64>,
    Json(input): Json<SendMessageInput>,
) -> Result<Json<TaskflowAgentMessage>, StatusCode> {
    let body = input.body_markdown.trim();
    if body.is_empty() || body.chars().count() > MAX_BODY_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }

    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(input.channel))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Membership is the authorization boundary: you may only speak in rooms
    // you have joined. Checked BEFORE the idempotency lookup on purpose — the
    // nonce is scoped to (channel, nonce) and carries no sender, so replaying
    // a guessed nonce ahead of this gate would hand a non-member back the
    // contents of a message they are not allowed to read.
    //
    // Two membership concepts can authorize a post:
    //   1. An explicit channel-roster row (`TaskflowAgentChannelMember`) — the
    //      caller was added to this specific channel.
    //   2. For SHARED project rooms only (Project / Task / Incident), active
    //      membership of the channel's project. Project membership already
    //      grants READ access to a project's shared rooms via SP-A scoping, so
    //      it should grant POST access to those same rooms — otherwise a
    //      legitimate project member can see and read a room but not speak in
    //      it. DMs (`Direct`) are exempt: they stay private to their explicit
    //      roster, so a project member is NOT let into a DM they weren't added
    //      to.
    //
    // The roster row is not auto-created here (there is no unique_together on
    // (channel, user), so a concurrent auto-insert could duplicate the row).
    // The fallback authorizes the post; it does not join the roster.
    let sender_label = match TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel.id)
                & taskflow_agent_channel_member::USER.eq(user_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        Some(channel_member) => channel_member.display_name,
        None => {
            // No roster row. DMs are private to their explicit roster.
            if channel.kind == TaskflowChannelKind::Direct {
                return Err(StatusCode::FORBIDDEN);
            }
            // Shared project room: an active project member may post.
            let project_member = TaskflowProjectMember::objects()
                .filter(
                    taskflow_project_member::PROJECT.eq(channel.project.id())
                        & taskflow_project_member::USER.eq(user_id)
                        & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
                )
                .first()
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .ok_or(StatusCode::FORBIDDEN)?;
            project_member.display_name
        }
    };

    // Idempotency: the same nonce in the same channel is the same message.
    // A retry after a dropped response must not double-post.
    if let Some(nonce) = input.client_nonce.as_deref().filter(|n| !n.is_empty()) {
        let existing = TaskflowAgentMessage::objects()
            .filter(
                taskflow_agent_message::CHANNEL.eq(channel.id)
                    & taskflow_agent_message::CLIENT_NONCE.eq(nonce),
            )
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(row) = existing {
            return Ok(Json(row));
        }
    }

    // Every identity-bearing field below is derived, never accepted: `project`
    // and `task` from the channel, the sender trio from the authenticated
    // caller's own membership row.
    let message = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: channel.project.clone(),
            channel: ForeignKey::new(channel.id),
            task: channel.task.clone(),
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: Some(ForeignKey::new(user_id)),
            sender_agent: None,
            sender_label,
            body_markdown: body.to_string(),
            priority: input.priority.unwrap_or(TaskflowMessagePriority::Normal),
            client_nonce: input.client_nonce.clone(),
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(message))
}

/// The role stamped on a roster row minted through this endpoint. The channel
/// roster carries its own `role` string independent of the project role — a
/// person's standing in a channel is "member" regardless of whether they are a
/// developer or a viewer of the project. Kept deliberately constant so the value
/// is predictable and this endpoint never leaks a project's role hierarchy into
/// the channel roster.
const CHANNEL_ROLE_MEMBER: &str = "member";

/// The only field a client may assert: which person to add. The channel comes
/// from the PATH and the caller's identity from the auth token — neither is a
/// body field, so there is nothing to forge. Agents are out of scope: this
/// endpoint adds people (`user`), never agents.
#[derive(Debug, Deserialize)]
pub struct AddChannelMemberInput {
    pub user: i64,
}

/// The 400 body for "the target isn't a project member", shaped like auto-REST's
/// field-error envelope (`code` + a per-field message array) so the frontend can
/// render it inline against the `user` input exactly as it would any validation
/// rejection.
fn not_a_project_member_response() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "code": "not_a_project_member",
            "user": ["That user is not an active member of this project."],
        })),
    )
        .into_response()
}

/// `POST /api/taskflow/channels/{channel}/members`
///
/// Explicitly add a person to a channel's roster (`TaskflowAgentChannelMember`).
/// Channel rosters were previously only ever created client-side when a channel
/// was first made, so a project member who joined later was on no channel's
/// roster and there was no way to put them on one. This is that missing write
/// path — needed for the member list and required for DMs.
///
/// AUTHORIZATION mirrors `send_message`'s membership logic:
///   * The CALLER must be an ACTIVE `TaskflowProjectMember` of the channel's
///     project (else 403). Active project membership already grants read/post
///     access to a project's shared rooms, so it also authorizes managing their
///     rosters.
///   * ADDITIONALLY, for a `Direct` channel the caller must ALSO already be on
///     that channel's roster (else 403): a DM stays private to its explicit
///     roster, so only someone already in the DM may pull another person in.
///     Shared rooms (Project / Task / Incident) need only active project
///     membership.
///
/// The TARGET must be an ACTIVE `TaskflowProjectMember` of the same project —
/// you cannot add someone who isn't in the project (400, field-error body).
///
/// IDEMPOTENT: the `(channel, user)` unique index makes a roster row unique per
/// person; if one already exists this returns it (200) rather than inserting a
/// duplicate. A fresh add returns the created row (201).
pub async fn add_channel_member(
    RequireAuth(caller_id): RequireAuth<i64>,
    Path(channel_id): Path<i64>,
    Json(input): Json<AddChannelMemberInput>,
) -> Result<Response, StatusCode> {
    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_id = channel.project.id();

    // Caller gate: an active project member of THIS project. Read from the table,
    // never trusted from the request. Absent → 403.
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(caller_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    // DM carve-out: a Direct channel stays private to its explicit roster, so the
    // caller must already be ON that roster to add anyone. Active project
    // membership is not enough for a DM (mirrors the `send_message` Direct
    // exemption).
    if channel.kind == TaskflowChannelKind::Direct {
        TaskflowAgentChannelMember::objects()
            .filter(
                taskflow_agent_channel_member::CHANNEL.eq(channel.id)
                    & taskflow_agent_channel_member::USER.eq(caller_id),
            )
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::FORBIDDEN)?;
    }

    // Target gate: the person being added must be an active project member too —
    // you cannot add an outsider. A clear field error the frontend can render
    // inline, not a bare 400.
    let target_member = match TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(input.user)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        Some(member) => member,
        None => return Ok(not_a_project_member_response()),
    };

    // Idempotent: the roster row is unique per (channel, user). If it already
    // exists, hand it back (200) rather than inserting a duplicate — the same
    // guarantee the DB's unique index enforces, surfaced as a clean 200.
    if let Some(existing) = TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel.id)
                & taskflow_agent_channel_member::USER.eq(input.user),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Ok((StatusCode::OK, Json(existing)).into_response());
    }

    // Every identity-bearing field is derived, never accepted: `project` from the
    // channel, the display name from the target's own project membership, the
    // member kind fixed to `User` (agents are out of scope for this endpoint).
    let created = TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project_id),
            channel: ForeignKey::new(channel.id),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(input.user)),
            agent: None,
            display_name: target_member.display_name.clone(),
            role: CHANNEL_ROLE_MEMBER.to_string(),
            joined_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((StatusCode::CREATED, Json(created)).into_response())
}
