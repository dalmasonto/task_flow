//! Models for the `taskflow-tasks` plugin.
//!
//! These mirror the v1 concepts: tasks have Markdown descriptions/notes,
//! sessions track focused work, and activity is the single history stream.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::{Choices, ForeignKey};
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
    #[umbral(string, max_length = 120)]
    pub assignee_label: Option<String>,
    pub due_at: Option<DateTime<Utc>>,
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
    /// Raised from 8000: the hook now records a tool's FULL input, and 8000 was
    /// clipping real payloads. Truncation still exists as a backstop but is
    /// structural (see hooks/metadata.mjs) — what lands here always parses.
    #[umbral(string, max_length = 32000, widget = "textarea")]
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
