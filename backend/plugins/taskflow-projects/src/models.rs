//! Models for the `taskflow-projects` plugin.
//!
//! This is the project-management spine: workspaces, membership, invites, and
//! per-project API targets. Everything else hangs off `TaskflowProject`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use umbral::orm::{Choices, ForeignKey};
use umbral_auth::AuthUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowProjectStatus {
    Active,
    Paused,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowProjectRole {
    Owner,
    Admin,
    Developer,
    Reviewer,
    Viewer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowMembershipStatus {
    Invited,
    Active,
    Suspended,
    Left,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowInviteStatus {
    Pending,
    Accepted,
    Declined,
    Revoked,
    Expired,
}

/// UI theme preference for a user. Stored as TEXT (snake_case) like every other
/// `#[umbral(choices)]` field — no CHECK constraint, so the set is validated at
/// the form/serde layer, not by the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowTheme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowEndpointEnvironment {
    Local,
    Preview,
    Staging,
    Production,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskflowEndpointHealth {
    Unknown,
    Healthy,
    Degraded,
    Down,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowProject {
    pub id: i64,
    #[umbral(string, max_length = 160)]
    pub name: String,
    #[umbral(string, max_length = 120, unique)]
    pub slug: String,
    #[umbral(string, max_length = 4000, widget = "textarea")]
    pub description_markdown: String,
    #[umbral(string, max_length = 400)]
    pub repository_url: Option<String>,
    #[umbral(string, max_length = 400)]
    pub default_api_base_url: Option<String>,
    #[umbral(choices, default = "active")]
    pub status: TaskflowProjectStatus,
    #[umbral(on_delete = "set_null")]
    pub owner: Option<ForeignKey<AuthUser>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project", "member_key"]])]
pub struct TaskflowProjectMember {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// Stable per-project identity key, e.g. `user:42` or `email:dev@host`.
    #[umbral(string, max_length = 160)]
    pub member_key: String,
    #[umbral(on_delete = "set_null")]
    pub user: Option<ForeignKey<AuthUser>>,
    #[umbral(string, max_length = 120)]
    pub display_name: String,
    #[umbral(string, max_length = 240)]
    pub email: Option<String>,
    #[umbral(choices, default = "viewer")]
    pub role: TaskflowProjectRole,
    #[umbral(choices, default = "invited")]
    pub status: TaskflowMembershipStatus,
    #[umbral(on_delete = "set_null")]
    pub invited_by: Option<ForeignKey<AuthUser>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub joined_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowProjectInvite {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(string, max_length = 240)]
    pub email: String,
    #[umbral(string, max_length = 120)]
    pub display_name: Option<String>,
    #[umbral(choices, default = "developer")]
    pub role: TaskflowProjectRole,
    #[umbral(choices, default = "pending")]
    pub status: TaskflowInviteStatus,
    /// Store only a hash or opaque reference in production.
    #[umbral(string, max_length = 180, unique)]
    pub invite_token: String,
    #[umbral(on_delete = "set_null")]
    pub invited_by: Option<ForeignKey<AuthUser>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub accepted_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowProjectApiEndpoint {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(string, max_length = 80)]
    pub label: String,
    #[umbral(string, max_length = 500)]
    pub base_url: String,
    #[umbral(choices, default = "local")]
    pub environment: TaskflowEndpointEnvironment,
    #[umbral(choices, default = "unknown")]
    pub health: TaskflowEndpointHealth,
    #[umbral(default = "false")]
    pub is_default: bool,
    #[umbral(string, max_length = 1000, widget = "textarea")]
    pub notes_markdown: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// Per-user application preferences. Exactly one row per user (`user` is
/// unique), created lazily on first read. Kept as its own small model so app
/// prefs stay out of the framework's `admin_user_pref` table.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowUserSettings {
    pub id: i64,
    /// One settings row per user. `unique` makes get-or-create race-safe (a
    /// duplicate insert hits the constraint, not a second row).
    #[umbral(on_delete = "cascade", unique)]
    pub user: ForeignKey<AuthUser>,
    #[umbral(choices, default = "system")]
    pub theme: TaskflowTheme,
    #[umbral(default = "true")]
    pub email_notifications: bool,
    #[umbral(on_delete = "set_null")]
    pub default_project: Option<ForeignKey<TaskflowProject>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}
