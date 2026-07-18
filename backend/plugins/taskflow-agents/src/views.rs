//! HTTP handlers for the `taskflow-agents` plugin.

use axum::body::Bytes;
use serde::Deserialize;
use serde_json::json;
use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use umbral::orm::{FileField, ForeignKey};
use umbral::storage::storage_opt;
use umbral::web::multipart::{FilePart, is_multipart, parse_multipart};
use umbral::web::{HeaderMap, IntoResponse, Json, Path, Response, StatusCode, header};
use umbral_auth::{AuthUser, RequireAuth, auth_user};
use uuid::Uuid;

use crate::agent_auth::{RequireAgent, hash_key};
use crate::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentStatus, TaskflowChannelKind, TaskflowChannelMemberKind,
    TaskflowChannelReadCursor, TaskflowCredentialStatus, TaskflowMessageAttachment,
    TaskflowMessagePriority, taskflow_agent, taskflow_agent_channel, taskflow_agent_channel_member,
    taskflow_agent_message, taskflow_channel_read_cursor, taskflow_message_attachment,
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
}

/// Serialize a message plus its attachments into the endpoint's response body.
///
/// The message's own fields are emitted exactly as the JSON path always
/// returned them (so the frontend's optimistic reconcile keeps working), with
/// an `attachments` array appended. Each attachment carries the resolved `url`
/// (`FileField::url()` → `/media/<key>`) so the sender can render it
/// immediately without waiting for the SSE echo. Text-only sends emit
/// `attachments: []`.
fn message_response(
    message: &TaskflowAgentMessage,
    attachments: &[TaskflowMessageAttachment],
) -> Result<Response, StatusCode> {
    let mut value =
        serde_json::to_value(message).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items: Vec<serde_json::Value> = attachments
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "message": a.message.id(),
                "project": a.project.id(),
                // Both `file` (the storage key, matching the model/realtime
                // representation) and the resolved `url`, so the client can key
                // off `file` uniformly regardless of which path delivered the row.
                "file": a.file.key(),
                "url": a.file.url(),
                "name": a.name,
                "content_type": a.content_type,
                "size_bytes": a.size_bytes,
                "created_at": a.created_at,
            })
        })
        .collect();
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("attachments".to_string(), json!(items));
    }
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

        // An unrecognised priority string is dropped, not rejected — the create
        // below defaults it to `Normal`, same as an absent JSON `priority`.
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
        // JSON path: preserve the original behaviour exactly. A malformed body
        // is a 400 (the old `Json` extractor rejected with a 4xx too).
        let input: SendMessageInput =
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
/// `sender_label = <display_name>`. JSON only — agent sends carry no
/// attachments in Stage 1.
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
    Json(input): Json<AgentSendMessageInput>,
) -> Result<Response, StatusCode> {
    let body = input.body_markdown.trim();
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(input.channel))
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
            sender_label: agent.display_name.clone(),
            body_markdown: body.to_string(),
            priority: input.priority.unwrap_or(TaskflowMessagePriority::Normal),
            client_nonce: input.client_nonce.clone(),
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    message_response(&message, &[])
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
