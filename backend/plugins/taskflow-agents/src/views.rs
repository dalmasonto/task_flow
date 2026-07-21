//! HTTP handlers for the `taskflow-agents` plugin.

use std::collections::HashSet;

use axum::body::Bytes;
use serde::Deserialize;
use serde_json::json;
use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use taskflow_tasks::models::{
    TaskflowActorKind, TaskflowTask, TaskflowTaskActivity, TaskflowTaskAttachment,
    TaskflowTaskPriority, TaskflowTaskStatus, taskflow_task, taskflow_task_activity,
    taskflow_task_attachment,
};
use umbral::orm::{FileField, ForeignKey};
use umbral::storage::storage_opt;
use umbral::web::multipart::{FilePart, is_multipart, parse_multipart};
use umbral::web::{HeaderMap, IntoResponse, Json, Path, Query, Response, StatusCode, header};
use umbral_auth::{AuthUser, RequireAuth, auth_user};
use uuid::Uuid;

use crate::agent_auth::{RequireAgent, hash_key};
use crate::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentPrompt, TaskflowAgentSession, TaskflowAgentSessionStatus,
    TaskflowAgentStatus, TaskflowAgentTerminalFrame, TaskflowChannelKind, TaskflowChannelMemberKind,
    TaskflowChannelReadCursor, TaskflowCredentialStatus, TaskflowMessageAttachment,
    TaskflowMessagePriority, TaskflowPromptStatus, TaskflowReviewDecision, TaskflowTaskReview,
    TaskflowTerminalInput, TaskflowTerminalStream, taskflow_agent, taskflow_agent_channel,
    taskflow_agent_channel_member,
    taskflow_agent_message, taskflow_agent_prompt, taskflow_agent_session,
    taskflow_agent_terminal_frame, taskflow_channel_read_cursor, taskflow_message_attachment,
};

/// The stored value of `TaskflowMembershipStatus::Active` — the status column is
/// a string at the DB layer, so we compare against this literal (same convention
/// as `taskflow_projects::scope`).
const ACTIVE_MEMBERSHIP: &str = "active";

/// The model caps `body_markdown` at 20000 chars. Rejecting at the edge turns
/// what would otherwise be truncation or a DB-level error into an honest 400.
const MAX_BODY_CHARS: usize = 20_000;

/// Per-file upload cap, matching the media backend's default. Checked up front,
/// before the message is created, so an oversized file rejects the whole
/// request (413) cleanly — the message is never saved half-formed rather than
/// created and then left without the attachment that failed to store.
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

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
    /// #29: direct this message to one agent's pane (null broadcasts).
    #[serde(default)]
    pub target_agent: Option<i64>,
}

/// The single attachment projection, shared by every path that returns one.
///
/// Both `file` (the storage key, matching the model/realtime representation)
/// and the resolved `url` are emitted, so a client can key off `file` uniformly
/// regardless of which path delivered the row.
///
/// This exists as its own function because the send path and the agent read path
/// previously serialized attachments separately — the read path simply omitted
/// them, and nothing caught it. One projection, two call sites.
fn attachment_json(a: &TaskflowMessageAttachment) -> serde_json::Value {
    json!({
        "id": a.id,
        "message": a.message.id(),
        "project": a.project.id(),
        "file": a.file.key(),
        "url": a.file.url(),
        "name": a.name,
        "content_type": a.content_type,
        "size_bytes": a.size_bytes,
        "created_at": a.created_at,
    })
}

/// One task-attachment projection — mirrors [`attachment_json`] for messages:
/// both the storage `file` key and the resolved `url`, so the dashboard shows
/// the file inline and the agent's `download_attachment` can pull it.
fn task_attachment_json(a: &TaskflowTaskAttachment) -> serde_json::Value {
    json!({
        "id": a.id,
        "task": a.task.id(),
        "project": a.project.id(),
        "file": a.file.key(),
        "url": a.file.url(),
        "name": a.name,
        "content_type": a.content_type,
        "size_bytes": a.size_bytes,
        "created_at": a.created_at,
    })
}

/// `POST /api/taskflow/tasks/{task}/attachments` (human-authed, multipart) —
/// attach one or more files to a task so a human can hand the agent visual
/// context. The caller must be an active member of the task's project; the
/// attachment inherits that project (never taken from the body). Each file is
/// stored in the ambient backend and recorded as a `TaskflowTaskAttachment`.
/// Returns the created rows (with resolved `/media` urls).
pub async fn upload_task_attachment(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(task_id): Path<i64>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response, StatusCode> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !is_multipart(content_type) {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let form = parse_multipart(content_type, raw_body)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    // A file part carried a filename; bodyless text parts are fields.
    let files: Vec<FilePart> = form
        .files
        .into_iter()
        .filter(|p| p.filename.as_deref().map(|n| !n.is_empty()).unwrap_or(false))
        .collect();
    if files.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    for part in &files {
        if part.bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }

    // Load the task; the attachment inherits its project. Unknown → 404.
    let task = TaskflowTask::objects()
        .get(taskflow_task::ID.eq(task_id))
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let project_id = task.project.id();

    // Authorize: an active member of the task's project.
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    let Some(storage) = storage_opt() else {
        return Ok(storage_unavailable_response());
    };
    let mut created = Vec::with_capacity(files.len());
    for part in files {
        let filename = part
            .filename
            .as_deref()
            .filter(|n| !n.is_empty())
            .unwrap_or("upload")
            .to_string();
        let file_content_type = part
            .content_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let stored = storage
            .store(&filename, &file_content_type, &part.bytes)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let attachment = TaskflowTaskAttachment::objects()
            .create(TaskflowTaskAttachment {
                id: 0,
                project: task.project.clone(),
                task: ForeignKey::new(task.id),
                file: FileField::from(stored.key),
                name: filename,
                content_type: file_content_type,
                size_bytes: stored.size as i64,
                created_at: None,
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        created.push(attachment);
    }

    let items: Vec<serde_json::Value> = created.iter().map(task_attachment_json).collect();
    Ok((StatusCode::CREATED, Json(json!({ "attachments": items }))).into_response())
}

/// Serialize one message with its attachments into a JSON object.
///
/// Text-only messages emit `attachments: []` — an empty array, never an absent
/// key. A reader must be able to distinguish "no files" from "files not
/// reported"; the absent key is what let the read-path gap go unnoticed.
fn message_json(
    message: &TaskflowAgentMessage,
    attachments: &[TaskflowMessageAttachment],
) -> Result<serde_json::Value, StatusCode> {
    let mut value =
        serde_json::to_value(message).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items: Vec<serde_json::Value> = attachments.iter().map(attachment_json).collect();
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("attachments".to_string(), json!(items));
    }
    Ok(value)
}

/// Serialize a message plus its attachments into the endpoint's response body.
///
/// The message's own fields are emitted exactly as the JSON path always
/// returned them (so the frontend's optimistic reconcile keeps working), with
/// an `attachments` array appended.
fn message_response(
    message: &TaskflowAgentMessage,
    attachments: &[TaskflowMessageAttachment],
) -> Result<Response, StatusCode> {
    let value = message_json(message, attachments)?;
    Ok((StatusCode::OK, Json(value)).into_response())
}

/// The 500 body when a file part is present but no storage backend is
/// registered. A file/image model requires `StoragePlugin::media(...)`, so this
/// only fires in a misconfigured deploy — a clear message beats a bare 500.
fn storage_unavailable_response() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "error": "file upload requires a storage backend, but none is registered",
        })),
    )
        .into_response()
}

/// `POST /api/taskflow/agents/messages` — the only trusted write path for
/// messages.
///
/// Accepts **either** `application/json` (text-only, as it always has) **or**
/// `multipart/form-data` (the same message fields plus file parts). Sender
/// identity, project scope, and membership are resolved server-side in both
/// cases — the transport changes nothing about the trust model.
///
/// `RequireAuth<i64>` is the authentication gate: it hands back the caller's
/// user id already typed and rejects anonymous callers with a 401, so there is
/// no unauthenticated code path here to forget. The body is read raw
/// (`Bytes` + `HeaderMap`) so the handler can branch on content-type rather
/// than committing to one extractor.
pub async fn send_message(
    RequireAuth(user_id): RequireAuth<i64>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response, StatusCode> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    // Normalise both transports to the same logical input: the message fields
    // plus any uploaded file parts (JSON posts carry none).
    let (channel_id, body_markdown, priority, client_nonce, target_agent, files): (
        i64,
        String,
        Option<TaskflowMessagePriority>,
        Option<String>,
        Option<i64>,
        Vec<FilePart>,
    ) = if is_multipart(content_type) {
        let form = parse_multipart(content_type, raw_body)
            .await
            .map_err(|_| StatusCode::BAD_REQUEST)?;

        let mut channel_field: Option<String> = None;
        let mut body_field: Option<String> = None;
        let mut priority_field: Option<String> = None;
        let mut nonce_field: Option<String> = None;
        let mut target_field: Option<String> = None;
        for (name, value) in form.fields {
            match name.as_str() {
                "channel" => channel_field = Some(value),
                "body_markdown" => body_field = Some(value),
                "priority" => priority_field = Some(value),
                "client_nonce" => nonce_field = Some(value),
                "target_agent" => target_field = Some(value),
                _ => {}
            }
        }

        let channel_id: i64 = channel_field
            .as_deref()
            .and_then(|s| s.trim().parse().ok())
            .ok_or(StatusCode::BAD_REQUEST)?;

        // An unrecognised priority string is dropped, not rejected — the create
        // below defaults it to `Normal`, same as an absent JSON `priority`.
        let priority = priority_field
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_value::<TaskflowMessagePriority>(json!(s)).ok());

        // #29: an optional directed-message target (an agent id). Unparseable or
        // absent → None (a broadcast).
        let target_agent = target_field.as_deref().and_then(|s| s.trim().parse().ok());

        // A "file part" is one that carried a filename; bodyless text parts are
        // fields, not attachments.
        let files: Vec<FilePart> = form
            .files
            .into_iter()
            .filter(|f| f.filename.as_deref().is_some_and(|n| !n.is_empty()))
            .collect();

        (
            channel_id,
            body_field.unwrap_or_default(),
            priority,
            nonce_field,
            target_agent,
            files,
        )
    } else {
        // JSON path: preserve the original behaviour exactly. A malformed body
        // is a 400 (the old `Json` extractor rejected with a 4xx too).
        let input: SendMessageInput =
            serde_json::from_slice(&raw_body).map_err(|_| StatusCode::BAD_REQUEST)?;
        (
            input.channel,
            input.body_markdown,
            input.priority,
            input.client_nonce,
            input.target_agent,
            Vec::new(),
        )
    };

    let body = body_markdown.trim();
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Body may be empty ONLY when at least one file is attached — a file-only
    // message is valid, an empty text-only message is not.
    if body.is_empty() && files.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Reject an oversized file BEFORE anything is written. The flow saves the
    // message first and then the files, so validating size up front is what lets
    // a too-large file "ignore the whole message" instead of persisting a
    // message whose attachment then fails to store.
    if let Some(oversized) = files.iter().find(|f| f.bytes.len() > MAX_ATTACHMENT_BYTES) {
        // Return the reason in the body so the client can show the user WHY the
        // send failed, rather than a bare status the UI can only render as
        // "something went wrong".
        let max_mb = MAX_ATTACHMENT_BYTES / (1024 * 1024);
        let name = oversized.filename.as_deref().unwrap_or("This file");
        let detail = format!("\"{name}\" is too large. The maximum attachment size is {max_mb} MB.");
        return Ok((StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "detail": detail }))).into_response());
    }

    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel_id))
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
    // A retry after a dropped response must not double-post — and must not
    // re-store the files either, so we hand back the existing message with the
    // attachments it already owns.
    if let Some(nonce) = client_nonce.as_deref().filter(|n| !n.is_empty()) {
        let existing = TaskflowAgentMessage::objects()
            .filter(
                taskflow_agent_message::CHANNEL.eq(channel.id)
                    & taskflow_agent_message::CLIENT_NONCE.eq(nonce),
            )
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(row) = existing {
            let attachments = TaskflowMessageAttachment::objects()
                .filter(taskflow_message_attachment::MESSAGE.eq(row.id))
                .fetch()
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            return message_response(&row, &attachments);
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
            target_agent: target_agent.map(ForeignKey::new),
            sender_label,
            body_markdown: body.to_string(),
            priority: priority.unwrap_or(TaskflowMessagePriority::Normal),
            client_nonce: client_nonce.clone(),
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Store each uploaded file through the ambient backend and record a
    // `TaskflowMessageAttachment` row. The `project` is denormalized from the
    // channel (never accepted from the client), matching the message itself.
    let mut attachments = Vec::with_capacity(files.len());
    if !files.is_empty() {
        let Some(storage) = storage_opt() else {
            return Ok(storage_unavailable_response());
        };
        for part in files {
            let filename = part
                .filename
                .as_deref()
                .filter(|n| !n.is_empty())
                .unwrap_or("upload")
                .to_string();
            let content_type = part
                .content_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let stored = storage
                .store(&filename, &content_type, &part.bytes)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let attachment = TaskflowMessageAttachment::objects()
                .create(TaskflowMessageAttachment {
                    id: 0,
                    message: ForeignKey::new(message.id),
                    project: channel.project.clone(),
                    // Denormalized from the message so the REST scope can filter
                    // on it — attachments follow their channel's visibility.
                    channel: Some(message.channel.clone()),
                    file: FileField::from(stored.key),
                    name: filename,
                    content_type,
                    size_bytes: stored.size as i64,
                    created_at: None,
                })
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            attachments.push(attachment);
        }
    }

    message_response(&message, &attachments)
}

/// The role stamped on a roster row minted through this endpoint. The channel
/// roster carries its own `role` string independent of the project role — a
/// person's standing in a channel is "member" regardless of whether they are a
/// developer or a viewer of the project. Kept deliberately constant so the value
/// is predictable and this endpoint never leaks a project's role hierarchy into
/// the channel roster.
const CHANNEL_ROLE_MEMBER: &str = "member";

/// One roster entry a client may ask for at creation. Exactly one of `user` or
/// `agent` is meaningful, selected by `kind`; the other is ignored.
#[derive(Debug, Deserialize)]
pub struct CreateChannelMemberInput {
    pub kind: String,
    #[serde(default)]
    pub user: Option<i64>,
    #[serde(default)]
    pub agent: Option<i64>,
}

/// The channel to create. Identity is NOT a body field: the creator comes from
/// the token, and `project` is validated against the caller's own memberships
/// rather than trusted.
#[derive(Debug, Deserialize)]
pub struct CreateChannelInput {
    pub project: i64,
    pub kind: TaskflowChannelKind,
    pub title: String,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub task: Option<i64>,
    #[serde(default)]
    pub members: Vec<CreateChannelMemberInput>,
}

/// `POST /api/taskflow/channels` — create a channel and its roster atomically.
///
/// Channel creation moved here for the same reason project creation did: a
/// channel row is meaningless without its membership, and creating the two in
/// separate client calls produced both an orphan-channel bug and a privilege
/// hole. `visible_channel_ids` decides DM access by READING the roster, so a
/// client-writable roster let anyone opt into any DM.
///
/// The caller is always added. That is not a convenience — it is what makes a
/// DM bootstrappable at all: `add_channel_member` requires an existing roster
/// row for Direct channels, which a brand-new DM has nobody to supply.
pub async fn create_channel(
    RequireAuth(caller_id): RequireAuth<i64>,
    Json(input): Json<CreateChannelInput>,
) -> Result<Response, StatusCode> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Caller gate: an active member of THIS project. Read from the table, never
    // trusted from the request.
    let caller_membership = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(input.project)
                & taskflow_project_member::USER.eq(caller_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    // Resolve every requested member BEFORE opening the transaction, so a bad
    // target is a clean 400 rather than a rollback. Each resolved entry carries
    // the display name from the server's own records — never the client's.
    struct Resolved {
        kind: TaskflowChannelMemberKind,
        user: Option<i64>,
        agent: Option<i64>,
        display_name: String,
        role: String,
    }

    let mut resolved: Vec<Resolved> = vec![Resolved {
        kind: TaskflowChannelMemberKind::User,
        user: Some(caller_id),
        agent: None,
        display_name: caller_membership.display_name.clone(),
        role: CHANNEL_ROLE_MEMBER.to_string(),
    }];

    // Dedup by (kind, id) so a repeated target degrades to a silent skip rather
    // than a unique-index violation deep in the transaction. The caller is
    // seeded here for the same reason the loop below skips `user_id ==
    // caller_id` — both are "already rostered" checks, just against different
    // sources.
    let mut seen: HashSet<(bool, i64)> = HashSet::new();
    seen.insert((false, caller_id));

    for wanted in &input.members {
        match wanted.kind.as_str() {
            "user" => {
                let Some(user_id) = wanted.user else {
                    return Err(StatusCode::BAD_REQUEST);
                };
                if user_id == caller_id {
                    continue; // already rostered as the creator
                }
                if !seen.insert((false, user_id)) {
                    continue; // already resolved this user from an earlier entry
                }
                let Some(member) = TaskflowProjectMember::objects()
                    .filter(
                        taskflow_project_member::PROJECT.eq(input.project)
                            & taskflow_project_member::USER.eq(user_id)
                            & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
                    )
                    .first()
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                else {
                    return Ok(not_a_project_member_response());
                };
                resolved.push(Resolved {
                    kind: TaskflowChannelMemberKind::User,
                    user: Some(user_id),
                    agent: None,
                    display_name: member.display_name.clone(),
                    role: CHANNEL_ROLE_MEMBER.to_string(),
                });
            }
            "agent" => {
                let Some(agent_id) = wanted.agent else {
                    return Err(StatusCode::BAD_REQUEST);
                };
                if !seen.insert((true, agent_id)) {
                    continue; // already resolved this agent from an earlier entry
                }
                let Some(agent) = TaskflowAgent::objects()
                    .filter(taskflow_agent::ID.eq(agent_id))
                    .first()
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                else {
                    return Err(StatusCode::BAD_REQUEST);
                };
                // An agent is pinned to one project by its credential; rostering
                // a foreign agent would hand it another project's traffic.
                if agent.project.id() != input.project {
                    return Err(StatusCode::BAD_REQUEST);
                }
                resolved.push(Resolved {
                    kind: TaskflowChannelMemberKind::Agent,
                    user: None,
                    agent: Some(agent_id),
                    display_name: agent.display_name.clone(),
                    role: "agent".to_string(),
                });
            }
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    }

    // Resolve the task link against THIS project before the transaction opens,
    // same rule `scoped_task_link` enforces for activity ingest: a foreign
    // project's task id is dropped rather than trusted verbatim.
    let task = scoped_task_link(input.task, input.project).await?;

    let project_id = input.project;
    let kind = input.kind;
    let topic = input.topic.clone();

    // Atomic: the channel and every roster row land together or not at all. A
    // channel without its roster is invisible to its own creator and impossible
    // to join, which is exactly the orphan this replaces.
    let created = umbral::transaction(move |tx| {
        Box::pin(async move {
            let channel = TaskflowAgentChannel::objects()
                .on_tx(tx)
                .create(TaskflowAgentChannel {
                    id: 0,
                    project: ForeignKey::new(project_id),
                    title,
                    topic,
                    kind,
                    task: task.map(ForeignKey::new),
                    created_by_user: Some(ForeignKey::new(caller_id)),
                    created_by_agent: None,
                    archived: false,
                    created_at: None,
                })
                .await?;

            let mut rows = Vec::with_capacity(resolved.len());
            for entry in resolved {
                rows.push(
                    TaskflowAgentChannelMember::objects()
                        .on_tx(tx)
                        .create(TaskflowAgentChannelMember {
                            id: 0,
                            project: ForeignKey::new(project_id),
                            channel: ForeignKey::new(channel.id),
                            member_kind: entry.kind,
                            user: entry.user.map(ForeignKey::new),
                            agent: entry.agent.map(ForeignKey::new),
                            display_name: entry.display_name,
                            role: entry.role,
                            joined_at: None,
                        })
                        .await?,
                );
            }
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>((channel, rows))
        })
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let (channel, members) = created;
    let mut value =
        serde_json::to_value(&channel).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("members".to_string(), json!(members));
    }
    Ok((StatusCode::CREATED, Json(value)).into_response())
}

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

// ---------------------------------------------------------------------------
// Agent identity: mint a stable, credentialed agent (human-authed) and let an
// agent authenticate as itself to send messages (agent-authed).
// ---------------------------------------------------------------------------

/// A stable, URL-safe slug: ASCII alphanumerics pass through lowercased, every
/// other character becomes `-`. Deterministic so the same display name always
/// produces the same `identifier`, which is what lets re-linking a profile reuse
/// the same `TaskflowAgent` (and its history) rather than mint a new one.
fn slug(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

/// The body of `POST /api/taskflow/agents/link`. `project`, `display_name`, and
/// `profile` are required; the rest are optional metadata copied onto the agent.
/// The caller cannot assert any credential/agent identity field — the key, the
/// hash, the `identifier`, and the `linked_by` are all derived server-side.
#[derive(Debug, Deserialize)]
pub struct LinkAgentInput {
    pub project: i64,
    pub display_name: String,
    pub profile: String,
    #[serde(default)]
    pub project_root: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

/// `POST /api/taskflow/agents/link` (human-authed) — mint an agent identity.
///
/// Creates (or reuses, by a stable computed `identifier`) a `TaskflowAgent` and
/// ALWAYS mints a fresh `TaskflowAgentCredential` for it, returning the raw
/// `tfk_…` key EXACTLY ONCE. The credential stores only the non-secret
/// `key_prefix` and `sha256(raw_key)` — the raw key is never persisted and
/// cannot be recovered, so the response is the single opportunity to capture it.
///
/// AUTHORIZATION: `RequireAuth<i64>` authenticates the human caller, who must be
/// an ACTIVE member of `project` (else 403) — you can only link an agent into a
/// project you belong to. The agent + credential land together in one
/// transaction so a failure never leaves an agent without a key or vice versa.
pub async fn link_agent(
    RequireAuth(user_id): RequireAuth<i64>,
    Json(input): Json<LinkAgentInput>,
) -> Result<Response, StatusCode> {
    let display_name = input.display_name.trim().to_string();
    let profile = input.profile.trim().to_string();
    if display_name.is_empty() || profile.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let project_id = input.project;

    // Caller gate: an ACTIVE project member of THIS project, read from the table,
    // never trusted from the request. Absent → 403. Mirrors `send_message`.
    let caller_member = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    // A human-readable label for who linked the agent. Prefer the caller's
    // project-member display name; fall back to their account username.
    let linked_user_label = if caller_member.display_name.trim().is_empty() {
        AuthUser::objects()
            .filter(auth_user::ID.eq(user_id))
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map(|u| u.username)
            .unwrap_or_default()
    } else {
        caller_member.display_name.clone()
    };

    // Stable identity: the same (project, display_name, profile) always maps to
    // the same `identifier`, so re-linking reuses the agent id + history.
    let identifier = format!("agent:{project_id}:{}:{}", slug(&display_name), profile);

    // Key material. The prefix is a non-secret, UNIQUE lookup handle; the secret
    // is a full uuid-v4 (CSPRNG-backed). We store the prefix + sha256(raw) only.
    let prefix12: String = Uuid::new_v4().simple().to_string().chars().take(12).collect();
    let secret = Uuid::new_v4().simple().to_string();
    let key_prefix = format!("tfk_{prefix12}");
    let raw_key = format!("tfk_{prefix12}_{secret}");
    let key_hash = hash_key(&raw_key);
    let credential_name = format!("{profile} key");

    // Reuse an existing agent with this identifier, else create it. The lookup is
    // outside the transaction (a read); the create-if-missing + credential mint
    // are inside it so the two rows land together.
    let existing_agent = TaskflowAgent::objects()
        .filter(taskflow_agent::IDENTIFIER.eq(identifier.as_str()))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let tx_display_name = display_name.clone();
    let tx_identifier = identifier.clone();
    let project_root = input.project_root.clone();
    let runtime = input.runtime.clone();
    let version = input.version.clone();

    let agent_id = umbral::transaction(move |tx| {
        Box::pin(async move {
            let agent = match existing_agent {
                Some(agent) => agent,
                None => {
                    TaskflowAgent::objects()
                        .on_tx(tx)
                        .create(TaskflowAgent {
                            id: 0,
                            project: ForeignKey::new(project_id),
                            display_name: tx_display_name.clone(),
                            identifier: tx_identifier.clone(),
                            fingerprint: None,
                            project_root: project_root.clone(),
                            taskflow_file_path: None,
                            runtime: runtime.clone(),
                            version: version.clone(),
                            status: TaskflowAgentStatus::Offline,
                            linked_by: Some(ForeignKey::new(user_id)),
                            linked_user_label: Some(linked_user_label.clone()),
                            last_seen_at: None,
                            created_at: None,
                        })
                        .await?
                }
            };

            TaskflowAgentCredential::objects()
                .on_tx(tx)
                .create(TaskflowAgentCredential {
                    id: 0,
                    project: ForeignKey::new(project_id),
                    agent: Some(ForeignKey::new(agent.id)),
                    issued_by: Some(ForeignKey::new(user_id)),
                    name: credential_name.clone(),
                    key_prefix: key_prefix.clone(),
                    key_hash: key_hash.clone(),
                    status: TaskflowCredentialStatus::Active,
                    expires_at: None,
                    revoked_at: None,
                    created_at: None,
                })
                .await?;

            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(agent.id)
        })
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Guarantee the agent has somewhere to talk (and somewhere reviews can be
    // reported back to) the moment it is linked. Best-effort: a failure here
    // must not lose the freshly-minted key, which is unrecoverable after this
    // response — the agent can still be rostered later.
    let _ = ensure_project_room(project_id, agent_id, &display_name, Some(user_id)).await;

    // The raw key appears here and NOWHERE else. `taskflow_profile` is the block
    // the caller pastes into `.taskflow.json` under `profiles.<profile>`.
    Ok((
        StatusCode::OK,
        Json(json!({
            "agent_id": agent_id,
            "identifier": identifier,
            "display_name": display_name,
            "project": project_id,
            "profile": profile,
            "key": raw_key,
            "taskflow_profile": {
                "agent_id": agent_id,
                "key": raw_key,
                "display_name": display_name,
            },
        })),
    )
        .into_response())
}

/// The body of `POST /api/taskflow/agents/agent/messages`. Identical to the
/// human `SendMessageInput` — the difference is purely who is authenticated, not
/// what they may say. The sender identity is never a body field.
#[derive(Debug, Deserialize)]
pub struct AgentSendMessageInput {
    pub channel: i64,
    pub body_markdown: String,
    #[serde(default)]
    pub priority: Option<TaskflowMessagePriority>,
    #[serde(default)]
    pub client_nonce: Option<String>,
}

/// `POST /api/taskflow/agents/agent/messages` (agent-authed) — the trusted write
/// path for an agent to speak AS ITSELF.
///
/// Mirrors `send_message` exactly except for the sender: `RequireAgent` resolves
/// the credential to a stable `TaskflowAgent`, and every stored message stamps
/// `sender_kind = agent`, `sender_agent = <id>`, `sender_user = None`,
/// `sender_label = <display_name>`. Accepts JSON or multipart; multipart carries
/// file attachments, stored and returned exactly as on the human path.
///
/// MEMBERSHIP GATE (agent counterpart of the human one):
///   1. An explicit channel-roster row for this agent authorizes the post.
///   2. Otherwise, for SHARED project rooms (Project / Task / Incident) the
///      channel's project must equal the agent's project — agents are
///      project-scoped by their credential, so project scope grants posting to
///      that project's shared rooms. DMs (`Direct`) stay private to their
///      explicit roster.
pub async fn send_message_as_agent(
    RequireAgent(agent): RequireAgent,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response, StatusCode> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    // Normalise both transports to the same logical input, exactly as the human
    // `send_message` does. JSON posts carry no file parts.
    let (channel_id, body_markdown, priority, client_nonce, files): (
        i64,
        String,
        Option<TaskflowMessagePriority>,
        Option<String>,
        Vec<FilePart>,
    ) = if is_multipart(content_type) {
        let form = parse_multipart(content_type, raw_body)
            .await
            .map_err(|_| StatusCode::BAD_REQUEST)?;

        let mut channel_field: Option<String> = None;
        let mut body_field: Option<String> = None;
        let mut priority_field: Option<String> = None;
        let mut nonce_field: Option<String> = None;
        for (name, value) in form.fields {
            match name.as_str() {
                "channel" => channel_field = Some(value),
                "body_markdown" => body_field = Some(value),
                "priority" => priority_field = Some(value),
                "client_nonce" => nonce_field = Some(value),
                _ => {}
            }
        }

        let channel_id: i64 = channel_field
            .as_deref()
            .and_then(|s| s.trim().parse().ok())
            .ok_or(StatusCode::BAD_REQUEST)?;

        // An unrecognised priority is dropped, not rejected — the create below
        // defaults it to `Normal`, same as an absent JSON `priority`.
        let priority = priority_field
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_value::<TaskflowMessagePriority>(json!(s)).ok());

        // A "file part" is one that carried a filename; bodyless text parts are
        // fields, not attachments.
        let files: Vec<FilePart> = form
            .files
            .into_iter()
            .filter(|f| f.filename.as_deref().is_some_and(|n| !n.is_empty()))
            .collect();

        (
            channel_id,
            body_field.unwrap_or_default(),
            priority,
            nonce_field,
            files,
        )
    } else {
        let input: AgentSendMessageInput =
            serde_json::from_slice(&raw_body).map_err(|_| StatusCode::BAD_REQUEST)?;
        (
            input.channel,
            input.body_markdown,
            input.priority,
            input.client_nonce,
            Vec::new(),
        )
    };

    let body = body_markdown.trim();
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Body may be empty ONLY when at least one file is attached — a file-only
    // message is valid, an empty text-only message is not.
    if body.is_empty() && files.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Reject an oversized file BEFORE anything is written, so a too-large file
    // fails the whole message instead of persisting a message whose attachment
    // then fails to store.
    if let Some(oversized) = files.iter().find(|f| f.bytes.len() > MAX_ATTACHMENT_BYTES) {
        let max_mb = MAX_ATTACHMENT_BYTES / (1024 * 1024);
        let name = oversized.filename.as_deref().unwrap_or("This file");
        let detail = format!("\"{name}\" is too large. The maximum attachment size is {max_mb} MB.");
        return Ok((StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "detail": detail }))).into_response());
    }

    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Membership is the authorization boundary. Checked BEFORE the idempotency
    // lookup for the same reason as the human path: a guessed nonce must not let
    // a non-member read back a stored message.
    let is_roster_member = TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel.id)
                & taskflow_agent_channel_member::AGENT.eq(agent.agent_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some();

    if !is_roster_member {
        // No roster row. DMs are private to their explicit roster.
        if channel.kind == TaskflowChannelKind::Direct {
            return Err(StatusCode::FORBIDDEN);
        }
        // Shared project room: the agent may post only in its own project's rooms.
        if channel.project.id() != agent.project_id {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    // Idempotency: the same nonce in the same channel is the same message.
    if let Some(nonce) = client_nonce.as_deref().filter(|n| !n.is_empty()) {
        let existing = TaskflowAgentMessage::objects()
            .filter(
                taskflow_agent_message::CHANNEL.eq(channel.id)
                    & taskflow_agent_message::CLIENT_NONCE.eq(nonce),
            )
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(row) = existing {
            let attachments = TaskflowMessageAttachment::objects()
                .filter(taskflow_message_attachment::MESSAGE.eq(row.id))
                .fetch()
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            return message_response(&row, &attachments);
        }
    }

    // The sender trio is derived from the authenticated agent, never accepted:
    // `sender_kind = agent`, the agent id, and its display name as the label.
    let message = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: channel.project.clone(),
            channel: ForeignKey::new(channel.id),
            task: channel.task.clone(),
            sender_kind: TaskflowChannelMemberKind::Agent,
            sender_user: None,
            sender_agent: Some(ForeignKey::new(agent.agent_id)),
            target_agent: None,
            sender_label: agent.display_name.clone(),
            body_markdown: body.to_string(),
            priority: priority.unwrap_or(TaskflowMessagePriority::Normal),
            client_nonce: client_nonce.clone(),
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Store each uploaded file through the ambient backend and record a
    // `TaskflowMessageAttachment` row. The `project` is denormalized from the
    // channel (never accepted from the client), matching the message itself.
    let mut attachments = Vec::with_capacity(files.len());
    if !files.is_empty() {
        let Some(storage) = storage_opt() else {
            return Ok(storage_unavailable_response());
        };
        for part in files {
            let filename = part
                .filename
                .as_deref()
                .filter(|n| !n.is_empty())
                .unwrap_or("upload")
                .to_string();
            let content_type = part
                .content_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let stored = storage
                .store(&filename, &content_type, &part.bytes)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let attachment = TaskflowMessageAttachment::objects()
                .create(TaskflowMessageAttachment {
                    id: 0,
                    message: ForeignKey::new(message.id),
                    project: channel.project.clone(),
                    // Denormalized from the message so the REST scope can filter
                    // on it — attachments follow their channel's visibility.
                    channel: Some(message.channel.clone()),
                    file: FileField::from(stored.key),
                    name: filename,
                    content_type,
                    size_bytes: stored.size as i64,
                    created_at: None,
                })
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            attachments.push(attachment);
        }
    }

    message_response(&message, &attachments)
}

// ---------------------------------------------------------------------------
// Read receipts / unread cursors: a member (user OR agent) records how far it
// has read in a channel. Two routes mirror the send split — human `RequireAuth`
// and agent `RequireAgent` — but both derive the member identity server-side and
// upsert the caller's own cursor FORWARD only.
// ---------------------------------------------------------------------------

/// The one field either read endpoint accepts: the furthest message the caller
/// has now read. The channel comes from the PATH and the member identity from
/// the auth gate — neither is a body field, so there is nothing to forge.
#[derive(Debug, Deserialize)]
pub struct MarkReadInput {
    pub last_read_message: i64,
}

/// Load the channel a read targets, or 404 if it does not exist.
async fn load_channel(channel_id: i64) -> Result<TaskflowAgentChannel, StatusCode> {
    TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)
}

/// Validate that `message_id` exists AND lives in `channel`. A cursor may only
/// point at a message the member could actually have read here — a missing
/// message or one from a foreign channel is a 400, not a silent accept. Called
/// AFTER the membership gate so a non-member never learns anything about a
/// channel's messages.
async fn validate_message_in_channel(
    channel: &TaskflowAgentChannel,
    message_id: i64,
) -> Result<(), StatusCode> {
    let message = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(message_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::BAD_REQUEST)?;
    if message.channel.id() != channel.id {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}

/// Upsert the caller's cursor, advancing FORWARD only. `existing` is the current
/// cursor for this (channel, member) if any; `new_row` is the fully-formed row to
/// insert when none exists (and the source of the `last_read_at` to stamp on an
/// advance). A read at an id `<=` the stored one leaves the cursor untouched — a
/// cursor never moves backwards — and returns the unchanged row (200).
async fn upsert_cursor_forward(
    existing: Option<TaskflowChannelReadCursor>,
    new_row: TaskflowChannelReadCursor,
    new_message_id: i64,
) -> Result<Response, StatusCode> {
    let cursor = match existing {
        Some(mut row) => {
            let current = row.last_read_message.as_ref().map(|fk| fk.id());
            // Advance only when the new message is strictly ahead of the stored
            // one (or the cursor had none yet). Never move backwards.
            if current.map_or(true, |id| new_message_id > id) {
                row.last_read_message = Some(ForeignKey::new(new_message_id));
                row.last_read_at = new_row.last_read_at;
                TaskflowChannelReadCursor::objects()
                    .save(row)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            } else {
                row
            }
        }
        None => TaskflowChannelReadCursor::objects()
            .create(new_row)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    };
    Ok((StatusCode::OK, Json(cursor)).into_response())
}

/// `POST /api/taskflow/channels/{channel}/read` (human-authed) — record how far
/// the authenticated user has read in a channel.
///
/// AUTHORIZATION mirrors `send_message`'s membership gate exactly: an explicit
/// channel-roster row authorizes it, otherwise (for shared Project/Task/Incident
/// rooms only) an active membership of the channel's project does. A DM the
/// caller isn't on the roster of, or a project they aren't an active member of,
/// is a 403 — you cannot mark read a channel you cannot read.
pub async fn mark_channel_read(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(channel_id): Path<i64>,
    Json(input): Json<MarkReadInput>,
) -> Result<Response, StatusCode> {
    let channel = load_channel(channel_id).await?;

    // (a) Membership is the authorization boundary (same gate as `send_message`).
    // Checked BEFORE message validation so a non-member never learns whether a
    // given message id belongs to this channel.
    let is_roster_member = TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel.id)
                & taskflow_agent_channel_member::USER.eq(user_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some();

    if !is_roster_member {
        // No roster row. DMs stay private to their explicit roster.
        if channel.kind == TaskflowChannelKind::Direct {
            return Err(StatusCode::FORBIDDEN);
        }
        // Shared project room: an active project member may read it.
        TaskflowProjectMember::objects()
            .filter(
                taskflow_project_member::PROJECT.eq(channel.project.id())
                    & taskflow_project_member::USER.eq(user_id)
                    & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
            )
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::FORBIDDEN)?;
    }

    // (b) The message must belong to this channel.
    validate_message_in_channel(&channel, input.last_read_message).await?;

    // One cursor per (channel, user). The `member_agent` half is null.
    let existing = TaskflowChannelReadCursor::objects()
        .filter(
            taskflow_channel_read_cursor::CHANNEL.eq(channel.id)
                & taskflow_channel_read_cursor::MEMBER_USER.eq(user_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let new_row = TaskflowChannelReadCursor {
        id: 0,
        project: channel.project.clone(),
        channel: ForeignKey::new(channel.id),
        member_kind: TaskflowChannelMemberKind::User,
        member_user: Some(ForeignKey::new(user_id)),
        member_agent: None,
        last_read_message: Some(ForeignKey::new(input.last_read_message)),
        last_read_at: chrono::Utc::now(),
        created_at: None,
    };

    upsert_cursor_forward(existing, new_row, input.last_read_message).await
}

/// `POST /api/taskflow/channels/{channel}/agent/read` (agent-authed) — the agent
/// counterpart of [`mark_channel_read`]. `RequireAgent` resolves the credential
/// to a stable agent; the cursor stamps `member_kind = agent`, `member_agent =
/// <id>`, `member_user = None`.
///
/// AUTHORIZATION mirrors `send_message_as_agent`: an explicit channel-roster row
/// authorizes it, otherwise (for shared rooms only) the channel's project must
/// equal the agent's project. A DM off-roster, or a foreign-project room, is 403.
pub async fn mark_channel_read_as_agent(
    RequireAgent(agent): RequireAgent,
    Path(channel_id): Path<i64>,
    Json(input): Json<MarkReadInput>,
) -> Result<Response, StatusCode> {
    let channel = load_channel(channel_id).await?;

    // (a) Membership gate (same as `send_message_as_agent`), before message
    // validation so a foreign-project agent never probes this channel's messages.
    let is_roster_member = TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel.id)
                & taskflow_agent_channel_member::AGENT.eq(agent.agent_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some();

    if !is_roster_member {
        // No roster row. DMs stay private to their explicit roster.
        if channel.kind == TaskflowChannelKind::Direct {
            return Err(StatusCode::FORBIDDEN);
        }
        // Shared project room: the agent may read only its own project's rooms.
        if channel.project.id() != agent.project_id {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    // (b) The message must belong to this channel.
    validate_message_in_channel(&channel, input.last_read_message).await?;

    // One cursor per (channel, agent). The `member_user` half is null.
    let existing = TaskflowChannelReadCursor::objects()
        .filter(
            taskflow_channel_read_cursor::CHANNEL.eq(channel.id)
                & taskflow_channel_read_cursor::MEMBER_AGENT.eq(agent.agent_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let new_row = TaskflowChannelReadCursor {
        id: 0,
        project: channel.project.clone(),
        channel: ForeignKey::new(channel.id),
        member_kind: TaskflowChannelMemberKind::Agent,
        member_user: None,
        member_agent: Some(ForeignKey::new(agent.agent_id)),
        last_read_message: Some(ForeignKey::new(input.last_read_message)),
        last_read_at: chrono::Utc::now(),
        created_at: None,
    };

    upsert_cursor_forward(existing, new_row, input.last_read_message).await
}

// ---------------------------------------------------------------------------
// Stage 3 — live sessions + streamed terminal frames. An agent runtime
// registers a session, heartbeats its liveness, streams terminal output, and
// closes it. Every op is agent-authed via `RequireAgent`; every op that names a
// session verifies the session belongs to the authed agent (403 otherwise).
//
// "Online" is derived from recency, not a background sweeper: these endpoints
// keep `status` / `last_seen_at` accurate and the FE computes liveness as
// `now - last_seen_at < ~2x heartbeat`. Suggested cadence: 30s heartbeat, 90s
// stale threshold.
// ---------------------------------------------------------------------------

/// The model caps a terminal frame's `content` at 20000 chars. Reject at the
/// edge (400) rather than let the DB truncate or error.
const MAX_FRAME_CHARS: usize = 20_000;

/// The stored value of `TaskflowAgentSessionStatus::Connected` — the status
/// column is a string at the DB layer, so we compare against this literal (same
/// convention as the membership/credential gates).
const CONNECTED_SESSION: &str = "connected";

/// How long a session may go without a heartbeat before it stops counting as
/// live. CONTRACT with the frontend's `AGENT_HEARTBEAT_WINDOW_MS` (90_000) in
/// `v2_fe/src/App.tsx` — the two must agree, or the dashboard and the agent's
/// own `whoami` will disagree about whether it is online.
///
/// There is no sweeper by design, so `status == connected` alone is NOT proof of
/// life: an agent whose process dies never calls `/close`, leaving a row that
/// claims to be connected forever. Liveness is therefore always
/// `connected AND heartbeated recently` — see [`session_is_live`].
const AGENT_HEARTBEAT_WINDOW_SECS: i64 = 90;

/// Whether a session counts as live right now: still marked connected AND
/// heartbeated inside the window. Falls back to `connected_at` for a session
/// that registered but has not heartbeated yet, so a brand-new session isn't
/// judged dead before its first beat.
fn session_is_live(session: &TaskflowAgentSession, now: chrono::DateTime<chrono::Utc>) -> bool {
    if session.status != TaskflowAgentSessionStatus::Connected {
        return false;
    }
    let last_beat = session.last_seen_at.unwrap_or(session.connected_at);
    (now - last_beat).num_seconds() <= AGENT_HEARTBEAT_WINDOW_SECS
}

/// Count an agent's currently-live sessions. Used instead of a bare
/// `status = connected` count so abandoned sessions can't pin an agent online.
async fn live_session_count(
    agent_id: i64,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<usize, StatusCode> {
    let sessions = TaskflowAgentSession::objects()
        .filter(
            taskflow_agent_session::AGENT.eq(agent_id)
                & taskflow_agent_session::STATUS.eq(CONNECTED_SESSION),
        )
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(sessions.iter().filter(|s| session_is_live(s, now)).count())
}

/// The agent's effective status, correcting a stored value that outlived its
/// sessions. `stored` is the agent's last declared intent (busy/idle/connected);
/// with no live session backing it, that intent is stale and the agent is really
/// offline.
///
/// `Blocked` and `Revoked` are administrative states, not liveness, so they are
/// returned untouched — a revoked agent is revoked whether or not it is running.
fn effective_agent_status(
    stored: TaskflowAgentStatus,
    has_live_session: bool,
) -> TaskflowAgentStatus {
    match stored {
        TaskflowAgentStatus::Blocked | TaskflowAgentStatus::Revoked => stored,
        _ if has_live_session => stored,
        _ => TaskflowAgentStatus::Offline,
    }
}

/// Set an agent row's liveness: `status` (a hint from the caller, or
/// `connected`) and `last_seen_at = now`. The agent is guaranteed to exist —
/// `RequireAgent` resolved it — so a missing row here is a 500, not a 404.
async fn touch_agent(
    agent_id: i64,
    status: TaskflowAgentStatus,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), StatusCode> {
    let mut agent = TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(agent_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    agent.status = status;
    agent.last_seen_at = Some(now);
    TaskflowAgent::objects()
        .save(agent)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

/// Load a session by id and prove it belongs to `agent_id`. 404 if the session
/// does not exist; 403 if it belongs to a DIFFERENT agent — an agent may only
/// touch its own sessions. The ownership check is the authorization boundary for
/// heartbeat / frames / close.
async fn load_owned_session(
    session_id: i64,
    agent_id: i64,
) -> Result<TaskflowAgentSession, StatusCode> {
    let session = TaskflowAgentSession::objects()
        .filter(taskflow_agent_session::ID.eq(session_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if session.agent.id() != agent_id {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(session)
}

/// The body of `POST /api/taskflow/agents/sessions`. `session_identifier` is the
/// only required field; the rest is optional runtime metadata. The caller cannot
/// assert `project`, `agent`, `status`, or any timestamp — those are all derived
/// from the authenticated agent and the server clock.
#[derive(Debug, Deserialize)]
pub struct RegisterSessionInput {
    pub session_identifier: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub pid: Option<i64>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
}

/// `POST /api/taskflow/agents/sessions` (agent-authed) — register or reconnect a
/// live session, keyed by the globally-unique `session_identifier`.
///
/// Upsert semantics:
///   * A row for this identifier that belongs to THIS agent is reconnected:
///     `status=connected`, `disconnected_at` cleared, `last_seen_at=now`, and any
///     supplied metadata (host/pid/cwd/transport) updated.
///   * A row that belongs to a DIFFERENT agent → 409: the identifier is globally
///     unique and an agent may not claim another's session.
///   * No row → create one in the agent's own project, `status=connected`.
///
/// Either way the AGENT row is marked `status=connected`, `last_seen_at=now`, so
/// registering a session is what brings an agent online.
pub async fn register_session(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<RegisterSessionInput>,
) -> Result<Response, StatusCode> {
    let session_identifier = input.session_identifier.trim().to_string();
    if session_identifier.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let now = chrono::Utc::now();

    let existing = TaskflowAgentSession::objects()
        .filter(taskflow_agent_session::SESSION_IDENTIFIER.eq(session_identifier.as_str()))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let session = match existing {
        Some(mut row) => {
            // The identifier is globally unique: a row owned by another agent is
            // not ours to reconnect. 409 CONFLICT — the caller cannot claim it.
            if row.agent.id() != agent.agent_id {
                return Err(StatusCode::CONFLICT);
            }
            row.status = TaskflowAgentSessionStatus::Connected;
            row.disconnected_at = None;
            row.last_seen_at = Some(now);
            // Only overwrite metadata the caller actually supplied, so a bare
            // reconnect keeps whatever the session already recorded.
            if input.host.is_some() {
                row.host = input.host.clone();
            }
            if input.pid.is_some() {
                row.pid = input.pid;
            }
            if input.cwd.is_some() {
                row.cwd = input.cwd.clone();
            }
            if input.transport.is_some() {
                row.transport = input.transport.clone();
            }
            TaskflowAgentSession::objects()
                .save(row)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        }
        None => TaskflowAgentSession::objects()
            .create(TaskflowAgentSession {
                id: 0,
                // Scope is the agent's own project, never accepted from the body.
                project: ForeignKey::new(agent.project_id),
                agent: ForeignKey::new(agent.agent_id),
                connected_by: None,
                session_identifier: session_identifier.clone(),
                host: input.host.clone(),
                pid: input.pid,
                cwd: input.cwd.clone(),
                transport: input.transport.clone(),
                status: TaskflowAgentSessionStatus::Connected,
                connected_at: now,
                last_seen_at: Some(now),
                disconnected_at: None,
                created_at: None,
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    };

    // Registering a session brings the agent online.
    touch_agent(agent.agent_id, TaskflowAgentStatus::Connected, now).await?;

    Ok((StatusCode::OK, Json(session)).into_response())
}

/// The body of `POST .../sessions/{session}/heartbeat`. `status` is an OPTIONAL
/// activity hint — `idle` or `busy`; anything else (or absent) keeps the agent
/// `connected`. It is a hint about the agent's own activity, not a field that
/// can move the agent to an arbitrary status.
#[derive(Debug, Deserialize)]
pub struct HeartbeatInput {
    #[serde(default)]
    pub status: Option<String>,
}

/// `POST /api/taskflow/agents/sessions/{session}/heartbeat` (agent-authed) —
/// bump liveness. Sets `session.last_seen_at=now` and `agent.last_seen_at=now`,
/// and moves the agent to the hinted activity (`idle`/`busy`) or back to
/// `connected`. 404 if the session is unknown, 403 if it is not this agent's.
pub async fn session_heartbeat(
    RequireAgent(agent): RequireAgent,
    Path(session_id): Path<i64>,
    Json(input): Json<HeartbeatInput>,
) -> Result<Response, StatusCode> {
    let mut session = load_owned_session(session_id, agent.agent_id).await?;
    let now = chrono::Utc::now();
    session.last_seen_at = Some(now);
    let session = TaskflowAgentSession::objects()
        .save(session)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // The hint may only ever select idle/busy; anything else means "still here",
    // i.e. plain connected. An agent cannot drive itself offline/revoked here.
    let status = match input.status.as_deref() {
        Some("idle") => TaskflowAgentStatus::Idle,
        Some("busy") => TaskflowAgentStatus::Busy,
        _ => TaskflowAgentStatus::Connected,
    };
    touch_agent(agent.agent_id, status, now).await?;

    Ok((StatusCode::OK, Json(session)).into_response())
}

/// One terminal frame in a frames request. `content` is required; `stream`
/// defaults to `stdout`; `task` optionally ties the frame to a task. The
/// `sequence`, `project`, `agent`, and `session` are all assigned server-side.
#[derive(Debug, Deserialize)]
pub struct FrameInput {
    #[serde(default)]
    pub stream: Option<TaskflowTerminalStream>,
    pub content: String,
    #[serde(default)]
    pub task: Option<i64>,
}

/// The frames endpoint accepts EITHER a single frame (`{stream?, content, task?}`)
/// OR a batch (`{frames: [ ... ]}`). Untagged: a body carrying `frames` is a
/// batch, otherwise it is parsed as one frame.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum AppendFramesInput {
    Batch { frames: Vec<FrameInput> },
    Single(FrameInput),
}

/// `POST /api/taskflow/agents/sessions/{session}/frames` (agent-authed) — append
/// terminal output to a session. Each frame gets `sequence = (max existing
/// sequence for this session) + 1`, incrementing across a batch, so frames are
/// totally ordered per session. `content` over the 20000-char model cap is a
/// 400. Also bumps `session.last_seen_at`. 404/403 as for heartbeat.
///
/// Returns the created frame (single form) or `{frames: [...]}` (batch form).
/// The realtime layer projects each frame's fields inline (see
/// `backend/src/realtime.rs`), so a subscribed terminal panel renders straight
/// from the event without a REST round-trip per line.
pub async fn append_session_frames(
    RequireAgent(agent): RequireAgent,
    Path(session_id): Path<i64>,
    Json(input): Json<AppendFramesInput>,
) -> Result<Response, StatusCode> {
    let mut session = load_owned_session(session_id, agent.agent_id).await?;

    let (frames, is_batch) = match input {
        AppendFramesInput::Batch { frames } => (frames, true),
        AppendFramesInput::Single(frame) => (vec![frame], false),
    };
    if frames.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Validate every frame up front so a batch either lands whole or not at all
    // (no partial write before an oversized frame is discovered).
    if frames.iter().any(|f| f.content.chars().count() > MAX_FRAME_CHARS) {
        return Err(StatusCode::BAD_REQUEST);
    }

    // The next sequence is one past the highest existing one for THIS session.
    // Ordering by sequence desc and taking the first is robust to gaps (a deleted
    // frame never lets a sequence be reused).
    let last = TaskflowAgentTerminalFrame::objects()
        .filter(taskflow_agent_terminal_frame::SESSION.eq(session.id))
        .order_by(taskflow_agent_terminal_frame::SEQUENCE.desc())
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut next_sequence = last.map(|f| f.sequence).unwrap_or(0) + 1;

    let now = chrono::Utc::now();
    let mut created = Vec::with_capacity(frames.len());
    for frame in frames {
        let row = TaskflowAgentTerminalFrame::objects()
            .create(TaskflowAgentTerminalFrame {
                id: 0,
                // Denormalized from the session for realtime routing, exactly like
                // the chat tables; never accepted from the body.
                project: session.project.clone(),
                agent: ForeignKey::new(agent.agent_id),
                session: Some(ForeignKey::new(session.id)),
                task: frame.task.map(ForeignKey::new),
                stream: frame.stream.unwrap_or(TaskflowTerminalStream::Stdout),
                sequence: next_sequence,
                content: frame.content,
                created_at: None,
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        created.push(row);
        next_sequence += 1;
    }

    // Producing output is a sign of life: bump the session's recency. This is
    // why a streaming agent never needs to heartbeat separately.
    session.last_seen_at = Some(now);
    TaskflowAgentSession::objects()
        .save(session)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    prune_snapshots(session_id).await?;

    if is_batch {
        Ok((StatusCode::OK, Json(json!({ "frames": created }))).into_response())
    } else {
        // `created` holds exactly one row for the single form.
        let frame = created
            .into_iter()
            .next()
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok((StatusCode::OK, Json(frame)).into_response())
    }
}


/// How many `snapshot` frames to keep per session.
///
/// A snapshot REPLACES the view rather than appending to it, so older ones are
/// dead weight the moment a newer arrives. A couple are kept so a reader that is
/// mid-fetch never sees an empty terminal.
const SNAPSHOT_HISTORY: usize = 3;

/// Drop stale `snapshot` frames for a session, keeping the newest few.
///
/// Without this the table grows without bound for any long-running mirror — a
/// screen a second, ~10KB each — and the frontend fetches EVERY frame in the
/// project when it loads a workspace, so the cost lands on page load, not just
/// on disk. Only snapshots are pruned: stdout/stderr frames are a real
/// transcript and deleting them would lose history that nothing else holds.
async fn prune_snapshots(session_id: i64) -> Result<(), StatusCode> {
    let snapshots = TaskflowAgentTerminalFrame::objects()
        .filter(
            taskflow_agent_terminal_frame::SESSION.eq(session_id)
                & taskflow_agent_terminal_frame::STREAM.eq(SNAPSHOT_STREAM),
        )
        .order_by(taskflow_agent_terminal_frame::SEQUENCE.desc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    for stale in snapshots.into_iter().skip(SNAPSHOT_HISTORY) {
        // Best-effort: a failed prune is untidy, not incorrect, and must not
        // fail the append that the agent is waiting on.
        let _ = TaskflowAgentTerminalFrame::objects()
            .filter(taskflow_agent_terminal_frame::ID.eq(stale.id))
            .delete()
            .await;
    }
    Ok(())
}

/// The stored value of `TaskflowTerminalStream::Snapshot` (the column is text).
const SNAPSHOT_STREAM: &str = "snapshot";

/// `POST /api/taskflow/agents/sessions/{session}/close` (agent-authed) —
/// disconnect a session: `status=disconnected`, `disconnected_at=now`. Then, if
/// the agent has NO other `connected` session, the agent row is flipped to
/// `offline`; if another session is still live the agent stays online. 404/403
/// as for heartbeat. Takes no body.
pub async fn close_session(
    RequireAgent(agent): RequireAgent,
    Path(session_id): Path<i64>,
) -> Result<Response, StatusCode> {
    let mut session = load_owned_session(session_id, agent.agent_id).await?;
    let now = chrono::Utc::now();
    session.status = TaskflowAgentSessionStatus::Disconnected;
    session.disconnected_at = Some(now);
    let session = TaskflowAgentSession::objects()
        .save(session)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Count is taken AFTER this session was saved disconnected, so it excludes
    // the one we just closed. Zero remaining LIVE sessions → agent offline.
    // Counting by status alone would let an abandoned session (a process that
    // died without closing) pin the agent online permanently.
    let still_connected = live_session_count(agent.agent_id, now).await?;
    if still_connected == 0 {
        let mut agent_row = TaskflowAgent::objects()
            .filter(taskflow_agent::ID.eq(agent.agent_id))
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        agent_row.status = TaskflowAgentStatus::Offline;
        TaskflowAgent::objects()
            .save(agent_row)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    Ok((StatusCode::OK, Json(session)).into_response())
}

// ---------------------------------------------------------------------------
// Stage 4 — agent-authored tasks + the review workflow (reviewer identity,
// reported back to the assigned agent).
//
// Agents create/claim/advance tasks AS THEMSELVES (`RequireAgent`, project =
// the agent's own project). A review (by a human OR an agent reviewer) records
// a decision, transitions the task, posts a report-back message into the
// project room so the assigned agent surfaces it, and logs an activity. The
// review model + these endpoints live here (not `taskflow-tasks`) so a row can
// FK both `TaskflowTask` and `TaskflowAgent` without a plugin cycle.
// ---------------------------------------------------------------------------

/// A task title/description/notes are markdown fields capped at 12000 chars in
/// the model (title at 220). Reject at the edge (400) rather than let the DB
/// truncate or error.
const MAX_TASK_TITLE_CHARS: usize = 220;
const MAX_TASK_TEXT_CHARS: usize = 12_000;

/// Load a task by id, or 404 if it does not exist. The caller then decides
/// whether the reviewer/agent may act on it (project scope).
async fn load_task(task_id: i64) -> Result<TaskflowTask, StatusCode> {
    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)
}

/// Emit one `TaskflowTaskActivity` row for `task`. The activity stream is the
/// single history feed the frontend renders; every task write here appends to
/// it. Identity fields are derived by the caller, never accepted from a body.
async fn emit_task_activity(
    project_id: i64,
    task_id: i64,
    actor_kind: TaskflowActorKind,
    actor_user: Option<i64>,
    actor_agent_id: Option<i64>,
    actor_label: String,
    action: &str,
    body: Option<String>,
) -> Result<(), StatusCode> {
    TaskflowTaskActivity::objects()
        .create(TaskflowTaskActivity {
            id: 0,
            project: ForeignKey::new(project_id),
            task: Some(ForeignKey::new(task_id)),
            actor_kind,
            actor_user: actor_user.map(ForeignKey::new),
            actor_agent_id,
            actor_label,
            action: action.to_string(),
            body_markdown: body,
            metadata_json: None,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

/// The body of `POST /api/taskflow/agents/tasks` (agent-authed). Only content
/// fields — `project` (the agent's own), `created_by`, and the assignee trio are
/// all derived server-side, so there is nothing to forge. `claim` self-assigns
/// the new task to the creating agent.
#[derive(Debug, Deserialize)]
pub struct AgentCreateTaskInput {
    pub title: String,
    #[serde(default)]
    pub description_markdown: Option<String>,
    #[serde(default)]
    pub priority: Option<TaskflowTaskPriority>,
    #[serde(default)]
    pub notes_markdown: Option<String>,
    #[serde(default)]
    pub claim: Option<bool>,
}

/// `POST /api/taskflow/agents/tasks` (agent-authed) — an agent authors a task in
/// ITS OWN project. `created_by` is `None` (no human author); when `claim` is
/// true the task is self-assigned (`assigned_agent_id` + `assignee_label` from
/// the authenticated agent). Emits a `created_task` activity and returns the task.
pub async fn create_task_as_agent(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<AgentCreateTaskInput>,
) -> Result<Response, StatusCode> {
    let title = input.title.trim().to_string();
    if title.is_empty() || title.chars().count() > MAX_TASK_TITLE_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }
    let description = input.description_markdown.unwrap_or_default();
    if description.chars().count() > MAX_TASK_TEXT_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }
    if let Some(notes) = input.notes_markdown.as_deref() {
        if notes.chars().count() > MAX_TASK_TEXT_CHARS {
            return Err(StatusCode::BAD_REQUEST);
        }
    }

    let claim = input.claim.unwrap_or(false);
    let (assigned_agent_id, assignee_label) = if claim {
        (Some(agent.agent_id), Some(agent.display_name.clone()))
    } else {
        (None, None)
    };

    let task = TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            // Scope is the agent's own project, never accepted from the body.
            project: ForeignKey::new(agent.project_id),
            title,
            description_markdown: description,
            notes_markdown: input.notes_markdown,
            status: TaskflowTaskStatus::NotStarted,
            priority: input.priority.unwrap_or(TaskflowTaskPriority::Normal),
            sort_order: 0,
            created_by: None,
            created_by_agent_id: Some(agent.agent_id),
            assigned_user: None,
            assigned_agent_id,
            operator_user: None,
            operator_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            assignee_label,
            due_at: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    emit_task_activity(
        agent.project_id,
        task.id,
        TaskflowActorKind::Agent,
        None,
        Some(agent.agent_id),
        agent.display_name.clone(),
        "created_task",
        None,
    )
    .await?;

    Ok((StatusCode::OK, Json(task)).into_response())
}

/// Load a task and prove it belongs to `project_id`. 404 if the task does not
/// exist; 403 if it belongs to a DIFFERENT project — an agent may only touch
/// tasks in its own project. The project check is the authorization boundary for
/// the agent status/claim endpoints.
async fn load_task_in_project(task_id: i64, project_id: i64) -> Result<TaskflowTask, StatusCode> {
    let task = load_task(task_id).await?;
    if task.project.id() != project_id {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(task)
}

/// The body of `POST /api/taskflow/agents/tasks/{task}/status`. Only the target
/// status; the task comes from the path and the actor from the auth gate.
#[derive(Debug, Deserialize)]
pub struct AgentUpdateStatusInput {
    pub status: TaskflowTaskStatus,
}

/// `POST /api/taskflow/agents/tasks/{task}/status` (agent-authed) — an agent
/// moves its work along (e.g. to `partial_done` to request review). Validates the
/// task is in the agent's project (404 unknown, 403 foreign), sets `status` +
/// `updated_at`, and emits a `status_changed` activity (`old → new`).
pub async fn update_task_status_as_agent(
    RequireAgent(agent): RequireAgent,
    Path(task_id): Path<i64>,
    Json(input): Json<AgentUpdateStatusInput>,
) -> Result<Response, StatusCode> {
    let mut task = load_task_in_project(task_id, agent.project_id).await?;
    let old_status = task.status;
    task.status = input.status;
    task.updated_at = Some(chrono::Utc::now());
    let task = TaskflowTask::objects()
        .save(task)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let old = serde_json::to_value(old_status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let new = serde_json::to_value(input.status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    emit_task_activity(
        agent.project_id,
        task.id,
        TaskflowActorKind::Agent,
        None,
        Some(agent.agent_id),
        agent.display_name.clone(),
        "status_changed",
        Some(format!("{old} → {new}")),
    )
    .await?;

    Ok((StatusCode::OK, Json(task)).into_response())
}

/// `POST /api/taskflow/agents/tasks/{task}/claim` (agent-authed) — an agent
/// self-assigns a task in its own project: `assigned_agent_id` + `assignee_label`
/// from the authenticated agent. Emits a `claimed_task` activity. Takes no body.
pub async fn claim_task_as_agent(
    RequireAgent(agent): RequireAgent,
    Path(task_id): Path<i64>,
) -> Result<Response, StatusCode> {
    let mut task = load_task_in_project(task_id, agent.project_id).await?;
    task.assigned_agent_id = Some(agent.agent_id);
    task.assignee_label = Some(agent.display_name.clone());
    task.updated_at = Some(chrono::Utc::now());
    let task = TaskflowTask::objects()
        .save(task)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    emit_task_activity(
        agent.project_id,
        task.id,
        TaskflowActorKind::Agent,
        None,
        Some(agent.agent_id),
        agent.display_name.clone(),
        "claimed_task",
        None,
    )
    .await?;

    Ok((StatusCode::OK, Json(task)).into_response())
}

/// The review body's cap — the model stores it in a 12000-char column. Reject at
/// the edge (400) rather than let the DB truncate or error.
const MAX_REVIEW_BODY_CHARS: usize = 12_000;

/// The body of both review routes. `decision` is required; `body_markdown` is an
/// optional note. The reviewer identity comes from the auth gate (human vs
/// agent), never a body field — there is nothing to forge.
#[derive(Debug, Deserialize)]
pub struct ReviewInput {
    pub decision: TaskflowReviewDecision,
    #[serde(default)]
    pub body_markdown: Option<String>,
}

/// Ensure the project has a shared room, creating one if it has none, and make
/// `agent_id` a member of it.
///
/// Without this an agent linked into a fresh project is BOTH mute and deaf: it
/// has no channel to post into, and `apply_review`'s report-back silently skips
/// (no room → no message), so review feedback never reaches it. The human
/// frontend creates the room lazily on first send, which leaves the agent
/// stranded until a human happens to type — so linking, not sending, is the
/// right moment to guarantee the room exists.
///
/// Idempotent: an existing shared room is reused, and the roster row is only
/// inserted when absent. (The `(channel, user)` unique index does NOT dedupe
/// agent rows — `user` is NULL for them, and SQL treats NULLs as distinct — so
/// the existence check here is load-bearing, not just an optimization.)
async fn ensure_project_room(
    project_id: i64,
    agent_id: i64,
    agent_label: &str,
    created_by_user: Option<i64>,
) -> Result<TaskflowAgentChannel, StatusCode> {
    let room = match find_project_room(project_id).await? {
        Some(room) => room,
        None => TaskflowAgentChannel::objects()
            .create(TaskflowAgentChannel {
                id: 0,
                project: ForeignKey::new(project_id),
                title: "Project room".to_string(),
                topic: Some("Shared room for humans and agents in this project.".to_string()),
                kind: TaskflowChannelKind::Project,
                task: None,
                created_by_user: created_by_user.map(ForeignKey::new),
                created_by_agent: None,
                archived: false,
                created_at: None,
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    };

    let already_rostered = TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(room.id)
                & taskflow_agent_channel_member::AGENT.eq(agent_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some();

    if !already_rostered {
        TaskflowAgentChannelMember::objects()
            .create(TaskflowAgentChannelMember {
                id: 0,
                project: ForeignKey::new(project_id),
                channel: ForeignKey::new(room.id),
                member_kind: TaskflowChannelMemberKind::Agent,
                user: None,
                agent: Some(ForeignKey::new(agent_id)),
                display_name: agent_label.to_string(),
                role: "agent".to_string(),
                joined_at: None,
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    Ok(room)
}

/// Find the shared room to report a review back into: prefer the project's
/// `Project`-kind channel, else the first non-`Direct` channel in the project.
/// Returns `None` when the project has no shared room (the review still records;
/// the report-back is skipped).
async fn find_project_room(project_id: i64) -> Result<Option<TaskflowAgentChannel>, StatusCode> {
    let channels = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(project_id))
        .order_by(taskflow_agent_channel::ID.asc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Prefer a dedicated project room; otherwise any non-DM shared channel.
    if let Some(room) = channels
        .iter()
        .find(|c| c.kind == TaskflowChannelKind::Project)
    {
        return Ok(Some(room.clone()));
    }
    Ok(channels
        .into_iter()
        .find(|c| c.kind != TaskflowChannelKind::Direct))
}

/// The shared core of both review routes. Records the review, transitions the
/// task, reports back to the assigned agent, and logs the activity — the only
/// difference between the human and agent routes is the resolved reviewer
/// identity, which the caller passes in already derived from its auth gate.
async fn apply_review(
    task: TaskflowTask,
    reviewer_kind: TaskflowChannelMemberKind,
    reviewer_user: Option<i64>,
    reviewer_agent: Option<i64>,
    reviewer_label: String,
    input: ReviewInput,
) -> Result<Response, StatusCode> {
    let body = input
        .body_markdown
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(b) = &body {
        if b.chars().count() > MAX_REVIEW_BODY_CHARS {
            return Err(StatusCode::BAD_REQUEST);
        }
    }

    let project_id = task.project.id();
    let decision = input.decision;

    // 1/2. Record the review with the resolved reviewer identity.
    let review = TaskflowTaskReview::objects()
        .create(TaskflowTaskReview {
            id: 0,
            project: task.project.clone(),
            task: ForeignKey::new(task.id),
            reviewer_kind,
            reviewer_user: reviewer_user.map(ForeignKey::new),
            reviewer_agent: reviewer_agent.map(ForeignKey::new),
            reviewer_label: reviewer_label.clone(),
            decision,
            body_markdown: body.clone(),
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 3. Transition the task: approved → done, changes_requested → in_progress.
    let new_status = match decision {
        TaskflowReviewDecision::Approved => TaskflowTaskStatus::Done,
        TaskflowReviewDecision::ChangesRequested => TaskflowTaskStatus::InProgress,
    };
    let mut task = task;
    task.status = new_status;
    task.updated_at = Some(chrono::Utc::now());
    let task = TaskflowTask::objects()
        .save(task)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // A human-readable verdict for both the report-back message and the activity.
    let decision_label = match decision {
        TaskflowReviewDecision::Approved => "approved",
        TaskflowReviewDecision::ChangesRequested => "changes requested",
    };

    // 4. Report back to the responsible agent: a message in the project room
    // referencing the task, directed at that agent so it surfaces in its pane
    // (live via SSE, the reconnect catch-up, or check_messages). Only when the
    // task has a responsible agent (assignee OR operator) AND a shared room
    // exists — otherwise the review still stands, the message is skipped. The
    // create auto-emits the realtime event (the message model is Exposed).
    // The agent responsible for the task: the assignee if set, else the operator.
    // Most tasks are operator-only, so gating on `assigned_agent_id` alone (as it
    // did) meant a review on them notified nobody (#37).
    if let Some(recipient_agent) = task.assigned_agent_id.or(task.operator_agent_id) {
        if let Some(channel) = find_project_room(project_id).await? {
            let mut message_body = format!("Review: **{decision_label}** on _{}_.", task.title);
            if let Some(b) = &body {
                message_body.push_str("\n\n");
                message_body.push_str(b);
            }
            TaskflowAgentMessage::objects()
                .create(TaskflowAgentMessage {
                    id: 0,
                    project: channel.project.clone(),
                    channel: ForeignKey::new(channel.id),
                    task: Some(ForeignKey::new(task.id)),
                    sender_kind: reviewer_kind,
                    sender_user: reviewer_user.map(ForeignKey::new),
                    sender_agent: reviewer_agent.map(ForeignKey::new),
                    // Direct it at the responsible agent (#29) so the review lands
                    // in that agent's pane, not broadcast to every connected agent.
                    target_agent: Some(ForeignKey::new(recipient_agent)),
                    sender_label: reviewer_label.clone(),
                    body_markdown: message_body,
                    priority: TaskflowMessagePriority::Normal,
                    client_nonce: None,
                    created_at: None,
                })
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
    }

    // 5. Log the review on the task's activity stream.
    let actor_kind = match reviewer_kind {
        TaskflowChannelMemberKind::User => TaskflowActorKind::User,
        TaskflowChannelMemberKind::Agent => TaskflowActorKind::Agent,
    };
    emit_task_activity(
        project_id,
        task.id,
        actor_kind,
        reviewer_user,
        reviewer_agent,
        reviewer_label,
        "reviewed",
        // Carry the reviewer's note, not just the verdict: the activity stream is
        // the agent's fallback channel for discovering a review, and "changes
        // requested" without the note tells it nothing about what to change.
        Some(match &body {
            Some(b) => format!("{decision_label}: {b}"),
            None => decision_label.to_string(),
        }),
    )
    .await?;

    Ok((StatusCode::OK, Json(review)).into_response())
}

/// `POST /api/taskflow/tasks/{task}/review` (human-authed) — a human reviews a
/// task. The caller must be an ACTIVE member of the task's project (else 403).
/// Records the review (reviewer_kind = user), transitions the task, reports back
/// to the assigned agent, and logs the activity.
pub async fn review_task(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(task_id): Path<i64>,
    Json(input): Json<ReviewInput>,
) -> Result<Response, StatusCode> {
    let task = load_task(task_id).await?;

    // Access gate: an ACTIVE project member of the task's project, read from the
    // table, never trusted from the request. Absent → 403. Mirrors `send_message`.
    let member = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(task.project.id())
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    apply_review(
        task,
        TaskflowChannelMemberKind::User,
        Some(user_id),
        None,
        member.display_name,
        input,
    )
    .await
}

/// `POST /api/taskflow/tasks/{task}/agent/review` (agent-authed) — the agent
/// counterpart of [`review_task`]. The task must be in the agent's project (else
/// 403). Records the review (reviewer_kind = agent), transitions the task, reports
/// back to the assigned agent, and logs the activity.
pub async fn review_task_as_agent(
    RequireAgent(agent): RequireAgent,
    Path(task_id): Path<i64>,
    Json(input): Json<ReviewInput>,
) -> Result<Response, StatusCode> {
    let task = load_task_in_project(task_id, agent.project_id).await?;
    apply_review(
        task,
        TaskflowChannelMemberKind::Agent,
        None,
        Some(agent.agent_id),
        agent.display_name.clone(),
        input,
    )
    .await
}

// ---------------------------------------------------------------------------
// Stage 5 — agent-authed activity ingest. An agent (via Claude Code hooks)
// posts its REAL actions (tool calls, session start/stop, ...) as
// `TaskflowTaskActivity` rows stamped with the agent's identity. Unlike the
// legacy system that only saw MCP tool calls, every row here is derived
// server-side from the authenticated credential — a trustworthy log the client
// cannot forge. Hooks fire rapidly, so the endpoint accepts either a single
// event or a batch (one request per tool call would be wasteful).
// ---------------------------------------------------------------------------

/// The model caps `action` at 120 chars and `body_markdown` at 12000. Reject at
/// the edge (400) rather than let the DB truncate or error.
///
/// `metadata_json` is deliberately NOT length-checked. It holds a tool's input,
/// and a length rule applied to the whole payload is the wrong shape: it rejects
/// (or clips) a structure because ONE field inside it is large, losing the
/// file_path and flags that identify the call along with it. The producer caps
/// the one bulk-carrying field per tool instead — a Write's `content`, a Bash
/// `command` — so what arrives is complete and parseable at whatever length it
/// naturally is. See mcp/hooks/metadata.mjs.
const MAX_ACTION_CHARS: usize = 120;
const MAX_ACTIVITY_BODY_CHARS: usize = 12_000;

/// Upper bound on events per batch. Hooks fire rapidly and coalesce many tool
/// calls into one request; the cap bounds a single request's write amplification
/// so a runaway or hostile client cannot flood the activity stream in one call.
const MAX_ACTIVITY_BATCH: usize = 200;

/// One activity event the agent reports. `action` is required (a short verb like
/// `Read`, `Edit`, `Bash`, `session_start`); the rest is optional detail. The
/// actor identity, project, and timestamp are all derived server-side from the
/// authenticated agent — never accepted here, so there is nothing to forge.
#[derive(Debug, Deserialize)]
pub struct ActivityEventInput {
    pub action: String,
    #[serde(default)]
    pub body_markdown: Option<String>,
    #[serde(default)]
    pub metadata_json: Option<String>,
    #[serde(default)]
    pub task: Option<i64>,
}

/// The activity endpoint accepts EITHER a single event (`{action, ...}`) OR a
/// batch (`{events: [ ... ]}`). Untagged: a body carrying `events` is a batch,
/// otherwise it is parsed as one event — the same shape as the frames endpoint.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum PostActivityInput {
    Batch { events: Vec<ActivityEventInput> },
    Single(ActivityEventInput),
}

/// Validate one event's text fields against the model caps. Empty (or
/// whitespace-only) `action` and any over-cap field is a 400 — the whole batch
/// is validated up front so it either lands whole or not at all (no partial
/// write before a bad event is discovered). Returns the trimmed action.
fn validate_activity_event(event: &ActivityEventInput) -> Result<(), StatusCode> {
    let action = event.action.trim();
    if action.is_empty() || action.chars().count() > MAX_ACTION_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }
    if let Some(body) = event.body_markdown.as_deref() {
        if body.chars().count() > MAX_ACTIVITY_BODY_CHARS {
            return Err(StatusCode::BAD_REQUEST);
        }
    }

    Ok(())
}

/// Resolve an optional task id to a link the activity may keep. The link is kept
/// ONLY IF the task exists AND belongs to `project_id` — a stale, unknown, or
/// foreign-project id drops to `None` rather than failing the event, so one bad
/// id never sinks a whole batch. Absent id stays `None` without a query.
async fn scoped_task_link(
    task_id: Option<i64>,
    project_id: i64,
) -> Result<Option<i64>, StatusCode> {
    let Some(task_id) = task_id else {
        return Ok(None);
    };
    let task = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(match task {
        Some(task) if task.project.id() == project_id => Some(task_id),
        _ => None,
    })
}

/// `POST /api/taskflow/agents/activity` (agent-authed) — ingest the agent's real
/// activity. Accepts a single event or a batch (cap [`MAX_ACTIVITY_BATCH`]). Each
/// event becomes a `TaskflowTaskActivity` stamped `actor_kind=agent`,
/// `actor_agent_id=<id>`, `actor_user=None`, `actor_label=<display_name>`,
/// `project=<agent's project>`. The `task` link is kept only if that task is in
/// the agent's project (else dropped to `None` — a stale id never fails the
/// batch). Empty or over-long `action` is a 400. Returns `{ created: <count> }`.
///
/// Realtime already exposes `task_activity` (id-only), so subscribers see each
/// new row without any change here.
pub async fn post_activity_as_agent(
    RequireAgent(agent): RequireAgent,
    Json(input): Json<PostActivityInput>,
) -> Result<Response, StatusCode> {
    let events = match input {
        PostActivityInput::Batch { events } => events,
        PostActivityInput::Single(event) => vec![event],
    };
    if events.is_empty() || events.len() > MAX_ACTIVITY_BATCH {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Validate every event up front so the batch lands whole or not at all — a
    // bad action in event 3 must not leave events 1–2 already written.
    for event in &events {
        validate_activity_event(event)?;
    }

    let mut created = 0i64;
    for event in events {
        // Task scoping is per event: keep the link only for a task in the agent's
        // own project, else drop it (never a 400 — a stale id is not a failure).
        let task_link = scoped_task_link(event.task, agent.project_id).await?;

        TaskflowTaskActivity::objects()
            .create(TaskflowTaskActivity {
                id: 0,
                // Scope is the agent's own project, never accepted from the body.
                project: ForeignKey::new(agent.project_id),
                task: task_link.map(ForeignKey::new),
                actor_kind: TaskflowActorKind::Agent,
                actor_user: None,
                actor_agent_id: Some(agent.agent_id),
                actor_label: agent.display_name.clone(),
                action: event.action.trim().to_string(),
                body_markdown: event.body_markdown,
                metadata_json: event.metadata_json,
                created_at: None,
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        created += 1;
    }

    Ok((StatusCode::OK, Json(json!({ "created": created }))).into_response())
}

// ---------------------------------------------------------------------------
// Stage 6 — agent-authed READ endpoints the MCP needs. REST is human-authed, so
// these give an agent a project-scoped read surface using its own credential
// (`RequireAgent`). Every query is filtered to the agent's `project_id`, exactly
// as the write paths scope their writes — an agent can only ever see its own
// project. No new model/migration; these are pure reads over existing tables.
// ---------------------------------------------------------------------------

/// The default and hard-cap page sizes shared by the paginated read endpoints
/// (`messages`, `activity`). A request may ask for fewer, never more; a missing
/// or non-positive value falls back to the default.
const READ_LIMIT_DEFAULT: i64 = 50;
const READ_LIMIT_MAX: i64 = 200;

/// Resolve a client-supplied `?limit=` to an effective page size: clamp to
/// `[1, READ_LIMIT_MAX]`, defaulting to `READ_LIMIT_DEFAULT` when absent or
/// non-positive. Returned as `u64` for the ORM's `.limit`.
fn effective_limit(requested: Option<i64>) -> u64 {
    match requested {
        Some(n) if n > 0 => n.min(READ_LIMIT_MAX) as u64,
        _ => READ_LIMIT_DEFAULT as u64,
    }
}

/// Whether `agent_id` is on `channel`'s explicit roster (a `member_kind = agent`
/// row). The building block of channel visibility for an agent.
async fn agent_on_channel_roster(channel_id: i64, agent_id: i64) -> Result<bool, StatusCode> {
    Ok(TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel_id)
                & taskflow_agent_channel_member::AGENT.eq(agent_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some())
}

/// Whether the agent may see `channel` — the same rule the write paths enforce:
/// an explicit agent roster row, OR a shared (non-`Direct`) room in the agent's
/// own project. A DM the agent isn't on the roster of, or any room in another
/// project, is invisible.
async fn agent_can_see_channel(
    channel: &TaskflowAgentChannel,
    agent_id: i64,
    project_id: i64,
) -> Result<bool, StatusCode> {
    if agent_on_channel_roster(channel.id, agent_id).await? {
        return Ok(true);
    }
    Ok(channel.kind != TaskflowChannelKind::Direct && channel.project.id() == project_id)
}

/// `GET /api/taskflow/agents/whoami` (agent-authed) — the identity behind the
/// presented credential. Loads the authenticated `TaskflowAgent` row and returns
/// its stable identity fields, so an agent (or the MCP acting for it) can confirm
/// who it is and which project it is scoped to before doing anything else.
pub async fn whoami_as_agent(RequireAgent(agent): RequireAgent) -> Result<Response, StatusCode> {
    let row = TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(agent.agent_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    // Report DERIVED liveness, not the stored column. The column records the
    // agent's last declared intent and is only corrected when a session is
    // explicitly closed — so an agent whose previous process died would read its
    // own status as "busy" forever. Deriving here is a pure read: no write on a
    // GET, and no realtime event fired by a status query.
    let now = chrono::Utc::now();
    let has_live_session = live_session_count(row.id, now).await? > 0;
    let status = effective_agent_status(row.status, has_live_session);

    Ok((
        StatusCode::OK,
        Json(json!({
            "agent_id": row.id,
            "display_name": row.display_name,
            "identifier": row.identifier,
            "project": row.project.id(),
            "status": status,
        })),
    )
        .into_response())
}

/// Query for `GET /api/taskflow/agents/tasks`. Both filters are optional:
/// `status` narrows to one `TaskflowTaskStatus` (the stored snake_case string),
/// `assigned=me` narrows to tasks claimed by THIS agent.
#[derive(Debug, Deserialize)]
pub struct ListTasksQuery {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub assigned: Option<String>,
}

/// `GET /api/taskflow/agents/tasks` (agent-authed) — the tasks in the agent's
/// project, ordered `sort_order, id` (the board order). `?status=` filters to one
/// status; `?assigned=me` filters to tasks this agent has claimed. Returns the
/// full task rows as a flat array.
pub async fn list_tasks_as_agent(
    RequireAgent(agent): RequireAgent,
    Query(params): Query<ListTasksQuery>,
) -> Result<Response, StatusCode> {
    let mut query =
        TaskflowTask::objects().filter(taskflow_task::PROJECT.eq(agent.project_id));

    // The status column is a string at the DB layer (same convention as the
    // credential/membership gates); filter on the trimmed value directly. An
    // unknown status simply matches no rows.
    if let Some(status) = params.status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        query = query.filter(taskflow_task::STATUS.eq(status));
    }

    // `assigned=me` narrows to tasks this agent has claimed. Any other value is
    // ignored (no assignee filter), matching the lenient query-param style
    // elsewhere in this file.
    if params.assigned.as_deref() == Some("me") {
        query = query.filter(taskflow_task::ASSIGNED_AGENT_ID.eq(agent.agent_id));
    }

    let tasks = query
        .order_by(taskflow_task::SORT_ORDER.asc())
        .order_by(taskflow_task::ID.asc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Merge each task's attachments so the agent knows about them and can pull
    // them with `download_attachment` (via the resolved `/media` url). Fetch the
    // project's attachments once and group in Rust — the task set is small.
    let attachments = TaskflowTaskAttachment::objects()
        .filter(taskflow_task_attachment::PROJECT.eq(agent.project_id))
        .order_by(taskflow_task_attachment::ID.asc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let out: Vec<serde_json::Value> = tasks
        .iter()
        .map(|task| {
            let mut value = serde_json::to_value(task).unwrap_or_else(|_| json!({}));
            let items: Vec<serde_json::Value> = attachments
                .iter()
                .filter(|a| a.task.id() == task.id)
                .map(task_attachment_json)
                .collect();
            if let serde_json::Value::Object(map) = &mut value {
                map.insert("attachments".to_string(), json!(items));
            }
            value
        })
        .collect();

    Ok((StatusCode::OK, Json(json!(out))).into_response())
}

/// `GET /api/taskflow/agents/channels` (agent-authed) — the channels the agent
/// may see in its project: every shared (non-`Direct`) room PLUS the `Direct`
/// channels the agent is explicitly on the roster of. Returns a flat array of
/// `{ id, title, kind, topic }`, ordered by id.
pub async fn list_channels_as_agent(
    RequireAgent(agent): RequireAgent,
) -> Result<Response, StatusCode> {
    // The channels this agent is explicitly rostered into — the only DMs it may
    // see. One query, then an in-memory membership test per channel.
    let roster_channel_ids: Vec<i64> = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::AGENT.eq(agent.agent_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .map(|m| m.channel.id())
        .collect();

    let channels = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(agent.project_id))
        .order_by(taskflow_agent_channel::ID.asc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let visible: Vec<serde_json::Value> = channels
        .into_iter()
        // A shared room is visible to any in-project agent; a DM only if rostered.
        .filter(|c| {
            c.kind != TaskflowChannelKind::Direct || roster_channel_ids.contains(&c.id)
        })
        .map(|c| {
            json!({
                "id": c.id,
                "title": c.title,
                "kind": c.kind,
                "topic": c.topic,
            })
        })
        .collect();

    Ok((StatusCode::OK, Json(json!(visible))).into_response())
}

/// Query for `GET /api/taskflow/agents/messages`. `channel` is required; `since`
/// pages forward (`id > since`); `limit` caps the page (default 50, max 200).
#[derive(Debug, Deserialize)]
pub struct ListMessagesQuery {
    pub channel: i64,
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    /// `unread=true` returns only messages past this agent's read cursor. An
    /// agent asking "anything for me?" wants exactly that, and making it a
    /// server-side filter means the agent cannot get it wrong by mis-comparing
    /// ids client-side.
    #[serde(default)]
    pub unread: Option<bool>,
}

/// `GET /api/taskflow/agents/messages?channel=&since=&limit=` (agent-authed) —
/// the messages in a channel the agent may see. Verifies channel visibility
/// (same rule as the send path: roster row, or a shared room in the agent's
/// project) — 404 if the channel is unknown, 403 if it exists but the agent
/// cannot see it. Orders by id, pages forward with `id > since`, and caps the
/// page. Returns `{ messages: [...], read_cursor: <message_id|null> }`, where
/// `read_cursor` is how far THIS agent has read (so the client knows unread).
pub async fn list_messages_as_agent(
    RequireAgent(agent): RequireAgent,
    Query(params): Query<ListMessagesQuery>,
) -> Result<Response, StatusCode> {
    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(params.channel))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Visibility is the authorization boundary — a channel the agent can't see
    // must never leak its messages.
    if !agent_can_see_channel(&channel, agent.agent_id, agent.project_id).await? {
        return Err(StatusCode::FORBIDDEN);
    }

    // The agent's own read cursor for this channel, if it has one — the id of the
    // furthest message it has read. `null` when the agent has never marked read.
    // Read BEFORE the messages so `unread=true` can filter on it.
    let read_cursor = TaskflowChannelReadCursor::objects()
        .filter(
            taskflow_channel_read_cursor::CHANNEL.eq(channel.id)
                & taskflow_channel_read_cursor::MEMBER_AGENT.eq(agent.agent_id),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .and_then(|c| c.last_read_message.as_ref().map(|fk| fk.id()));

    // `since` and `unread` both page forward; when both are given take the
    // stricter, so an explicit `since` can never re-deliver something already
    // marked read.
    let floor = match (params.since, params.unread.unwrap_or(false)) {
        (Some(since), true) => Some(since.max(read_cursor.unwrap_or(0))),
        (Some(since), false) => Some(since),
        (None, true) => Some(read_cursor.unwrap_or(0)),
        (None, false) => None,
    };

    let mut query = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::CHANNEL.eq(channel.id));
    if let Some(floor) = floor {
        query = query.filter(taskflow_agent_message::ID.gt(floor));
    }
    let messages = query
        .order_by(taskflow_agent_message::ID.asc())
        .limit(effective_limit(params.limit))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // One batched query for the whole page — never N+1. Grouped by message id
    // so each message carries only its own files.
    let message_ids: Vec<i64> = messages.iter().map(|m| m.id).collect();
    let all_attachments = if message_ids.is_empty() {
        Vec::new()
    } else {
        TaskflowMessageAttachment::objects()
            .filter(taskflow_message_attachment::MESSAGE.in_(&message_ids))
            .fetch()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };

    let mut serialized = Vec::with_capacity(messages.len());
    for message in &messages {
        let own: Vec<TaskflowMessageAttachment> = all_attachments
            .iter()
            .filter(|a| a.message.id() == message.id)
            .cloned()
            .collect();
        serialized.push(message_json(message, &own)?);
    }

    // `unread_count` is the size of THIS page, which is what the caller acts on.
    // The agent's own messages are included: it asked for the channel's traffic,
    // and its cursor is what defines "already handled", not authorship.
    Ok((
        StatusCode::OK,
        Json(json!({
            "messages": serialized,
            "read_cursor": read_cursor,
            "unread_count": messages.len(),
        })),
    )
        .into_response())
}

/// `GET /api/taskflow/agents/agents` (agent-authed) — the other agents in the
/// caller's project, so an agent can discover who to address. Returns a flat
/// array of `{ id, display_name, identifier, status, last_seen_at }`, ordered by
/// id.
pub async fn list_agents_as_agent(
    RequireAgent(agent): RequireAgent,
) -> Result<Response, StatusCode> {
    let agents = TaskflowAgent::objects()
        .filter(taskflow_agent::PROJECT.eq(agent.project_id))
        .order_by(taskflow_agent::ID.asc())
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Derive liveness for the whole roster from ONE session query rather than a
    // per-agent count — this is the "who else is around?" call, so it should not
    // fan out into N queries. Same correction as `whoami`: a stored busy/idle
    // with no live session behind it is stale and reads as offline.
    let now = chrono::Utc::now();
    let live_agent_ids: std::collections::HashSet<i64> = TaskflowAgentSession::objects()
        .filter(
            taskflow_agent_session::PROJECT.eq(agent.project_id)
                & taskflow_agent_session::STATUS.eq(CONNECTED_SESSION),
        )
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .iter()
        .filter(|s| session_is_live(s, now))
        .map(|s| s.agent.id())
        .collect();

    let items: Vec<serde_json::Value> = agents
        .into_iter()
        .map(|a| {
            let status = effective_agent_status(a.status, live_agent_ids.contains(&a.id));
            json!({
                "id": a.id,
                "display_name": a.display_name,
                "identifier": a.identifier,
                "status": status,
                "last_seen_at": a.last_seen_at,
            })
        })
        .collect();

    Ok((StatusCode::OK, Json(json!(items))).into_response())
}

/// Query for `GET /api/taskflow/agents/activity`. `task` optionally narrows to
/// one task's activity; `limit` caps the page (default 50, max 200).
#[derive(Debug, Deserialize)]
pub struct ListActivityQuery {
    #[serde(default)]
    pub task: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// `GET /api/taskflow/agents/activity?task=&limit=` (agent-authed) — the recent
/// `TaskflowTaskActivity` in the agent's project, newest first, capped. `?task=`
/// narrows to one task's stream. Returns the full activity rows as a flat array.
pub async fn list_activity_as_agent(
    RequireAgent(agent): RequireAgent,
    Query(params): Query<ListActivityQuery>,
) -> Result<Response, StatusCode> {
    let mut query = TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::PROJECT.eq(agent.project_id));
    if let Some(task_id) = params.task {
        query = query.filter(taskflow_task_activity::TASK.eq(task_id));
    }

    let activity = query
        .order_by(taskflow_task_activity::ID.desc())
        .limit(effective_limit(params.limit))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((StatusCode::OK, Json(json!(activity))).into_response())
}

// ---------------------------------------------------------------------------
// Agent event stream — instant delivery of messages to a running agent.
// ---------------------------------------------------------------------------

/// `GET /api/taskflow/agents/events` (agent-authed) — a Server-Sent Events
/// stream of this agent's project chat traffic.
///
/// WHY A SEPARATE ROUTE. The framework already serves `/realtime/sse`, but its
/// group policy authenticates a USER and checks project membership
/// (`may_join` in backend/src/realtime.rs). An agent credential is not a user,
/// so it can never pass that gate. Rather than widen a policy that guards every
/// group, this registers directly with the realtime hub and authorizes the join
/// itself: the credential already pins the agent to one project, so the only
/// group it can ever be given is that project's message group.
///
/// The alternative — having the agent poll — is what this replaces. A poll makes
/// message delivery as slow as its interval, and every agent pays for the
/// interval even when nothing is said.
/// Keys the dashboard may send to a terminal — digits and named navigation keys
/// only, matching the MCP send-keys whitelist (`sendKeyToPane`). Never a control
/// combo, so a compromised or buggy client can't `C-c` an agent's pane.
fn is_allowed_terminal_key(key: &str) -> bool {
    matches!(
        key,
        "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
            | "Up" | "Down" | "Left" | "Right" | "Enter" | "Space" | "Tab" | "Escape" | "BSpace"
    )
}

#[derive(Debug, Deserialize)]
pub struct TerminalKeyInput {
    pub key: String,
}

/// `POST /api/taskflow/agents/{agent}/terminal-input` (human-authed) — send ONE
/// key to an agent's terminal. Recording the row broadcasts it on the project's
/// `terminal_inputs` realtime group; the target agent's MCP mirror types it into
/// its tmux pane (other agents ignore it — the `agent` id is projected on the
/// event). Member-gated on the agent's project; a key outside the allowlist is a
/// 400 so no control combo can reach a pane.
pub async fn send_terminal_key(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(agent_id): Path<i64>,
    Json(input): Json<TerminalKeyInput>,
) -> Result<Response, StatusCode> {
    if !is_allowed_terminal_key(&input.key) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let agent = TaskflowAgent::objects()
        .get(taskflow_agent::ID.eq(agent_id))
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let project_id = agent.project.id();

    // Authorize: an active member of the agent's project.
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    let row = TaskflowTerminalInput::objects()
        .create(TaskflowTerminalInput {
            id: 0,
            project: agent.project.clone(),
            agent: ForeignKey::new(agent.id),
            keys: input.key,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((StatusCode::CREATED, Json(json!({ "id": row.id }))).into_response())
}

pub async fn agent_event_stream(
    RequireAgent(agent): RequireAgent,
) -> Result<Response, StatusCode> {
    use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
    use std::collections::HashSet;
    use tokio_stream::{StreamExt, wrappers::ReceiverStream};
    use umbral_realtime::Realtime;

    if !Realtime::is_installed() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    // The ONLY group an agent connection is ever placed in. Not client-supplied:
    // it is derived from the credential, so an agent cannot listen to another
    // project by asking.
    // Messages to deliver, and prompt answers to type back. Both are derived
    // from the credential's project — never client-supplied.
    let mut groups = HashSet::new();
    groups.insert(format!("project:{}:messages", agent.project_id));
    groups.insert(format!("project:{}:prompts", agent.project_id));
    // Terminal keys the dashboard sends; the mirror types the ones addressed to
    // this agent into its pane (the event carries the target `agent` id).
    groups.insert(format!("project:{}:terminal_inputs", agent.project_id));

    let registry = Realtime::registry();
    let (conn_id, rx) = registry
        .register(None, groups, AGENT_STREAM_BUFFER)
        .await
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    // Deregistering on disconnect is not optional: without it every dropped
    // agent connection leaves an entry in the hub's group index forever.
    let guard = AgentStreamGuard { registry, conn_id };

    let stream = ReceiverStream::new(rx).map(move |event| {
        // Hold the guard inside the stream so it drops exactly when the stream
        // does — i.e. when the client disconnects.
        let _guard = &guard;
        Ok::<_, std::convert::Infallible>(
            SseEvent::default().event("u").data(
                json!({ "c": event.channel, "e": event.event, "d": event.data }).to_string(),
            ),
        )
    });

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// Per-connection event buffer. Chat traffic is bursty but small; a slow client
/// that fills this is dropped by the hub rather than allowed to grow unbounded.
const AGENT_STREAM_BUFFER: usize = 64;

/// Removes the connection from the realtime hub when the stream is dropped.
/// `deregister` is async and `Drop` is not, so it spawns — the server runtime is
/// always present here.
struct AgentStreamGuard {
    registry: std::sync::Arc<umbral_realtime::Registry>,
    conn_id: u64,
}

impl Drop for AgentStreamGuard {
    fn drop(&mut self) {
        let registry = self.registry.clone();
        let id = self.conn_id;
        tokio::spawn(async move {
            registry.deregister(id).await;
        });
    }
}

// ---------------------------------------------------------------------------
// Terminal prompts — a question the agent's screen is BLOCKED on.
// ---------------------------------------------------------------------------

/// The body of `POST /api/taskflow/agents/sessions/{session}/prompt`.
#[derive(Debug, Deserialize)]
pub struct ReportPromptInput {
    pub question: String,
    /// JSON array of `{ number, label }`, already serialized by the agent.
    pub options_json: String,
    #[serde(default)]
    pub kind: Option<String>,
    pub fingerprint: String,
}

const MAX_PROMPT_QUESTION_CHARS: usize = 2_000;
const MAX_PROMPT_OPTIONS_CHARS: usize = 8_000;

/// `POST /api/taskflow/agents/sessions/{session}/prompt` (agent-authed) — record
/// that this session is waiting on a question.
///
/// UPSERT by fingerprint: the agent re-reports on every capture while the prompt
/// is on screen (it has no event to fire when one appears), so a plain insert
/// would pile up a row per second. Re-reporting the same question is a no-op.
/// The user of the agent's "current DM" (#6): the sender of the most recent
/// human message in any Direct channel the agent is on. `None` when the agent
/// has no direct-message history — the prompt then stays project-wide (the
/// dashboard shows it to everyone). Bounded lookback (the newest 50 DM messages)
/// so a long history never turns this into a scan.
async fn current_dm_user(agent_id: i64) -> Result<Option<i64>, StatusCode> {
    let memberships = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::AGENT.eq(agent_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let channel_ids: Vec<i64> = memberships.iter().map(|m| m.channel.id()).collect();
    if channel_ids.is_empty() {
        return Ok(None);
    }

    let direct_ids: Vec<i64> = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.in_(&channel_ids))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .filter(|c| c.kind == TaskflowChannelKind::Direct)
        .map(|c| c.id)
        .collect();
    if direct_ids.is_empty() {
        return Ok(None);
    }

    let recent = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::CHANNEL.in_(&direct_ids))
        .order_by(taskflow_agent_message::ID.desc())
        .limit(50)
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(recent
        .into_iter()
        .find(|m| m.sender_kind == TaskflowChannelMemberKind::User && m.sender_user.is_some())
        .and_then(|m| m.sender_user.map(|fk| fk.id())))
}

pub async fn report_session_prompt(
    RequireAgent(agent): RequireAgent,
    Path(session_id): Path<i64>,
    Json(input): Json<ReportPromptInput>,
) -> Result<Response, StatusCode> {
    let session = load_owned_session(session_id, agent.agent_id).await?;
    let question = input.question.trim().to_string();
    if question.is_empty()
        || question.chars().count() > MAX_PROMPT_QUESTION_CHARS
        || input.options_json.chars().count() > MAX_PROMPT_OPTIONS_CHARS
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Already recorded and still pending → return it untouched. This is the
    // common path, hit once per capture.
    if let Some(existing) = TaskflowAgentPrompt::objects()
        .filter(
            taskflow_agent_prompt::SESSION.eq(session.id)
                & taskflow_agent_prompt::FINGERPRINT.eq(input.fingerprint.as_str())
                & taskflow_agent_prompt::STATUS.eq(PENDING_PROMPT),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Ok((StatusCode::OK, Json(existing)).into_response());
    }

    // A different question replaces the old one: the agent can only ever block on
    // one prompt at a time, so anything still pending is stale.
    cancel_pending_prompts(session.id).await?;

    // #6: direct the question at whoever the agent is currently DMing.
    let target_user = current_dm_user(agent.agent_id).await?;

    let created = TaskflowAgentPrompt::objects()
        .create(TaskflowAgentPrompt {
            id: 0,
            project: ForeignKey::new(agent.project_id),
            agent: ForeignKey::new(agent.agent_id),
            session: ForeignKey::new(session.id),
            target_user: target_user.map(ForeignKey::new),
            question,
            options_json: input.options_json,
            kind: input.kind.unwrap_or_else(|| "single".to_string()),
            fingerprint: input.fingerprint,
            status: TaskflowPromptStatus::Pending,
            answer: None,
            answer_json: None,
            answer_text_json: None,
            answered_by: None,
            answered_at: None,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((StatusCode::OK, Json(created)).into_response())
}

/// `POST /api/taskflow/agents/sessions/{session}/prompt/clear` (agent-authed) —
/// the prompt left the screen (answered at the keyboard, or cancelled).
pub async fn clear_session_prompt(
    RequireAgent(agent): RequireAgent,
    Path(session_id): Path<i64>,
) -> Result<Response, StatusCode> {
    let session = load_owned_session(session_id, agent.agent_id).await?;
    let cleared = cancel_pending_prompts(session.id).await?;
    Ok((StatusCode::OK, Json(json!({ "cleared": cleared }))).into_response())
}

/// The body of `POST /api/taskflow/prompts/{prompt}/answer`.
#[derive(Debug, Deserialize)]
pub struct AnswerPromptInput {
    /// The option NUMBER to press, for a single-select question.
    #[serde(default)]
    pub choice: Option<i64>,
    /// The option numbers to toggle, for a multi-select question. Verified
    /// against a live Claude Code session: numbers TOGGLE checkboxes, then Right
    /// opens a review pane, then 1 submits — so a multi answer is a set, and
    /// sending one digit would silently answer the wrong thing.
    #[serde(default)]
    pub choices: Option<Vec<i64>>,
    /// One choice list PER QUESTION, for a prompt carrying several questions.
    ///
    /// `AskUserQuestion` accepts a set, and the agent's terminal shows them one
    /// at a time, so the whole set is answered at once and replayed in order. A
    /// partial set is refused: the agent would send the leftover digits at
    /// whatever screen it had moved on to.
    #[serde(default)]
    pub answers: Option<Vec<Vec<i64>>>,
    /// Chose "Cancel" on the review screen rather than "Submit".
    ///
    /// The answers still come with it and are still validated and stored: the
    /// review screen only exists once every question has been answered, so the
    /// agent replays the choices to GET there and only then presses cancel.
    #[serde(default)]
    pub cancel: Option<bool>,
    /// One free-text value per question, `null` where the question has no Other
    /// pick. Only valid where that question has an `is_other` option and its
    /// number is in the answer set.
    #[serde(default)]
    pub texts: Option<Vec<Option<String>>>,
}

/// One question inside a multi-question `options_json`.
#[derive(Debug, Deserialize)]
struct PromptQuestionPayload {
    #[serde(default)]
    kind: Option<String>,
    options: Vec<PromptOptionPayload>,
}

/// The questions a prompt is asking, whichever shape `options_json` is in.
///
/// Legacy rows store a bare option list for a single question; newer rows store
/// a list of questions. Both must keep working — rows written before the change
/// are still in the table, and an unreadable prompt blocks its agent forever.
fn prompt_questions(options_json: &str, kind: &str) -> Vec<PromptQuestionPayload> {
    if let Ok(questions) = serde_json::from_str::<Vec<PromptQuestionPayload>>(options_json)
        && !questions.is_empty()
    {
        return questions;
    }
    let options: Vec<PromptOptionPayload> =
        serde_json::from_str(options_json).unwrap_or_default();
    if options.is_empty() {
        return Vec::new();
    }
    vec![PromptQuestionPayload {
        kind: Some(kind.to_string()),
        options,
    }]
}

/// `POST /api/taskflow/prompts/{prompt}/answer` (human-authed) — answer a
/// question an agent is blocked on.
///
/// Recording the answer is all this does. The keystroke is sent by the agent's
/// own process, which is watching for this row to change — the server has no
/// access to anyone's terminal, and should not.
pub async fn answer_prompt(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(prompt_id): Path<i64>,
    Json(input): Json<AnswerPromptInput>,
) -> Result<Response, StatusCode> {
    let mut prompt = TaskflowAgentPrompt::objects()
        .filter(taskflow_agent_prompt::ID.eq(prompt_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Same gate as every other human write here: an ACTIVE member of the
    // prompt's project, read from the table, never trusted from the request.
    let project_id = prompt.project.id();
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    if prompt.status != TaskflowPromptStatus::Pending {
        // Answering twice is a race between two humans, not an error worth a
        // 500 — tell the caller it is settled and by what.
        return Ok((StatusCode::CONFLICT, Json(prompt)).into_response());
    }

    // Every chosen number must be one the agent actually offered. Without this
    // the API would happily type an arbitrary digit into a live terminal.
    let questions = prompt_questions(&prompt.options_json, &prompt.kind);
    if questions.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    // One choice list per question. The legacy single-question shapes collapse
    // into a one-element set so validation and storage have one path.
    let sets: Vec<Vec<i64>> = match (&input.answers, &input.choices, input.choice) {
        (Some(sets), _, _) => sets.clone(),
        (_, Some(list), _) if !list.is_empty() => vec![list.clone()],
        (_, _, Some(one)) => vec![vec![one]],
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    // Every question must be answered. A partial set would leave the agent
    // replaying digits into a screen that has already moved on.
    if sets.len() != questions.len() {
        return Err(StatusCode::BAD_REQUEST);
    }

    for (set, question) in sets.iter().zip(questions.iter()) {
        if set.is_empty() {
            return Err(StatusCode::BAD_REQUEST);
        }
        // Validated against THIS question's options, not the union across
        // questions: a number valid for question 2 may not exist in question 1,
        // and these digits are typed into a live terminal.
        if !set
            .iter()
            .all(|n| question.options.iter().any(|option| option.number == *n))
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        // Each question carries its own kind — a set can mix single and multi.
        let kind = question.kind.as_deref().unwrap_or("single");
        if kind != "multi" && set.len() != 1 {
            return Err(StatusCode::BAD_REQUEST);
        }
    }

    // Free text, if present: one per question, only where that question has an
    // Other option that was actually picked, and within the length bound.
    let texts: Vec<Option<String>> = match &input.texts {
        None => vec![None; questions.len()],
        Some(t) if t.len() == questions.len() => t.clone(),
        Some(_) => return Err(StatusCode::BAD_REQUEST),
    };
    for ((text, set), question) in texts.iter().zip(sets.iter()).zip(questions.iter()) {
        let Some(text) = text else { continue };
        if text.chars().count() > 2000 {
            return Err(StatusCode::BAD_REQUEST);
        }
        // The Other option is the one flagged is_other; its number must be in
        // this question's answer set, or there is no field the text belongs to.
        let other = question.options.iter().find(|o| o.is_other);
        match other {
            Some(o) if set.contains(&o.number) => {}
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    }

    let cancelled = input.cancel.unwrap_or(false);
    prompt.status = if cancelled {
        TaskflowPromptStatus::Cancelled
    } else {
        TaskflowPromptStatus::Answered
    };
    // `answer` keeps the first choice for display.
    prompt.answer = sets.first().and_then(|set| set.first()).copied();
    // A single-question prompt stays FLAT (`[2]`) so rows and readers written
    // before multi-question support keep working; a set is stored nested
    // (`[[2],[1,3]]`) so the agent can replay each question in order.
    prompt.answer_json = Some(
        if questions.len() == 1 {
            serde_json::to_string(&sets[0])
        } else {
            serde_json::to_string(&sets)
        }
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    prompt.answer_text_json = if texts.iter().any(Option::is_some) {
        Some(serde_json::to_string(&texts).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
    } else {
        None
    };
    prompt.answered_by = Some(ForeignKey::new(user_id));
    prompt.answered_at = Some(chrono::Utc::now());
    let saved = TaskflowAgentPrompt::objects()
        .save(prompt)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((StatusCode::OK, Json(saved)).into_response())
}

/// One option as stored in `options_json`.
#[derive(Debug, Deserialize)]
struct PromptOptionPayload {
    number: i64,
    // The hook writes this as camelCase `isOther`; rename so serde matches.
    #[serde(rename = "isOther", default)]
    is_other: bool,
}

/// The stored value of `TaskflowPromptStatus::Pending` (the column is text).
const PENDING_PROMPT: &str = "pending";

/// Mark every pending prompt on a session cancelled. Returns how many.
async fn cancel_pending_prompts(session_id: i64) -> Result<usize, StatusCode> {
    let pending = TaskflowAgentPrompt::objects()
        .filter(
            taskflow_agent_prompt::SESSION.eq(session_id)
                & taskflow_agent_prompt::STATUS.eq(PENDING_PROMPT),
        )
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let count = pending.len();
    for mut row in pending {
        row.status = TaskflowPromptStatus::Cancelled;
        let _ = TaskflowAgentPrompt::objects().save(row).await;
    }
    Ok(count)
}
