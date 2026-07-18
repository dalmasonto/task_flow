//! Test harness for the taskflow-agents plugin — the app's first one.
//!
//! Shared across test binaries; each uses a different subset of the helpers,
//! so unused-in-one-binary is expected, not dead code.
#![allow(dead_code)]
//!
//! `umbral-testing` already provides the two halves this needs: `boot()`
//! (one in-process app per test binary, backed by a throwaway SQLite
//! database that is never `backend.db`) and `TestClient` (drives the
//! plugin's `Router` in-process via `tower::oneshot`, so there is no
//! server to bind and no port to race on).
//!
//! What this module adds on top is the bit that is specific to this
//! endpoint: callers are *authenticated users*. `post_as(user_id, ..)`
//! mints a real `AuthToken` per seeded user and sends it as a bearer
//! token, so requests traverse the framework's genuine auth chain rather
//! than a stub. A test cannot accidentally assert against a fake identity.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use http::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use serde_json::Value;
use umbral::orm::ForeignKey;
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral::storage::{Storage, StorageError, StoredFile, set_storage};
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_testing::{TestClient, boot, seq};

/// An in-memory `Storage` backend for the test harness. `TaskflowMessageAttachment`
/// carries a `FileField`, so `App::build()`'s `field.storage_backend` system
/// check fails unless *some* plugin provides a backend — this is that plugin.
///
/// `store` keeps the bytes only long enough to hand back a unique key + size;
/// the tests assert on the returned key/size and the attachment row, never on
/// re-reading the blob, so a real filesystem write would only litter the crate
/// dir. `url(key)` returns `/media/<key>` — the exact shape production serves.
#[derive(Debug, Default)]
struct MemoryStorage;

#[umbral::storage::async_trait]
impl Storage for MemoryStorage {
    async fn store(
        &self,
        filename: &str,
        _content_type: &str,
        bytes: &[u8],
    ) -> Result<StoredFile, StorageError> {
        // A fresh, collision-resistant key per call, mirroring a real backend.
        let key = format!("{}-{}", seq(), filename);
        let url = format!("/media/{key}");
        Ok(StoredFile {
            key,
            url,
            size: bytes.len() as u64,
        })
    }
    async fn retrieve(&self, _key: &str) -> Result<Vec<u8>, StorageError> {
        Err(StorageError::NotFound)
    }
    async fn delete(&self, _key: &str) -> Result<(), StorageError> {
        Ok(())
    }
    fn url(&self, key: &str) -> String {
        format!("/media/{key}")
    }
}

/// Reports `provides_storage()` so the boot storage check passes, and registers
/// [`MemoryStorage`] in `on_ready` (where production backends register too).
struct MediaTestPlugin;

impl Plugin for MediaTestPlugin {
    fn name(&self) -> &'static str {
        "mem_media_test"
    }
    fn provides_storage(&self) -> bool {
        true
    }
    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        set_storage(Arc::new(MemoryStorage));
        Ok(())
    }
}

/// One part of a multipart request body: `(field_name, filename, content_type,
/// bytes)`. A file part carries a filename; a plain field passes `None`.
pub struct MultipartPart {
    pub field_name: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// Encode `parts` as a `multipart/form-data` body, returning the raw bytes and
/// the `Content-Type` header (with the boundary) to send alongside them.
pub fn encode_multipart(parts: &[MultipartPart]) -> (String, Vec<u8>) {
    let boundary = format!("----umbraltestboundary{}", seq());
    let mut body: Vec<u8> = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        let mut disp = format!("Content-Disposition: form-data; name=\"{}\"", part.field_name);
        if let Some(fname) = &part.filename {
            disp.push_str(&format!("; filename=\"{fname}\""));
        }
        body.extend_from_slice(disp.as_bytes());
        body.extend_from_slice(b"\r\n");
        if let Some(ct) = &part.content_type {
            body.extend_from_slice(format!("Content-Type: {ct}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(&part.bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (
        format!("multipart/form-data; boundary={boundary}"),
        body,
    )
}

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentSession, TaskflowAgentTerminalFrame, TaskflowChannelKind,
    TaskflowChannelMemberKind, TaskflowChannelReadCursor, TaskflowCredentialStatus,
    TaskflowMessagePriority, TaskflowMessageAttachment, taskflow_agent, taskflow_agent_channel,
    taskflow_agent_channel_member, taskflow_agent_credential, taskflow_agent_message,
    taskflow_agent_session, taskflow_agent_terminal_frame, taskflow_channel_read_cursor,
    taskflow_message_attachment,
};
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};
use taskflow_tasks::TaskflowTasksPlugin;

/// One round trip. Thin wrapper over `umbral_testing::TestResponse` that
/// exposes the shape the tests want (`u16` status, JSON body).
pub struct TestResponse {
    inner: umbral_testing::TestResponse,
}

impl TestResponse {
    pub fn status(&self) -> u16 {
        self.inner.status().as_u16()
    }

    /// Parse the body as JSON. Panics with the raw body on a parse error,
    /// which is what you want to read when a handler 500s.
    pub async fn json(&self) -> Value {
        self.inner.body_json()
    }
}

pub struct TestApp {
    client: TestClient,
    /// user id -> that user's plaintext bearer token.
    tokens: Mutex<HashMap<i64, String>>,
}

impl TestApp {
    pub async fn new() -> Self {
        // `boot` is idempotent (a process-wide OnceCell), so every test can
        // call it. The plugins register their own models, so the schema is
        // derived from the models themselves — no hand-written CREATE TABLE
        // to drift out of sync with `models.rs`.
        boot(|b| {
            b.plugin(AuthPlugin::<AuthUser>::default())
                .plugin(TaskflowProjectsPlugin)
                .plugin(TaskflowTasksPlugin)
                .plugin(TaskflowAgentsPlugin)
                // Required now that `TaskflowMessageAttachment` has a `FileField`:
                // the boot storage check fails without a registered backend.
                .plugin(MediaTestPlugin)
        })
        .await;

        Self {
            client: TestClient::new(taskflow_agents::urls::router()),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Create a real `AuthUser` and mint a real bearer token for it, so
    /// `post_as` authenticates through the framework's own auth chain.
    pub async fn create_user(&self) -> i64 {
        let n = seq();
        let user = AuthUser::objects()
            .create(AuthUser {
                id: 0,
                username: format!("user-{n}"),
                email: format!("user-{n}@example.test"),
                password_hash: "unused-tests-authenticate-by-token".to_string(),
                is_active: true,
                is_staff: false,
                is_superuser: false,
                date_joined: chrono::Utc::now(),
                last_login: None,
                email_verified_at: None,
            })
            .await
            .expect("create AuthUser");

        let (_, plaintext) = AuthToken::create_for(&user, "test")
            .await
            .expect("mint bearer token");
        self.tokens
            .lock()
            .expect("tokens poisoned")
            .insert(user.id, plaintext.0);

        user.id
    }

    pub async fn post_as(&self, user_id: i64, path: &str, body: Value) -> TestResponse {
        let token = self
            .tokens
            .lock()
            .expect("tokens poisoned")
            .get(&user_id)
            .cloned()
            .unwrap_or_else(|| panic!("no bearer token seeded for user {user_id}"));

        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
        );

        TestResponse {
            inner: self.client.post_json(path, &body).await,
        }
    }

    /// POST JSON with NO authentication header at all — for asserting an
    /// agent-gated route 401s a caller who presents no key. Sets no default
    /// header, so it must be the FIRST request on a fresh client (the client has
    /// no header-removal API; `set_default_header` only ever adds).
    pub async fn post_json_noauth(&self, path: &str, body: Value) -> TestResponse {
        TestResponse {
            inner: self.client.post_json(path, &body).await,
        }
    }

    /// POST JSON authenticated as an AGENT — sets `Authorization: Agent <key>`,
    /// the header `RequireAgent` reads. The counterpart of [`post_as`] for the
    /// agent-auth path.
    pub async fn post_as_agent(&self, key: &str, path: &str, body: Value) -> TestResponse {
        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Agent {key}")).expect("agent header"),
        );
        TestResponse {
            inner: self.client.post_json(path, &body).await,
        }
    }

    /// Revoke every credential belonging to `agent_id` (flip status to
    /// `Revoked`). Used to prove `RequireAgent` rejects a revoked key with 401.
    pub async fn revoke_agent_credentials(&self, agent_id: i64) {
        let creds = TaskflowAgentCredential::objects()
            .filter(taskflow_agent_credential::AGENT.eq(agent_id))
            .fetch()
            .await
            .expect("load credentials");
        for mut cred in creds {
            cred.status = TaskflowCredentialStatus::Revoked;
            TaskflowAgentCredential::objects()
                .save(cred)
                .await
                .expect("revoke credential");
        }
    }

    /// Add `agent_id` to `channel`'s roster (a `member_kind = agent` row), so the
    /// agent membership gate authorizes a post in a DM it was explicitly added to.
    pub async fn add_agent_to_channel_roster(&self, project: i64, channel: i64, agent_id: i64) {
        TaskflowAgentChannelMember::objects()
            .create(TaskflowAgentChannelMember {
                id: 0,
                project: ForeignKey::new(project),
                channel: ForeignKey::new(channel),
                member_kind: TaskflowChannelMemberKind::Agent,
                user: None,
                agent: Some(ForeignKey::new(agent_id)),
                display_name: format!("Agent {agent_id}"),
                role: "member".to_string(),
                joined_at: None,
            })
            .await
            .expect("create agent roster row");
    }

    /// POST a raw `multipart/form-data` body as `user_id`, with the given
    /// `content_type` (boundary included) — the multipart counterpart of
    /// [`post_as`]. Builds a real multipart request so the handler's own
    /// `parse_multipart` path is exercised end-to-end.
    pub async fn post_multipart_as(
        &self,
        user_id: i64,
        path: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> TestResponse {
        let token = self
            .tokens
            .lock()
            .expect("tokens poisoned")
            .get(&user_id)
            .cloned()
            .unwrap_or_else(|| panic!("no bearer token seeded for user {user_id}"));

        self.client.set_default_header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
        );
        self.client.set_default_header(
            CONTENT_TYPE,
            HeaderValue::from_str(content_type).expect("content-type header"),
        );

        TestResponse {
            inner: self.client.post(path, Body::from(body)).await,
        }
    }

    pub async fn count_attachments(&self, message: i64) -> i64 {
        TaskflowMessageAttachment::objects()
            .filter(taskflow_message_attachment::MESSAGE.eq(message))
            .count()
            .await
            .expect("count attachments")
    }

    pub async fn count_messages(&self, channel: i64) -> i64 {
        TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::CHANNEL.eq(channel))
            .count()
            .await
            .expect("count messages")
    }

    pub async fn count_channel_members(&self, channel: i64) -> i64 {
        TaskflowAgentChannelMember::objects()
            .filter(taskflow_agent_channel_member::CHANNEL.eq(channel))
            .count()
            .await
            .expect("count channel members")
    }

    pub async fn count_read_cursors(&self, channel: i64) -> i64 {
        TaskflowChannelReadCursor::objects()
            .filter(taskflow_channel_read_cursor::CHANNEL.eq(channel))
            .count()
            .await
            .expect("count read cursors")
    }

    /// Load an agent row (for asserting `status` / `last_seen_at` after a
    /// session op — there is no read endpoint for it).
    pub async fn agent(&self, agent_id: i64) -> TaskflowAgent {
        TaskflowAgent::objects()
            .filter(taskflow_agent::ID.eq(agent_id))
            .first()
            .await
            .expect("load agent")
            .expect("agent exists")
    }

    /// Load a session row by id.
    pub async fn session(&self, session_id: i64) -> TaskflowAgentSession {
        TaskflowAgentSession::objects()
            .filter(taskflow_agent_session::ID.eq(session_id))
            .first()
            .await
            .expect("load session")
            .expect("session exists")
    }

    /// Count terminal frames recorded for a session.
    pub async fn count_frames(&self, session_id: i64) -> i64 {
        TaskflowAgentTerminalFrame::objects()
            .filter(taskflow_agent_terminal_frame::SESSION.eq(session_id))
            .count()
            .await
            .expect("count frames")
    }

    pub async fn project_of_channel(&self, channel: i64) -> i64 {
        TaskflowAgentChannel::objects()
            .filter(taskflow_agent_channel::ID.eq(channel))
            .first()
            .await
            .expect("load channel")
            .expect("channel exists")
            .project
            .id()
    }
}

pub async fn seed_project() -> i64 {
    let n = seq();
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: format!("Project {n}"),
            slug: format!("project-{n}"),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn seed_channel(project: i64) -> i64 {
    seed_channel_of_kind(project, TaskflowChannelKind::Project).await
}

pub async fn seed_channel_of_kind(project: i64, kind: TaskflowChannelKind) -> i64 {
    let n = seq();
    TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project),
            title: format!("Channel {n}"),
            topic: None,
            kind,
            task: None,
            created_by_user: None,
            created_by_agent: None,
            archived: false,
            created_at: None,
        })
        .await
        .expect("create channel")
        .id
}

/// Seed a bare message directly in `channel` (bypassing the send endpoint), so a
/// test has a real message id to point a read cursor at — including one in a
/// FOREIGN channel for the 400 path. Returns the new message id.
pub async fn seed_message(project: i64, channel: i64) -> i64 {
    let n = seq();
    TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: None,
            sender_agent: None,
            sender_label: format!("Seeder {n}"),
            body_markdown: format!("seeded message {n}"),
            priority: TaskflowMessagePriority::Normal,
            client_nonce: None,
            created_at: None,
        })
        .await
        .expect("create message")
        .id
}

/// Seed a `TaskflowProjectMember` linking `user_id` to `project` with the given
/// status. Returns the member's `display_name` so a test can assert the derived
/// `sender_label` matches it.
async fn seed_project_member(
    project: i64,
    user_id: i64,
    status: TaskflowMembershipStatus,
) -> String {
    let display_name = format!("Project Member {user_id}");
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user_id}"),
            user: Some(ForeignKey::new(user_id)),
            display_name: display_name.clone(),
            email: None,
            role: TaskflowProjectRole::Developer,
            status,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create project member");
    display_name
}

/// A channel of `kind` plus a user who is a project member of that channel's
/// project (with the given membership `status`) but is NOT on the channel
/// roster. Returns `(channel, user, project_member_display_name)`.
///
/// This is the exact shape of the reported bug: joining via invite creates a
/// `TaskflowProjectMember` but never a `TaskflowAgentChannelMember`.
pub async fn seed_project_member_off_roster(
    app: &TestApp,
    kind: TaskflowChannelKind,
    status: TaskflowMembershipStatus,
) -> (i64, i64, String) {
    let project = seed_project().await;
    let channel = seed_channel_of_kind(project, kind).await;
    let user = app.create_user().await;
    let display_name = seed_project_member(project, user, status).await;
    (channel, user, display_name)
}

/// A channel plus a user who HAS joined it.
pub async fn seed_channel_with_member(app: &TestApp) -> (i64, i64) {
    let project = seed_project().await;
    let channel = seed_channel(project).await;
    let user = app.create_user().await;

    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user)),
            agent: None,
            display_name: format!("Member {user}"),
            role: "developer".to_string(),
            joined_at: None,
        })
        .await
        .expect("create channel member");

    (channel, user)
}

/// A channel plus an authenticated user who has NOT joined it. The user is
/// a real, valid, logged-in caller — the only thing they lack is membership,
/// which is precisely what the 403 must be caused by.
pub async fn seed_channel_without_member(app: &TestApp) -> (i64, i64) {
    let project = seed_project().await;
    let channel = seed_channel(project).await;
    let outsider = app.create_user().await;
    (channel, outsider)
}

// ---------------------------------------------------------------------------
// Helpers for the add-channel-member endpoint. These give a test fine-grained
// control over the (project, channel, project-membership, roster) graph, which
// the higher-level `seed_*` helpers above bundle together.
// ---------------------------------------------------------------------------

/// A bare project of the given channel `kind`: returns `(project, channel)` with
/// no members and no roster rows yet.
pub async fn new_project_and_channel(kind: TaskflowChannelKind) -> (i64, i64) {
    let project = seed_project().await;
    let channel = seed_channel_of_kind(project, kind).await;
    (project, channel)
}

/// Make `user` an ACTIVE `TaskflowProjectMember` of `project`; returns the
/// project-member `display_name` so a test can assert the roster row copies it.
pub async fn make_active_project_member(project: i64, user: i64) -> String {
    seed_project_member(project, user, TaskflowMembershipStatus::Active).await
}

/// Put `user` on `channel`'s roster directly (bypassing the endpoint). Used to
/// stand up a DM the caller is already in, and to pre-seed the duplicate for the
/// unique-constraint test.
pub async fn add_channel_roster_row(project: i64, channel: i64, user: i64) {
    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user)),
            agent: None,
            display_name: format!("Roster {user}"),
            role: "member".to_string(),
            joined_at: None,
        })
        .await
        .expect("create channel roster row");
}

/// Attempt a raw duplicate roster insert for `(channel, user)` WITHOUT going
/// through the endpoint. Returns whether the DB accepted it — the unique index
/// on `(channel, user)` must make the second insert fail.
pub async fn try_insert_channel_roster_row(project: i64, channel: i64, user: i64) -> bool {
    TaskflowAgentChannelMember::objects()
        .create(TaskflowAgentChannelMember {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            member_kind: TaskflowChannelMemberKind::User,
            user: Some(ForeignKey::new(user)),
            agent: None,
            display_name: format!("Dup {user}"),
            role: "member".to_string(),
            joined_at: None,
        })
        .await
        .is_ok()
}
