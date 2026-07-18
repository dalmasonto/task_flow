//! Models for the `taskflow-agents` plugin.
//!
//! The chat model is group-first: users and agents join channels, so direct
//! messages, project rooms, and task rooms all use the same interface.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_projects::models::TaskflowProject;
use taskflow_tasks::models::TaskflowTask;
use umbral::orm::{Choices, FileField, ForeignKey};
use umbral_auth::AuthUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowAgentStatus {
    Offline,
    Connected,
    Idle,
    Busy,
    Blocked,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowCredentialStatus {
    Active,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowAgentSessionStatus {
    Connected,
    Disconnected,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowChannelKind {
    Project,
    Task,
    Direct,
    Incident,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowChannelMemberKind {
    User,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowMessagePriority {
    Normal,
    Important,
    Urgent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowTerminalStream {
    Stdout,
    Stderr,
    Stdin,
    System,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowAgent {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(string, max_length = 120)]
    pub display_name: String,
    /// Stable agent identifier read from `.taskflow.json` or a future auth flow.
    #[umbral(string, max_length = 160, unique)]
    pub identifier: String,
    #[umbral(string, max_length = 180)]
    pub fingerprint: Option<String>,
    #[umbral(string, max_length = 500)]
    pub project_root: Option<String>,
    #[umbral(string, max_length = 500)]
    pub taskflow_file_path: Option<String>,
    #[umbral(string, max_length = 120)]
    pub runtime: Option<String>,
    #[umbral(string, max_length = 80)]
    pub version: Option<String>,
    #[umbral(choices, default = "offline")]
    pub status: TaskflowAgentStatus,
    #[umbral(on_delete = "set_null")]
    pub linked_by: Option<ForeignKey<AuthUser>>,
    #[umbral(string, max_length = 160)]
    pub linked_user_label: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowAgentCredential {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(on_delete = "set_null")]
    pub issued_by: Option<ForeignKey<AuthUser>>,
    #[umbral(string, max_length = 120)]
    pub name: String,
    /// A non-secret prefix shown in the UI so a user can identify the key.
    #[umbral(string, max_length = 40, unique)]
    pub key_prefix: String,
    /// Store a hash or KMS reference only; never the raw key.
    #[umbral(string, max_length = 260)]
    pub key_hash: String,
    #[umbral(choices, default = "active")]
    pub status: TaskflowCredentialStatus,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowAgentSession {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub agent: ForeignKey<TaskflowAgent>,
    #[umbral(on_delete = "set_null")]
    pub connected_by: Option<ForeignKey<AuthUser>>,
    #[umbral(string, max_length = 180, unique)]
    pub session_identifier: String,
    #[umbral(string, max_length = 120)]
    pub host: Option<String>,
    pub pid: Option<i64>,
    #[umbral(string, max_length = 500)]
    pub cwd: Option<String>,
    #[umbral(string, max_length = 80)]
    pub transport: Option<String>,
    #[umbral(choices, default = "connected")]
    pub status: TaskflowAgentSessionStatus,
    pub connected_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub disconnected_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowAgentChannel {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(string, max_length = 180)]
    pub title: String,
    #[umbral(string, max_length = 500)]
    pub topic: Option<String>,
    #[umbral(choices, default = "project")]
    pub kind: TaskflowChannelKind,
    #[umbral(on_delete = "set_null")]
    pub task: Option<ForeignKey<TaskflowTask>>,
    #[umbral(on_delete = "set_null")]
    pub created_by_user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub created_by_agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(default = "false")]
    pub archived: bool,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["channel", "user"]])]
pub struct TaskflowAgentChannelMember {
    pub id: i64,
    /// Denormalized from `channel.project` so realtime can route membership
    /// events to a per-project group. `TaskflowAgentMessage` denormalizes
    /// `project` for the same reason.
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub channel: ForeignKey<TaskflowAgentChannel>,
    #[umbral(choices, default = "user")]
    pub member_kind: TaskflowChannelMemberKind,
    #[umbral(on_delete = "set_null")]
    pub user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(string, max_length = 160)]
    pub display_name: String,
    #[umbral(string, max_length = 80)]
    pub role: String,
    #[umbral(noedit, auto_now_add)]
    pub joined_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowAgentMessage {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub channel: ForeignKey<TaskflowAgentChannel>,
    #[umbral(on_delete = "set_null")]
    pub task: Option<ForeignKey<TaskflowTask>>,
    #[umbral(choices, default = "user")]
    pub sender_kind: TaskflowChannelMemberKind,
    #[umbral(on_delete = "set_null")]
    pub sender_user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub sender_agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(string, max_length = 160)]
    pub sender_label: String,
    #[umbral(string, max_length = 20000, widget = "textarea")]
    pub body_markdown: String,
    #[umbral(choices, default = "normal")]
    pub priority: TaskflowMessagePriority,
    /// Client-generated correlation id. The sender renders its bubble
    /// optimistically keyed by this value, then reconciles whichever arrives
    /// first — the SSE echo or the POST response. Also the idempotency key:
    /// re-posting the same nonce to the same channel returns the stored row.
    #[umbral(string, max_length = 64)]
    pub client_nonce: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// A file attached to a chat message. One row per uploaded file; the file
/// itself lives in the ambient storage backend (a `FileField` holds only the
/// storage key). `project` is denormalized from `message.channel.project` for
/// realtime routing and read scoping, exactly like `TaskflowAgentMessage`.
///
/// Created only through the trusted send endpoint (`POST
/// /api/taskflow/agents/messages`), never client REST — see
/// `backend::rest::READ_ONLY_PROJECT_SCOPED_TABLES`.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowMessageAttachment {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub message: ForeignKey<TaskflowAgentMessage>,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// The stored file — serializes as the bare storage key; `.url()` resolves
    /// to `/media/<key>`.
    pub file: FileField,
    /// Original filename the client sent.
    #[umbral(string, max_length = 260)]
    pub name: String,
    /// MIME type identified at save time. The frontend derives image-vs-file
    /// from this (`image/` prefix → inline image).
    #[umbral(string, max_length = 160)]
    pub content_type: String,
    pub size_bytes: i64,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// Tracks how far a single member (a user OR an agent) has read in a channel —
/// the "read receipt" / unread-cursor primitive. One row per (channel, member):
/// the `unique_together` pairs enforce it at the DB layer, and the read
/// endpoints upsert forward-only (a cursor never moves backwards).
///
/// `project` is denormalized from `channel.project` for realtime routing and
/// read scoping, exactly like `TaskflowAgentMessage` / `TaskflowAgentChannelMember`.
/// Exactly one of `member_user` / `member_agent` is set, matching `member_kind`.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["channel", "member_user"], ["channel", "member_agent"]])]
pub struct TaskflowChannelReadCursor {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub channel: ForeignKey<TaskflowAgentChannel>,
    #[umbral(choices, default = "user")]
    pub member_kind: TaskflowChannelMemberKind,
    #[umbral(on_delete = "set_null")]
    pub member_user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub member_agent: Option<ForeignKey<TaskflowAgent>>,
    /// The furthest message this member has read. Only ever advanced forward.
    #[umbral(on_delete = "set_null")]
    pub last_read_message: Option<ForeignKey<TaskflowAgentMessage>>,
    /// When the cursor last advanced. Set explicitly on every write (not
    /// `auto_now`) so the value is the read time, independent of row creation.
    pub last_read_at: DateTime<Utc>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowAgentTerminalFrame {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub agent: ForeignKey<TaskflowAgent>,
    #[umbral(on_delete = "set_null")]
    pub session: Option<ForeignKey<TaskflowAgentSession>>,
    #[umbral(on_delete = "set_null")]
    pub task: Option<ForeignKey<TaskflowTask>>,
    #[umbral(choices, default = "stdout")]
    pub stream: TaskflowTerminalStream,
    #[umbral(default = "0")]
    pub sequence: i64,
    #[umbral(string, max_length = 20000, widget = "textarea")]
    pub content: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
