//! Models for the `taskflow-github` plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::ForeignKey;
use umbral_auth::AuthUser;

/// Per-user, per-project opt-in: may the agent post to GitHub attributed to
/// this user, in this project? Default false — nothing goes out under someone's
/// name until they turn it on. Per-project because acting is repo-scoped.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["user", "project"]])]
pub struct TaskflowGithubPref {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub user: ForeignKey<AuthUser>,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(default = "false")]
    pub post_as_me: bool,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

/// #606: one linked GitHub repo of a project. A project may span several
/// (~3 in practice). Exactly one row per project is the DEFAULT, and
/// `TaskflowProject.github_repo` mirrors it — that column stays the single
/// source every reader that predates this table already trusts, so the table
/// never disagrees with it.
///
/// Tasks may name a repo of their own (`TaskflowTask.github_repo`); a task that
/// names none belongs to the default, which is why removing the default while
/// others exist is refused: it would leave those tasks with no repo at all.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project", "repo"]])]
pub struct TaskflowProjectRepo {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// `owner/name`, exactly as GitHub spells it.
    #[umbral(string, max_length = 200)]
    pub repo: String,
    #[umbral(default = "false")]
    pub is_default: bool,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
