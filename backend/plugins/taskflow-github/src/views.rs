//! HTTP handlers for the taskflow-github plugin.
//!
//! Every handler derives the caller from `RequireAuth` (never the body) and
//! reads its GitHub/OAuth collaborators from injected `State<GithubDeps>`, so
//! tests drive them with fakes and no network.

use axum::extract::State;
use serde_json::{Value, json};

use umbral::web::{Json, Path, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_projects::models::{TaskflowProject, taskflow_project};
use taskflow_tasks::models::{TaskflowTask, taskflow_task};

use serde::Deserialize;

use crate::GithubDeps;
use crate::api::NewIssue;
use crate::models::{TaskflowGithubPref, taskflow_github_pref};
use crate::tokens::{TokenOutcome, resolve_actor_token, resolve_owner_token};

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

/// The shared "connect GitHub to continue" response the disabled-state UI keys
/// on. Carries the connect URL so the frontend can route the user into the
/// OAuth flow.
fn needs_connect() -> ApiError {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "needs_connect", "connect_url": "/oauth/github/connect" })),
    )
}

/// `POST /api/taskflow/github/projects/{project}/tasks/{task}/publish`
///
/// Publish a task as a GitHub issue using the project's OWNER key, then store
/// the returned issue number/url back on the task.
pub async fn publish_issue(
    State(deps): State<GithubDeps>,
    RequireAuth(_user_id): RequireAuth<i64>,
    Path((project_id, task_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "project"))?;

    // The project must be GitHub-linked before anything can be published.
    let repo = project
        .github_repo
        .clone()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_linked"))?;

    // Owner / tracking key. Absent linker or token => disabled, never a fallback.
    let linked_by = project.github_linked_by.as_ref().map(|fk| fk.id());
    let token = match resolve_owner_token(deps.tokens.as_ref(), linked_by).await {
        TokenOutcome::Ready(t) => t,
        TokenOutcome::NeedsConnect => return Err(needs_connect()),
    };

    let task = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id) & taskflow_task::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "task"))?;

    let issue = deps
        .api
        .create_issue(
            &token,
            &repo,
            NewIssue { title: task.title.clone(), body: task.description_markdown.clone() },
        )
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "github"))?;

    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id))
        .update_values(
            json!({ "github_issue_number": issue.number, "github_issue_url": issue.url })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "store"))?;

    Ok(Json(json!({ "issue_number": issue.number, "issue_url": issue.url })))
}

#[derive(Deserialize)]
pub struct CommentBody {
    pub body: String,
}

/// `POST /api/taskflow/github/projects/{project}/tasks/{task}/comment`
///
/// Comment on the task's GitHub issue, attributed to the acting user. Opt-in:
/// uses that user's own token only when their `post_as_me` pref is true and
/// they have a linked account; otherwise 409 needs_connect (never the owner
/// key under their name).
pub async fn comment_on_issue(
    State(deps): State<GithubDeps>,
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, task_id)): Path<(i64, i64)>,
    Json(input): Json<CommentBody>,
) -> Result<StatusCode, ApiError> {
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "project"))?;
    let repo = project
        .github_repo
        .clone()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_linked"))?;

    let task = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id) & taskflow_task::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "task"))?;
    let issue_number = task
        .github_issue_number
        .ok_or_else(|| err(StatusCode::CONFLICT, "not_published"))?;

    // Opt-in: default false when no pref row exists for this (user, project).
    let post_as_me = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id) & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .map(|p| p.post_as_me)
        .unwrap_or(false);

    let token = match resolve_actor_token(deps.tokens.as_ref(), user_id, post_as_me).await {
        TokenOutcome::Ready(t) => t,
        TokenOutcome::NeedsConnect => return Err(needs_connect()),
    };

    deps.api
        .add_comment(&token, &repo, issue_number, &input.body)
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "github"))?;

    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/taskflow/github/projects/{project}/pref`
///
/// The caller's opt-in for this project. Get-or-default-false; never creates a
/// row on read. User derived from the token, not the path/body.
pub async fn get_pref(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let post_as_me = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id) & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .map(|p| p.post_as_me)
        .unwrap_or(false);
    Ok(Json(json!({ "post_as_me": post_as_me })))
}

#[derive(Deserialize)]
pub struct PrefBody {
    pub post_as_me: bool,
}

/// `POST /api/taskflow/github/projects/{project}/pref` — upsert the opt-in.
pub async fn set_pref(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<PrefBody>,
) -> Result<Json<Value>, ApiError> {
    use umbral::orm::ForeignKey;
    let existing = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id) & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;

    match existing {
        Some(p) => {
            TaskflowGithubPref::objects()
                .filter(taskflow_github_pref::ID.eq(p.id))
                .update_values(
                    json!({ "post_as_me": input.post_as_me })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                )
                .await
                .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
        }
        None => {
            TaskflowGithubPref::objects()
                .create(TaskflowGithubPref {
                    id: 0,
                    user: ForeignKey::new(user_id),
                    project: ForeignKey::new(project_id),
                    post_as_me: input.post_as_me,
                    created_at: None,
                    updated_at: None,
                })
                .await
                .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
        }
    }
    Ok(Json(json!({ "post_as_me": input.post_as_me })))
}
