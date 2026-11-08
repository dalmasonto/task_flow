//! HTTP handlers for the taskflow-github plugin.
//!
//! Every handler derives the caller from `RequireAuth` (never the body) and
//! reads its GitHub/OAuth collaborators from injected `State<GithubDeps>`, so
//! tests drive them with fakes and no network.

use axum::extract::State;
use serde::Deserialize;
use serde_json::{Value, json};

use umbral::orm::ForeignKey;
use umbral::web::{Json, Path, StatusCode};
use umbral_auth::{CurrentIdentity, RequireAuth};

use taskflow_projects::models::{
    TaskflowProject, TaskflowProjectMember, TaskflowProjectRole, taskflow_project,
    taskflow_project_member,
};
use taskflow_tasks::models::{TaskflowTask, taskflow_task};

use crate::GithubDeps;
use taskflow_projects::account::password_budget;
use crate::api::NewIssue;
use crate::mirror::{MirrorError, MirrorOutcome, mirror_comment};
use crate::models::{TaskflowGithubPref, TaskflowProjectRepo, taskflow_github_pref, taskflow_project_repo};
use crate::repos;
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
    CurrentIdentity(identity): CurrentIdentity,
    Path((project_id, task_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    // SEC-1: authorize BEFORE any project fetch, owner-token resolution, or
    // GitHub call. Publishing spends the project owner's GitHub authority on an
    // external action, so it is owner/admin only. A non-member is rejected before
    // learning whether the project exists or is linked (anti-enumeration).
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_admin(user_id, identity.is_superuser, project_id).await?;

    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "project"))?;

    // The project must be GitHub-linked before anything can be published.
    if project.github_repo.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "not_linked"));
    }

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

    // #606: the task's own repo wins over the project default, and it must be
    // one the project still links — an old row naming a dropped repo must not
    // be able to push there.
    let repo = match repos::for_task(task.github_repo.as_deref(), &project) {
        Some(repo) if repos::is_linked(&project, &repo).await => repo,
        Some(repo) => {
            return Err(err(
                StatusCode::BAD_REQUEST,
                &format!("repo `{repo}` is not linked to this project"),
            ));
        }
        None => return Err(err(StatusCode::NOT_FOUND, "not_linked")),
    };

    let issue = deps
        .api
        .create_issue(
            &token,
            &repo,
            NewIssue {
                title: task.title.clone(),
                body: task.description_markdown.clone().unwrap_or_default(),
            },
        )
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "github"))?;

    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id))
        .update_values(
            json!({
                "github_issue_number": issue.number,
                "github_issue_url": issue.url,
                // #606: pin the task to the repo its issue lives in. A later
                // default change would otherwise leave the number pointing at
                // the wrong repo (issue numbers are only meaningful with one).
                "github_repo": repo,
            })
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
    CurrentIdentity(identity): CurrentIdentity,
    Path((project_id, task_id)): Path<(i64, i64)>,
    Json(input): Json<CommentBody>,
) -> Result<StatusCode, ApiError> {
    // SEC-1: active-member gate, then an explicit task-in-project preflight —
    // both BEFORE mirror_comment can resolve a token or reach GitHub. The
    // preflight stays even though mirror_comment re-checks internally, so the
    // handler's side-effect boundary is obvious and testable.
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_member(user_id, identity.is_superuser, project_id).await?;
    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id) & taskflow_task::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "task"))?;

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
    CurrentIdentity(identity): CurrentIdentity,
    Path(project_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    // SEC-1: the pref is per-user, per-project, so any active member may read
    // their own. Gate before the query so a non-member cannot probe project ids.
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_member(user_id, identity.is_superuser, project_id).await?;
    ensure_project_exists(project_id).await?;
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
    CurrentIdentity(identity): CurrentIdentity,
    Path(project_id): Path<i64>,
    Json(input): Json<PrefBody>,
) -> Result<Json<Value>, ApiError> {
    use umbral::orm::ForeignKey;
    // SEC-1: gate BEFORE any read or write, so a non-member cannot create a pref
    // row for a project they don't belong to.
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_member(user_id, identity.is_superuser, project_id).await?;
    ensure_project_exists(project_id).await?;
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

/// Authorize any project action open to members: superuser bypasses; everyone
/// else must be an ACTIVE member of this project at any role. Sibling of
/// `require_admin` without the rank check.
///
/// Deliberately runs BEFORE the handler fetches the project, so a non-member and
/// a nonexistent project both resolve to `403 not_a_member` — the caller cannot
/// use the response to tell a real project id from a missing one (anti-
/// enumeration). This is intended; the SEC-1 tests pin it so it is not "fixed"
/// back into a project-existence oracle.
async fn require_member(
    user_id: i64,
    is_superuser: bool,
    project_id: i64,
) -> Result<(), ApiError> {
    if is_superuser {
        return Ok(());
    }
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::FORBIDDEN, "not_a_member"))?;
    Ok(())
}

/// Whether the caller may perform an owner/admin action, as a plain boolean (not
/// a gate): superuser, or an active member at Admin rank or above. Used so the
/// status response's `can_publish` reflects the CALLER's permission — otherwise
/// the UI shows an enabled Publish control to a developer whom the backend then
/// 403s. The gate itself is still `require_admin`; this only informs the UI.
async fn caller_is_admin(
    user_id: i64,
    is_superuser: bool,
    project_id: i64,
) -> Result<bool, ApiError> {
    if is_superuser {
        return Ok(true);
    }
    let member = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(member
        .map(|m| role_rank(m.role) >= role_rank(TaskflowProjectRole::Admin))
        .unwrap_or(false))
}

/// After authorization, confirm the project actually exists. A normal member
/// always has one (the membership FK implies it), but the superuser bypass in
/// `require_member` authorizes WITHOUT a membership row — so a missing project
/// must 404 here rather than returning defaults (GET) or hitting a downstream FK
/// error (POST). Handlers that already fetch the project (status, publish) don't
/// need this; the pref handlers do.
async fn ensure_project_exists(project_id: i64) -> Result<(), ApiError> {
    TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "project"))?;
    Ok(())
}

/// `GET /api/taskflow/github/projects/{project}/status`
///
/// One call the UI uses to render every enabled/disabled state: is the caller's
/// GitHub connected, is the project linked, can THE CALLER publish (owner key
/// ready AND caller is owner/admin — SEC-1), and the caller's per-project opt-in.
pub async fn get_status(
    State(deps): State<GithubDeps>,
    CurrentIdentity(identity): CurrentIdentity,
    Path(project_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    // SEC-1: gate before the project fetch so a non-member gets 403 and never
    // learns whether the project exists or is GitHub-linked (anti-enumeration).
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_member(user_id, identity.is_superuser, project_id).await?;
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "project"))?;

    let user_connected = deps.tokens.token_for_user(user_id).await.is_some();
    let linked_by = project.github_linked_by.as_ref().map(|fk| fk.id());
    // can_publish reflects the CALLER's actual ability to publish: the owner
    // token must be ready AND the caller must be owner/admin (publish is
    // require_admin gated). Without the role term a developer would see an
    // enabled Publish button and get a 403 on click.
    let owner_token_ready = matches!(
        resolve_owner_token(deps.tokens.as_ref(), linked_by).await,
        TokenOutcome::Ready(_)
    );
    let can_publish =
        owner_token_ready && caller_is_admin(user_id, identity.is_superuser, project_id).await?;
    let post_as_me = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(user_id) & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .map(|p| p.post_as_me)
        .unwrap_or(false);

    // #606: every linked repo, default first. `github_repo` stays the default
    // (the legacy shape the badge has always read), so an older client sees
    // exactly what it saw before.
    let linked = repos::linked(project_id).await;
    let repo_list: Vec<Value> = linked
        .iter()
        .map(|row| json!({ "repo": row.repo, "is_default": row.is_default }))
        .collect();

    Ok(Json(json!({
        "user_connected": user_connected,
        "project_linked": project.github_repo.is_some(),
        "github_repo": project.github_repo,
        "repos": repo_list,
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
    // #1135: who you're connected as, since when, and which projects use your
    // link as their issue-tracking key. `login` is cached per user for
    // LOGIN_TTL and is `null` (never an error) when GitHub can't answer.
    let Some(info) = deps.tokens.account_for_user(user_id).await else {
        forget_login(user_id);
        return Ok(Json(json!({ "connected": false, "login": null, "connected_at": null, "scopes": null, "projects_tracking": [] })));
    };
    let login = match cached_login(user_id, &info.account_id) {
        Some(l) => Some(l),
        None => match deps.tokens.token_for_user(user_id).await {
            Some(token) => match deps.api.current_login(&token).await {
                Ok(l) => {
                    remember_login(user_id, &info.account_id, &l);
                    Some(l)
                }
                // Never log the token or GitHub's body.
                Err(_) => None,
            },
            None => None,
        },
    };
    Ok(Json(json!({
        "connected": true,
        "login": login,
        "connected_at": info.connected_at,
        "scopes": info.scopes,
        "projects_tracking": tracking_projects(user_id).await?,
    })))
}

const LOGIN_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// user → (when, GitHub account id, login). A hit needs the same account id,
/// so linking another GitHub account (OAuth again, no disconnect) misses.
type LoginCache = std::collections::HashMap<i64, (std::time::Instant, String, String)>;

fn login_cache() -> &'static std::sync::Mutex<LoginCache> {
    static C: std::sync::OnceLock<std::sync::Mutex<LoginCache>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

fn cached_login(user: i64, account_id: &str) -> Option<String> {
    let mut c = login_cache().lock().unwrap_or_else(|p| p.into_inner());
    c.retain(|_, (at, _, _)| at.elapsed() < LOGIN_TTL);
    c.get(&user).filter(|(_, id, _)| id == account_id).map(|(_, _, l)| l.clone())
}

fn remember_login(user: i64, account_id: &str, login: &str) {
    login_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(user, (std::time::Instant::now(), account_id.to_string(), login.to_string()));
}

fn forget_login(user: i64) {
    login_cache().lock().unwrap_or_else(|p| p.into_inner()).remove(&user);
}

/// Projects whose GitHub issue sync rides on this user's link.
async fn tracking_projects(user: i64) -> Result<Vec<Value>, ApiError> {
    Ok(TaskflowProject::objects()
        .filter(taskflow_project::GITHUB_LINKED_BY.eq(user))
        .fetch()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?
        .into_iter()
        .map(|p| json!({ "id": p.id, "name": p.name }))
        .collect())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisconnectBody {
    #[serde(default)]
    pub password: Option<String>,
}

/// `DELETE /api/taskflow/github/me` `{password}` — #1135: unlink GitHub.
///
/// Needs the account password (403 `password_required`): an account made by
/// GitHub sign-in has a random password, so without this check someone could
/// disconnect the only way they can sign in. The token is revoked at GitHub
/// (best effort) after the link row is gone; projects tracking issues with
/// this link are listed so the UI can say they need a reconnect.
pub async fn delete_me(
    State(deps): State<GithubDeps>,
    RequireAuth(user_id): RequireAuth<i64>,
    Json(body): Json<DisconnectBody>,
) -> Result<Json<Value>, ApiError> {
    let me = umbral_auth::AuthUser::objects()
        .filter(umbral_auth::auth_user::ID.eq(user_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    // #6036: the per-user guess budget every password-gated route shares
    // (the email change too), so a stolen session can't brute-force the
    // password through here.
    if !password_budget::allowed(password_budget::SCOPE, user_id) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "too_many_attempts", "detail": "Too many wrong passwords. Try again in 15 minutes." })),
        ));
    }
    let ok = match body.password.as_deref() {
        Some(pw) if !pw.is_empty() => umbral_auth::verify_password_async(pw, &me.password_hash).await.unwrap_or(false),
        _ => false,
    };
    if !ok {
        password_budget::spend(password_budget::SCOPE, user_id);
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "password_required",
                "detail": "Enter your TaskFlow password. If you only ever signed in with GitHub, set a password first (Forgot password), then disconnect.",
            })),
        ));
    }
    let projects = tracking_projects(user_id).await?;
    let token = deps.tokens.disconnect(user_id).await;
    forget_login(user_id);
    if let Some(t) = token.as_deref().filter(|t| !t.is_empty()) {
        if deps.api.revoke_token(t).await.is_err() {
            tracing::warn!(user = user_id, "github token revoke failed; the link is removed locally");
        }
    }
    Ok(Json(json!({ "disconnected": token.is_some(), "projects_tracking": projects })))
}

// ---------------------------------------------------------------------------
// #606: managing a project's linked repos
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RepoBody {
    pub repo: String,
}

/// `GET /api/taskflow/github/projects/{project}/repos` — every linked repo,
/// default first. Admin-gated like the link itself: it names other people's
/// repositories, which is not a visitor's business.
pub async fn list_repos(
    CurrentIdentity(identity): CurrentIdentity,
    Path(project_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_admin(user_id, identity.is_superuser, project_id).await?;

    let rows = repos::linked(project_id).await;
    Ok(Json(json!({
        "repos": rows
            .iter()
            .map(|row| json!({ "repo": row.repo, "is_default": row.is_default }))
            .collect::<Vec<_>>(),
    })))
}

/// `POST .../repos` `{ "repo": "owner/name" }` — link one more repo.
///
/// The FIRST repo a project links also becomes its default (`github_repo`), so
/// linking here and linking through the legacy endpoint leave the project in
/// the same state.
pub async fn add_repo(
    Path(project_id): Path<i64>,
    CurrentIdentity(identity): CurrentIdentity,
    Json(body): Json<RepoBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_admin(user_id, identity.is_superuser, project_id).await?;

    let repo = body.repo.trim().to_string();
    if !repos::valid_repo(&repo) {
        return Err(err(StatusCode::BAD_REQUEST, "repo must be owner/name"));
    }
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "project"))?;

    if repos::is_linked(&project, &repo).await {
        return Err(err(StatusCode::BAD_REQUEST, "already linked"));
    }
    let is_default = project.github_repo.is_none();
    TaskflowProjectRepo::objects()
        .create(TaskflowProjectRepo {
            id: 0,
            project: ForeignKey::new(project_id),
            repo: repo.clone(),
            is_default,
            created_at: None,
        })
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    if is_default {
        // Keep the mirror honest: `github_repo` IS the default repo.
        TaskflowProject::objects()
            .filter(taskflow_project::ID.eq(project_id))
            .update_values(
                json!({ "github_repo": repo, "github_linked_by": user_id })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            )
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    }
    Ok(Json(json!({ "ok": true, "repo": repo, "is_default": is_default })))
}

/// `POST .../repos/remove` `{ "repo": ... }` — unlink one repo.
///
/// The default repo can only be removed when it is the LAST one: that leaves
/// the project unlinked, which is a state the UI already understands. Removing
/// it while others exist would leave every task that never named a repo with no
/// repo at all — set another default first.
pub async fn remove_repo(
    Path(project_id): Path<i64>,
    CurrentIdentity(identity): CurrentIdentity,
    Json(body): Json<RepoBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_admin(user_id, identity.is_superuser, project_id).await?;

    let repo = body.repo.trim().to_string();
    let rows = repos::linked(project_id).await;
    let target = rows.iter().find(|row| row.repo == repo);
    // A repo that is only the legacy `github_repo` (no row yet) is still
    // removable: it is a linked repo by every definition that matters.
    match target {
        None => {
            return Err(err(StatusCode::BAD_REQUEST, "not linked"));
        }
        Some(row) if row.is_default && rows.len() > 1 => {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "this is the default repo — make another repo the default first",
            ));
        }
        Some(_) => {}
    }

    TaskflowProjectRepo::objects()
        .filter(taskflow_project_repo::PROJECT.eq(project_id) & taskflow_project_repo::REPO.eq(&repo))
        .delete()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;

    let mut values = serde_json::Map::new();
    if target.map(|row| row.is_default).unwrap_or(false) {
        values.insert("github_repo".to_string(), Value::Null);
        values.insert("github_linked_by".to_string(), Value::Null);
        values.insert("github_default_branch".to_string(), Value::Null);
    }
    if !values.is_empty() {
        TaskflowProject::objects()
            .filter(taskflow_project::ID.eq(project_id))
            .update_values(values)
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    }
    Ok(Json(json!({ "ok": true, "removed": repo })))
}

/// `POST .../repos/default` `{ "repo": ... }` — make one linked repo the
/// default. `TaskflowProject.github_repo` follows, because it IS the default.
pub async fn set_default_repo(
    Path(project_id): Path<i64>,
    CurrentIdentity(identity): CurrentIdentity,
    Json(body): Json<RepoBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id: i64 = identity
        .pk()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "identity"))?;
    require_admin(user_id, identity.is_superuser, project_id).await?;

    let repo = body.repo.trim().to_string();
    let rows = repos::linked(project_id).await;
    if !rows.iter().any(|row| row.repo == repo) {
        return Err(err(StatusCode::BAD_REQUEST, "not linked"));
    }

    for row in rows.iter().filter(|row| row.is_default != (row.repo == repo)) {
        TaskflowProjectRepo::objects()
            .filter(taskflow_project_repo::ID.eq(row.id))
            .update_values(json!({ "is_default": row.repo == repo }).as_object().cloned().unwrap_or_default())
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
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
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "db"))?;
    Ok(Json(json!({ "ok": true, "repo": repo })))
}
