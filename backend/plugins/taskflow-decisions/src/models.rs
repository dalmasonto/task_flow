//! Models for the `taskflow-decisions` plugin (#1094, from #886 §3.1).
//!
//! A decision is a question that blocks work: options, an optional
//! recommendation, and — once a human rules — a ruling on record. Agents check
//! `is_ruled` before they act instead of digging rulings out of chat.
//!
//! **Every table here is written ONLY by this plugin's endpoints.** Auto-REST
//! serves them read-only and project-scoped (`backend/src/rest.rs`), so a client
//! cannot forge a ruling, a recommendation or an author. Every row carries a
//! `project` FK — denormalized on the child tables — because REST row scope is
//! a plain column predicate and cannot reach through `decision__project`.
//!
//! **"Blocked" is derived, not stored.** A task is blocked on a decision while a
//! `TaskflowDecisionTask` row links it to a decision whose status is `open`.
//! Nothing sets or clears a task status, so nothing can forget to.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_agents::models::{TaskflowAgent, TaskflowAgentChannel};
use taskflow_projects::models::TaskflowProject;
use taskflow_tasks::models::TaskflowTask;
use umbral::orm::{Choices, ForeignKey};
use umbral_auth::AuthUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices)]
#[choices(rename_all = "snake_case")]
pub enum TaskflowDecisionStatus {
    /// Waiting on a ruling. Linked tasks are blocked.
    Open,
    /// A human ruled. Permanent: a ruling is never edited, only superseded.
    Ruled,
    /// Replaced by `superseded_by`. Its task links moved to the replacement.
    Superseded,
}

/// The decision itself. `key` is the stable slug agents ask about
/// (`is_ruled("trigger-max-delay")`), unique per project.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(
    unique_together = [["project", "key"]],
    indexes = [["project", "status", "id"]]
)]
pub struct TaskflowDecision {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(string, max_length = 60)]
    pub key: String,
    #[umbral(string, max_length = 300)]
    pub question: String,
    #[umbral(string, max_length = 12000, widget = "textarea")]
    pub context_markdown: Option<String>,
    #[umbral(choices, default = "open")]
    pub status: TaskflowDecisionStatus,
    /// Who asked: a user OR an agent (exactly one is set).
    #[umbral(on_delete = "set_null")]
    pub asked_by_user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub asked_by_agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(string, max_length = 160)]
    pub asked_by_label: String,
    /// The one human who must rule, when named. Null = any active member.
    #[umbral(on_delete = "set_null")]
    pub ruler_user: Option<ForeignKey<AuthUser>>,
    /// Where the question was raised; the ruling notice is posted here so the
    /// asking agent gets it in its pane. Null = the project's public room.
    #[umbral(on_delete = "set_null")]
    pub channel: Option<ForeignKey<TaskflowAgentChannel>>,
    /// Option id (bare, checked server-side to belong to THIS decision).
    pub ruled_option_id: Option<i64>,
    #[umbral(string, max_length = 4000, widget = "textarea")]
    pub ruling_note: Option<String>,
    /// Rulings are human-only, so the ruler is always a user.
    #[umbral(on_delete = "set_null")]
    pub ruled_by_user: Option<ForeignKey<AuthUser>>,
    #[umbral(string, max_length = 160)]
    pub ruled_by_label: Option<String>,
    pub ruled_at: Option<DateTime<Utc>>,
    /// The decision that replaced this one. Bare id: a self-referencing FK buys
    /// nothing here, and a reader that finds it gone simply shows no link.
    pub superseded_by_id: Option<i64>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    /// Set by this plugin's endpoints on every write (repo convention).
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(indexes = [["decision", "sort_order", "id"]])]
pub struct TaskflowDecisionOption {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub decision: ForeignKey<TaskflowDecision>,
    #[umbral(string, max_length = 200)]
    pub label: String,
    /// The one-line "why" under the option.
    #[umbral(string, max_length = 2000, widget = "textarea")]
    pub detail: Option<String>,
    #[umbral(default = "0")]
    pub sort_order: i64,
    /// Who recommends this option (user or agent). At most one option per
    /// decision carries a recommendation; recommending another moves it.
    #[umbral(on_delete = "set_null")]
    pub recommended_by_user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub recommended_by_agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(string, max_length = 160)]
    pub recommended_by_label: Option<String>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// decision → task: "this task is blocked by this decision while it is open".
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["decision", "task"]], indexes = [["task", "decision"]])]
pub struct TaskflowDecisionTask {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub decision: ForeignKey<TaskflowDecision>,
    #[umbral(on_delete = "cascade")]
    pub task: ForeignKey<TaskflowTask>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// The design's "Discussion" section.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(indexes = [["decision", "id"]])]
pub struct TaskflowDecisionComment {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(on_delete = "cascade")]
    pub decision: ForeignKey<TaskflowDecision>,
    #[umbral(on_delete = "set_null")]
    pub author_user: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub author_agent: Option<ForeignKey<TaskflowAgent>>,
    #[umbral(string, max_length = 160)]
    pub author_label: String,
    #[umbral(string, max_length = 8000, widget = "textarea")]
    pub body_markdown: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
