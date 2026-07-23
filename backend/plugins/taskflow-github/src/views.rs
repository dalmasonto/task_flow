//! HTTP handlers for the taskflow-github plugin.
//!
//! Every handler derives the caller from `RequireAuth` (never the body) and
//! reads its GitHub/OAuth collaborators from injected `State<GithubDeps>`, so
//! tests drive them with fakes and no network.

use axum::extract::State;
use serde::Deserialize;
use serde_json::{Value, json};

use umbral::web::{Json, Path, StatusCode};
use umbral_auth::{CurrentIdentity, RequireAuth};

use taskflow_projects::models::{
    TaskflowProject, TaskflowProjectMember, TaskflowProjectRole, taskflow_project,
    taskflow_project_member,
};
use taskflow_tasks::models::{TaskflowTask, taskflow_task};

use crate::GithubDeps;
use crate::api::NewIssue;
use crate::mirror::{MirrorError, MirrorOutcome, mirror_comment};
use crate::models::{TaskflowGithubPref, taskflow_github_pref};
use crate::tokens::{TokenOutcome, resolve_owner_token};

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
            NewIssue {
                title: task.title.clone(),
                body: task.description_markdown.clone(),
            },
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

    Ok(Json(
        json!({ "issue_number": issue.number, "issue_url": issue.url }),
    ))
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
    match mirror_comment(
        deps.api.as_ref(),
        deps.tokens.as_ref(),
        project_id,
        task_id,
        user_id,
        &input.body,
    )
    .await
    {
        Ok(MirrorOutcome::Posted) => Ok(StatusCode::NO_CONTENT),
        Ok(MirrorOutcome::NeedsConnect) => Err(needs_connect()),
        Ok(MirrorOutcome::NotLinked) => Err(err(StatusCode::NOT_FOUND, "not_linked")),
        Ok(MirrorOutcome::NotPublished) => Err(err(StatusCode::CONFLICT, "not_published")),
        Err(MirrorError::Github(_)) => Err(err(StatusCode::BAD_GATEWAY, "github")),
        Err(MirrorError::Db) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, "db")),
    }
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

/// Privilege rank of a project role, high to low. Mirrors the (private) helper
/// in taskflow-projects; kept local since it isn't exported.
fn role_rank(role: TaskflowProjectRole) -> u8 {
    match role {
        TaskflowProjectRole::Owner => 4,
        TaskflowProjectRole::Admin => 3,
        TaskflowProjectRole::Developer => 2,
        TaskflowProjectRole::Reviewer => 1,
        TaskflowProjectRole::Viewer => 0,
    }
}

/// Authorize an owner/admin action: superuser bypasses; everyone else must be an
/// ACTIVE member of this project at Admin rank or above. Takes primitives (not
/// the `Identity` type) so the handler owns the extraction.
async fn require_admin(
    user_id: i64,
    is_superuser: bool,
    project_id: i64,
) -> Result<(), ApiError> {
    if is_superuser {
        return Ok(());
    }
    let member = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::FORBIDDEN, "not_a_member"))?;
    if role_rank(member.role) < role_rank(TaskflowProjectRole::Admin) {
        return Err(err(StatusCode::FORBIDDEN, "forbidden"));
    }
    Ok(())
}

/// `GET /api/taskflow/github/projects/{project}/status`
///
/// One call the UI uses to render every enabled/disabled state: is the caller's
/// GitHub connected, is the project linked, can it publish (owner key ready),
/// and the caller's per-project opt-in.
pub async fn get_status(
    State(deps): State<GithubDeps>,
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "project"))?;

    let user_connected = deps.tokens.token_for_user(user_id).await.is_some();
    let linked_by = project.github_linked_by.as_ref().map(|fk| fk.id());
    let can_publish = matches!(
        resolve_owner_token(deps.tokens.as_ref(), linked_by).await,
        TokenOutcome::Ready(_)
    );
    let post_as_me = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id) & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .map(|p| p.post_as_me)
        .unwrap_or(false);

    Ok(Json(json!({
        "user_connected": user_connected,
        "project_linked": project.github_repo.is_some(),
        "github_repo": project.github_repo,
        "can_publish": can_publish,
        "post_as_me": post_as_me,
        "auto_mirror": project.github_auto_mirror,
    })))
}

#[derive(Deserialize)]
pub struct AutoMirrorBody {
    pub enabled: bool,
}

/// `POST /api/taskflow/github/projects/{project}/auto-mirror`  `{ "enabled": bool }`
///
/// Owner/admin: toggle auto-mirroring of comment-type activity to the linked
/// issue. Still gated per-actor (post_as_me + connection) — this only removes
/// the per-comment opt-in click.
pub async fn set_auto_mirror(
    CurrentIdentity(identity): CurrentIdentity,
    Path(project_id): Path<i64>,
    Json(input): Json<AutoMirrorBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_admin(user_id, identity.is_superuser, project_id).await?;

    TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .update_values(
            json!({ "github_auto_mirror": input.enabled })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "store"))?;

    Ok(Json(json!({ "auto_mirror": input.enabled })))
}

#[derive(Deserialize)]
pub struct LinkBody {
    pub repo: String,
}

/// Normalize a repo reference to `owner/name`, accepting either that or a full
/// GitHub URL. Returns None if it isn't a plausible `owner/name`.
fn normalize_repo(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    // Strip a leading https://github.com/ if present.
    let s = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .unwrap_or(s)
        .trim_end_matches(".git");
    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() == 2 {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

/// `POST /api/taskflow/github/projects/{project}/link`  body `{ "repo": "owner/name" }`
///
/// Owner/admin gated. The caller must have a linked GitHub account — they become
/// the project's tracking key (`github_linked_by`). Sets `github_repo`.
pub async fn link_project(
    State(deps): State<GithubDeps>,
    CurrentIdentity(identity): CurrentIdentity,
    Path(project_id): Path<i64>,
    Json(input): Json<LinkBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_admin(user_id, identity.is_superuser, project_id).await?;

    let repo =
        normalize_repo(&input.repo).ok_or_else(|| err(StatusCode::BAD_REQUEST, "bad_repo"))?;

    // The linker becomes the tracking key, so they must be connected.
    if deps.tokens.token_for_user(user_id).await.is_none() {
        return Err(needs_connect());
    }

    TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .update_values(
            json!({ "github_repo": repo, "github_linked_by": user_id })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "store"))?;

    Ok(Json(
        json!({ "github_repo": repo, "github_linked_by": user_id }),
    ))
}

/// `GET /api/taskflow/github/me`
///
/// User-level connection check for the account/settings page (no project
/// context): is the caller's GitHub account linked?
pub async fn get_me(
    State(deps): State<GithubDeps>,
    RequireAuth(user_id): RequireAuth<i64>,
) -> Result<Json<Value>, ApiError> {
    let connected = deps.tokens.token_for_user(user_id).await.is_some();
    Ok(Json(json!({ "connected": connected })))
}
