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
