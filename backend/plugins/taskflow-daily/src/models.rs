//! Models for `taskflow-daily` (#1118, v3 group 6): the daily update.
//!
//! Both tables are written ONLY by this plugin's endpoints and its sweep;
//! auto-REST serves them read-only and project-scoped.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_agents::models::{TaskflowAgent, TaskflowAgentChannel};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::{Choices, ForeignKey};
use umbral_auth::AuthUser;

/// When and by whom a project's daily update is drafted, and where it posts.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project"]])]
pub struct TaskflowDailyUpdateSettings {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(default = "false")]
    pub enabled: bool,
    /// "HH:MM", 24-hour, in `timezone`.
    #[umbral(string, max_length = 5)]
    pub local_time: String,
    /// IANA name ("Africa/Nairobi").
    #[umbral(string, max_length = 64)]
    pub timezone: String,
    #[umbral(on_delete = "set_null")]
    pub drafting_agent: Option<ForeignKey<TaskflowAgent>>,
    /// A project-wide room (kind project, not the design room, not archived).
    /// NULL = the project's public room.
    #[umbral(on_delete = "set_null")]
    pub post_channel: Option<ForeignKey<TaskflowAgentChannel>>,
    #[umbral(string, max_length = 160)]
    pub updated_by_label: String,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowDailyUpdateStatus {
    Draft,
    Posted,
    Skipped,
}

/// One day's update. Created as a server-written draft (never empty, never
/// invented), improved by the drafting agent, edited and posted by a person.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project", "date"]], indexes = [["project", "id"]])]
pub struct TaskflowDailyUpdate {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// The local date, "YYYY-MM-DD".
    #[umbral(string, max_length = 10)]
    pub date: String,
    #[umbral(choices, default = "draft")]
    pub status: TaskflowDailyUpdateStatus,
    #[umbral(string, max_length = 12000, widget = "textarea")]
    pub body_markdown: String,
    #[umbral(default = "1")]
    pub version: i64,
    pub window_start: DateTime<Utc>,
    pub window_end: DateTime<Utc>,
    pub src_activity: i64,
    pub src_task_changes: i64,
    pub src_reviews: i64,
    pub src_pull_requests: i64,
    #[umbral(string, max_length = 160)]
    pub drafted_by_label: String,
    /// True while the text is the server's own (no agent or person wrote it).
    #[umbral(default = "true")]
    pub server_drafted: bool,
    /// Person edits; an agent may not overwrite a draft a person has edited.
    #[umbral(default = "0")]
    pub edit_count: i64,
    pub posted_message: Option<i64>,
    #[umbral(on_delete = "set_null")]
    pub posted_by: Option<ForeignKey<AuthUser>>,
    pub posted_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}
