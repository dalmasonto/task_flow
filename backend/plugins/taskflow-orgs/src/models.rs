//! Organisations (#1133, Stage A of the org + licence program).
//!
//! An org groups projects and people. It is ADDITIVE: project access is still
//! decided only by project membership (`taskflow_projects::scope`). An org role
//! gates the org's own routes (`/api/taskflow/orgs/*`) and nothing else, so a
//! `billing` member reads the org's seats and (later) licence and spend, and
//! never a project.
//!
//! None of these tables is on auto-REST (`backend::rest::include_only`): every
//! read and write goes through `views.rs`, which checks the org role.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use umbral::orm::{Choices, ForeignKey};
use umbral_auth::AuthUser;

use taskflow_projects::models::TaskflowProject;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices)]
#[choices(rename_all = "snake_case")]
pub enum TaskflowOrgRole {
    /// Everything, including the licence and deleting the org.
    Owner,
    /// Manages people, settings and agents.
    Admin,
    /// Works in the projects they're added to (by project membership).
    Member,
    /// Sees the licence, seats and spend. No project access.
    Billing,
}

impl TaskflowOrgRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
            Self::Billing => "billing",
        }
    }

    /// Owner and admin manage the org's people and invites.
    pub fn manages(self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices)]
#[choices(rename_all = "snake_case")]
pub enum TaskflowOrgInviteStatus {
    Pending,
    Accepted,
    Revoked,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowOrg {
    pub id: i64,
    #[umbral(string, max_length = 120)]
    pub name: String,
    #[umbral(string, max_length = 80, unique)]
    pub slug: String,
    /// Set on a user's PERSONAL org (the backfill's and new projects' home).
    /// Unique, so a user has at most one, and a racing second create fails
    /// instead of duplicating it. Null for an org made by hand.
    #[umbral(on_delete = "set_null", unique)]
    pub personal_of: Option<ForeignKey<AuthUser>>,
    #[umbral(on_delete = "set_null")]
    pub created_by: Option<ForeignKey<AuthUser>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["org", "user"]])]
pub struct TaskflowOrgMember {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub org: ForeignKey<TaskflowOrg>,
    #[umbral(on_delete = "cascade")]
    pub user: ForeignKey<AuthUser>,
    #[umbral(choices, default = "member")]
    pub role: TaskflowOrgRole,
    #[umbral(on_delete = "set_null")]
    pub invited_by: Option<ForeignKey<AuthUser>>,
    #[umbral(noedit, auto_now_add)]
    pub joined_at: Option<DateTime<Utc>>,
}

/// Which org a project belongs to. A link table rather than a column on
/// `taskflow_project`, so the projects plugin does not depend on this one.
/// `project` is unique: a project is in at most one org.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowOrgProject {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub org: ForeignKey<TaskflowOrg>,
    #[umbral(on_delete = "cascade", unique)]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}

/// An invite to an org. Only `sha256(token)` is stored; the plaintext goes back
/// once, to the inviter, who shares the link. Accepting needs the token AND a
/// signed-in account whose email matches, and grants the org role only.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowOrgInvite {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub org: ForeignKey<TaskflowOrg>,
    #[umbral(string, max_length = 240)]
    pub email: String,
    #[umbral(choices, default = "member")]
    pub role: TaskflowOrgRole,
    #[umbral(choices, default = "pending")]
    pub status: TaskflowOrgInviteStatus,
    #[umbral(string, max_length = 64, unique, noedit)]
    pub token_hash: String,
    #[umbral(on_delete = "set_null")]
    pub invited_by: Option<ForeignKey<AuthUser>>,
    pub expires_at: DateTime<Utc>,
    /// When the link was last (re)issued; resends are throttled on it.
    pub sent_at: DateTime<Utc>,
    pub accepted_at: Option<DateTime<Utc>>,
    #[umbral(on_delete = "set_null")]
    pub accepted_by: Option<ForeignKey<AuthUser>>,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
