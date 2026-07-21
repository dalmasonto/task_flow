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

/// #29: one directed target of a chat message — an agent (pane delivery) or a
/// user (mention). Serialized as a JSON array in `TaskflowAgentMessage.targets`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MessageTarget {
    /// "agent" or "user".
    pub kind: String,
    pub id: i64,
}

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
    /// #42: a user-created room with an explicit member list (agents-only,
    /// PMs-only, …). Membership-scoped like Direct — only its roster sees it.
    Group,
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
    /// A complete screen capture that REPLACES the view rather than appending to
    /// it. Needed for full-screen TUI agents: a program on tmux's alternate
    /// screen buffer has no scrollback (`history_size` stays flat), so there is
    /// no stream of new output to append — the only observable state is the
    /// current screen, redrawn in place. Readers render the latest snapshot and
    /// ignore earlier ones.
    Snapshot,
}

/// A reviewer's verdict on a task. `approved` moves the task to `done`;
/// `changes_requested` moves it back to `in_progress` (see the review endpoints
/// in `views.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowReviewDecision {
    Approved,
    ChangesRequested,
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
    /// #29: a directed group message names the one agent whose pane should get
    /// it. `None` broadcasts to every agent on the channel (the default). Only
    /// gates PANE delivery via the MCP — the message is still visible in the
    /// channel to everyone.
    #[umbral(on_delete = "set_null")]
    pub target_agent: Option<ForeignKey<TaskflowAgent>>,
    /// #29: the full set of directed targets — agents (pane delivery) and users
    /// (mention/attribution). A JSON array of `{kind,id}` objects. Empty/None
    /// broadcasts to every agent, exactly like `target_agent = None`. This
    /// supersedes the single `target_agent`, which is kept populated (the first
    /// agent target) for back-compat with rows/readers that predate this field.
    #[umbral(string, max_length = 4000)]
    pub targets: Option<String>,
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
    /// Denormalized from `message.channel`, and the column the REST scope
    /// filters on.
    ///
    /// Attachments must follow their CHANNEL, not their project: this row
    /// carries the storage key and `/media/<key>` serves the file, so scoping it
    /// by `project` made every DM's files readable by every project member.
    /// `ScopeDecision::RestrictIn` compiles to a plain column predicate and
    /// cannot traverse `message__channel`, so the channel has to live here.
    ///
    /// Nullable only because SQLite cannot add a NOT NULL column to a populated
    /// table; the backfill migration fills every existing row. A NULL is denied
    /// by the scope rather than allowed — `RestrictIn` never matches it — so the
    /// failure mode is an invisible attachment, not a leaked one.
    #[umbral(on_delete = "cascade")]
    pub channel: Option<ForeignKey<TaskflowAgentChannel>>,
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
// #46: the append path runs `WHERE session = ? ORDER BY sequence DESC LIMIT 1`
// on every frame — a per-append scan that degrades as a transcript lengthens.
// A (session, sequence) index turns it into an index seek.
#[umbral(indexes = [["session", "sequence"]])]
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


/// How a pending prompt was resolved. `pending` is the only state a human can
/// act on; the rest are terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowPromptStatus {
    Pending,
    Answered,
    /// The prompt left the agent's screen before anyone answered it — the agent
    /// was answered locally, timed out, or cancelled.
    Cancelled,
}

/// A question an agent's terminal is BLOCKED on — a Claude Code permission
/// prompt ("Do you want to proceed? 1. Yes 2. No").
///
/// Detected by parsing the mirrored screen rather than reported by the agent
/// itself: the agent is stopped waiting for a keypress at that moment and cannot
/// tell anyone. Storing it as a row is what lets a human answer from the
/// dashboard, and what makes "the agent is stuck waiting" visible instead of
/// something you discover by looking at its terminal.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowAgentPrompt {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub agent: ForeignKey<TaskflowAgent>,
    #[umbral(on_delete = "cascade")]
    pub session: ForeignKey<TaskflowAgentSession>,
    /// Who the question is for (#6): the user of the agent's current DM — the
    /// person who most recently messaged it directly — derived server-side when
    /// the prompt is reported. `None` when the agent has no DM history; the
    /// dashboard then shows the prompt to every project member (the old default).
    #[umbral(on_delete = "set_null")]
    pub target_user: Option<ForeignKey<AuthUser>>,
    /// The question as it appears on screen.
    #[umbral(string, max_length = 2000)]
    pub question: String,
    /// The questions and their options, as JSON. A child table would be more
    /// normal, but these are written once, read whole, and never queried.
    ///
    /// Two shapes, both readable: a bare option list (one question, how rows
    /// were written before multi-question support) or a list of
    /// `{ question, kind, options }`. `AskUserQuestion` accepts several
    /// questions per call, and four options each carry a label plus a
    /// description — 8000 chars overflowed on three questions, and a truncated
    /// prompt is an unanswerable one.
    #[umbral(string, max_length = 40000, widget = "textarea")]
    pub options_json: String,
    /// `single` (press one number) or `multi` (toggle several, then confirm).
    /// A multi prompt must NOT be answered by sending one digit.
    #[umbral(string, max_length = 16, default = "single")]
    pub kind: String,
    /// Identity of the QUESTION, so a redraw (cursor moved) updates this row
    /// instead of creating another.
    #[umbral(string, max_length = 300)]
    pub fingerprint: String,
    #[umbral(choices, default = "pending")]
    pub status: TaskflowPromptStatus,
    /// The option number a human chose (the first one, for display). Null until
    /// answered.
    pub answer: Option<i64>,
    /// The chosen numbers as JSON: flat (`[1,3]`) for a single question, nested
    /// (`[[2],[1,3]]`) for a set — one list per question, in the order asked.
    /// The agent needs the whole thing to reproduce the keystrokes.
    #[umbral(string, max_length = 2000)]
    pub answer_json: Option<String>,
    /// Free-text "Other" answers as JSON: one entry per question, `null` where
    /// the question has no Other pick. e.g. `["my own take"]` or `[null,"x"]`.
    /// A validation bound, not a column type — no migration.
    #[umbral(string, max_length = 40000)]
    pub answer_text_json: Option<String>,
    #[umbral(on_delete = "set_null")]
    pub answered_by: Option<ForeignKey<AuthUser>>,
    pub answered_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// A review of a task by a human OR an agent reviewer. Lives in this plugin (not
/// `taskflow-tasks`) so it can FK BOTH `TaskflowTask` and `TaskflowAgent` — the
/// tasks plugin does not depend on this one, so the reverse would be a cycle.
///
/// Exactly one of `reviewer_user` / `reviewer_agent` is set, matching
/// `reviewer_kind`. `project` is denormalized from the task for realtime routing
/// and read scoping, exactly like the chat tables. Created only through the
/// trusted review endpoints (`POST /api/taskflow/tasks/{task}/review` and its
/// agent variant), never client REST — see
/// `backend::rest::READ_ONLY_PROJECT_SCOPED_TABLES`.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowTaskReview {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub task: ForeignKey<TaskflowTask>,
    #[umbral(choices, default = "user")]
    pub reviewer_kind: TaskflowChannelMemberKind,
    #[umbral(on_delete = "set_null")]
    pub reviewer_user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub reviewer_agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(string, max_length = 160)]
    pub reviewer_label: String,
    #[umbral(choices, default = "approved")]
    pub decision: TaskflowReviewDecision,
    #[umbral(string, max_length = 12000, widget = "textarea")]
    pub body_markdown: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// A single key a human sent to an agent's terminal from the dashboard. The
/// agent's MCP mirror listens on the project's `terminal_inputs` realtime group
/// and types the key into its tmux pane (see mcp/src/events.ts `onTerminalKey`).
/// Write-once and never queried — a short-lived signal, like a keystroke itself.
/// `agent` is projected on the realtime event so each agent's mirror can tell
/// whether a broadcast key is meant for it.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowTerminalInput {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub agent: ForeignKey<TaskflowAgent>,
    /// One tmux key NAME — a digit or a named navigation key. Validated against
    /// an allowlist at the endpoint; never a literal string or a control combo.
    #[umbral(string, max_length = 16)]
    pub keys: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// #43: a short-lived, single-use ticket for the realtime SSE handshake.
///
/// `EventSource` can't send an `Authorization` header, and #41's workaround put
/// the long-lived bearer token in the SSE URL. Instead the client mints one of
/// these (authenticated by the normal token), then connects with the ticket —
/// so only a seconds-long one-shot ever appears in a URL/log. Only the HASH of
/// the ticket is stored, never the plaintext.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowRealtimeTicket {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub user: ForeignKey<AuthUser>,
    /// `umbral_auth::digest_token(plaintext)` — the SHA-256/base64 digest, never
    /// the ticket itself. Looked up on connect.
    #[umbral(string, max_length = 128)]
    pub token_hash: String,
    /// After this instant the ticket is dead even if unused.
    pub expires_at: DateTime<Utc>,
    /// Set the first time the ticket is redeemed — single-use, so a replay fails.
    pub used_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
