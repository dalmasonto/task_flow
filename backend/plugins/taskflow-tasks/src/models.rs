//! Models for the `taskflow-tasks` plugin.
//!
//! These mirror the v1 concepts: tasks have Markdown descriptions/notes,
//! sessions track focused work, and activity is the single history stream.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::{Choices, FileField, ForeignKey};
use umbral_auth::AuthUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowTaskStatus {
    NotStarted,
    InProgress,
    Paused,
    Blocked,
    PartialDone,
    Done,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowTaskPriority {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowTaskRelationKind {
    Blocks,
    RelatedTo,
    Duplicates,
    ParentChild,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowActorKind {
    User,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowSessionState {
    Running,
    Paused,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowTask {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(string, max_length = 220)]
    pub title: String,
    #[umbral(string, max_length = 12000, widget = "textarea")]
    pub description_markdown: String,
    #[umbral(string, max_length = 12000, widget = "textarea")]
    pub notes_markdown: Option<String>,
    #[umbral(choices, default = "not_started")]
    pub status: TaskflowTaskStatus,
    #[umbral(choices, default = "normal")]
    pub priority: TaskflowTaskPriority,
    #[umbral(default = "0")]
    pub sort_order: i64,
    #[umbral(on_delete = "set_null")]
    pub created_by: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub assigned_user: Option<ForeignKey<AuthUser>>,
    /// Agent id from the taskflow-agents plugin. Kept as an integer to avoid a
    /// dependency cycle while still letting the UI show agent ownership.
    pub assigned_agent_id: Option<i64>,
    /// What a human must approve before this task can ship. Free text/markdown.
    #[umbral(string, max_length = 4000, widget = "textarea")]
    pub review_gate: Option<String>,
    /// Estimate in minutes. The dialog takes free text and parses a leading int.
    pub estimate_minutes: Option<i64>,
    /// Operator if a human (the executor, distinct from the owner).
    #[umbral(on_delete = "set_null")]
    pub operator_user: Option<ForeignKey<AuthUser>>,
    /// Operator if an agent. Bare i64 for the same cycle reason as
    /// `assigned_agent_id` — taskflow-tasks cannot depend on taskflow-agents.
    pub operator_agent_id: Option<i64>,
    /// Creator if an agent (human creators use `created_by`). Bare i64, same
    /// cycle reason. Set only by the agent create-handler, never a client.
    pub created_by_agent_id: Option<i64>,
    #[umbral(string, max_length = 120)]
    pub assignee_label: Option<String>,
    pub due_at: Option<DateTime<Utc>>,
    /// GitHub issue number once this task is published. `None` = not published.
    pub github_issue_number: Option<i64>,
    /// Convenience: full issue URL, so the UI links out without rebuilding it.
    #[umbral(string, max_length = 400)]
    pub github_issue_url: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["source_task", "target_task", "kind"]])]
pub struct TaskflowTaskRelation {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub source_task: ForeignKey<TaskflowTask>,
    #[umbral(on_delete = "cascade")]
    pub target_task: ForeignKey<TaskflowTask>,
    #[umbral(choices, default = "related_to")]
    pub kind: TaskflowTaskRelationKind,
    #[umbral(string, max_length = 2000, widget = "textarea")]
    pub detail_markdown: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowTaskActivity {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub task: Option<ForeignKey<TaskflowTask>>,
    #[umbral(choices, default = "system")]
    pub actor_kind: TaskflowActorKind,
    #[umbral(on_delete = "set_null")]
    pub actor_user: Option<ForeignKey<AuthUser>>,
    pub actor_agent_id: Option<i64>,
    #[umbral(string, max_length = 160)]
    pub actor_label: String,
    #[umbral(string, max_length = 120)]
    pub action: String,
    #[umbral(string, max_length = 12000, widget = "textarea")]
    pub body_markdown: Option<String>,
    /// A tool's input, as JSON. NOT length-capped by design: capping the whole
    /// payload discards the fields that identify a call in order to make room
    /// for a body nobody needed in full. The producer bounds the single
    /// bulk-carrying field per tool instead (mcp/hooks/metadata.mjs), so this
    /// stays complete and parseable at whatever length it naturally is.
    ///
    /// The bound here exists only so a runaway or hostile client cannot write an
    /// unbounded blob; it is far above anything the producer can emit.
    #[umbral(string, max_length = 1000000, widget = "textarea")]
    pub metadata_json: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowTaskSession {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub task: ForeignKey<TaskflowTask>,
    #[umbral(choices, default = "running")]
    pub state: TaskflowSessionState,
    #[umbral(choices, default = "user")]
    pub actor_kind: TaskflowActorKind,
    #[umbral(on_delete = "set_null")]
    pub actor_user: Option<ForeignKey<AuthUser>>,
    pub actor_agent_id: Option<i64>,
    #[umbral(string, max_length = 160)]
    pub actor_label: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_seconds: Option<i64>,
    #[umbral(string, max_length = 8000, widget = "textarea")]
    pub summary_markdown: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// A file (usually an image) attached to a task, so a human can give the agent
/// visual/context material the way chat attachments do. The bytes live in the
/// ambient storage backend; this row holds only the key (via `FileField`) plus
/// display metadata. `/media/<key>` serves the file, and the agent can pull it
/// with `download_attachment` exactly like a message attachment.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowTaskAttachment {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub task: ForeignKey<TaskflowTask>,
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
