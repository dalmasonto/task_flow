//! #1138: the ONE way a person writes task activity.
//!
//! auto-REST `taskflow_task_activity` used to keep Create/Update/Delete, and its
//! project scope admits every active member. So any member could write a row as
//! anyone (`actor_kind: agent|system`, any `actor_user` / `actor_label`, any
//! `action`, say a fake `claim_released` or `agent_key_rotated`), and edit or
//! delete real rows, wiping the audit trail. REST is read-only now.
//!
//! `POST /api/taskflow/tasks/{task}/activity` `{action, body_markdown?}`
//! (`deny_unknown_fields`). The caller must be able to see the task's project
//! (an active member, or a superuser); otherwise 404. The server sets `project`
//! (from the task), `actor_kind: user`, `actor_user` (the caller) and
//! `actor_label`. `action` is an allowlist of what people write: comments and
//! the timer's start/pause/stop. Every other action is written server-side by
//! the code that does the thing.

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use taskflow_projects::scope::can_access_project;

use crate::models::{TaskflowActorKind, TaskflowTask, TaskflowTaskActivity, taskflow_task};

/// What a person may record. Keep this narrow: every other action is a fact
/// the server records itself.
pub const PERSON_ACTIONS: [&str; 4] = ["commented", "timer_started", "timer_paused", "timer_stopped"];
const BODY_MAX: usize = 12_000;

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "task activity write failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityInput {
    pub action: String,
    #[serde(default)]
    pub body_markdown: Option<String>,
}

/// `POST /api/taskflow/tasks/{task}/activity`
pub async fn create(RequireAuth(user): RequireAuth<i64>, Path(task): Path<i64>, Json(input): Json<ActivityInput>) -> Result<Response, ApiError> {
    let not_found = || err(StatusCode::NOT_FOUND, "not_found", "No such task.");
    let task = TaskflowTask::objects().filter(taskflow_task::ID.eq(task)).first().await.map_err(internal)?.ok_or_else(not_found)?;
    let project = task.project.id();
    if !can_access_project(user, project).await {
        return Err(not_found());
    }
    let action = input.action.trim().to_string();
    if !PERSON_ACTIONS.contains(&action.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, "unknown_action", "Only comments and timer events can be recorded here."));
    }
    let body = input.body_markdown.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    if body.as_ref().is_some_and(|b| b.chars().count() > BODY_MAX) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid", "At most 12000 characters."));
    }
    if action == "commented" && body.is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "invalid", "A comment needs some text."));
    }
    let member_name = TaskflowProjectMember::objects()
        .filter(taskflow_project_member::PROJECT.eq(project) & taskflow_project_member::USER.eq(user))
        .first()
        .await
        .map_err(internal)?
        .map(|m| m.display_name)
        .filter(|n| !n.trim().is_empty());
    let label = match member_name {
        Some(n) => n,
        None => AuthUser::objects()
            .filter(auth_user::ID.eq(user))
            .first()
            .await
            .map_err(internal)?
            .map(|u| u.username)
            .unwrap_or_else(|| format!("user {user}")),
    };
    let row = TaskflowTaskActivity::objects()
        .create(TaskflowTaskActivity {
            id: 0,
            project: task.project.clone(),
            task: Some(ForeignKey::new(task.id)),
            actor_kind: TaskflowActorKind::User,
            actor_user: Some(ForeignKey::new(user)),
            actor_agent_id: None,
            actor_label: label,
            action,
            body_markdown: body,
            metadata_json: None,
            created_at: None,
        })
        .await
        .map_err(internal)?;
    Ok((StatusCode::CREATED, Json(row)).into_response())
}
