//! #1139: a project's API environments (`taskflow_project_api_endpoint`).
//! auto-REST is read-only for them since #1137; these handlers are the writer.
//!
//! | Route | Body | Returns |
//! |---|---|---|
//! | `POST /api/taskflow/projects/{p}/environments` | `{label, base_url, environment?, notes_markdown?, is_default?}` | 201 row |
//! | `PATCH /api/taskflow/projects/{p}/environments/{id}` | `{label?, base_url?, environment?, notes_markdown?}` | 200 row |
//! | `DELETE /api/taskflow/projects/{p}/environments/{id}` | | 200 `{deleted, default}` |
//! | `POST /api/taskflow/projects/{p}/environments/{id}/default` | | 200 `[rows]`, default first |
//!
//! Owner or admin (a superuser counts as owner); another member 403, an
//! outsider or another project's environment 404. `health` and
//! `last_checked_at` are never client-written.
//!
//! **Exactly one default whenever any exist.** The first environment is the
//! default; `is_default: true` on create moves it; PATCH can't touch it; only
//! `/default` switches it; deleting the default promotes the oldest left.
//! **The default row is the source of truth** and `project.default_api_base_url`
//! follows it, written in the same transaction (and when the default row's
//! `base_url` is edited). Every write that can move the default runs under a
//! `FOR UPDATE SKIP LOCKED` lock on the project row (busy: 409 `busy`), so two
//! switches at once can't leave two defaults.

use serde::Deserialize;
use serde_json::json;
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use crate::models::{
    TaskflowEndpointEnvironment, TaskflowEndpointHealth, TaskflowProject, TaskflowProjectApiEndpoint,
    TaskflowProjectMember, TaskflowProjectRole, taskflow_project, taskflow_project_api_endpoint,
    taskflow_project_member,
};
use crate::project_edit::{ApiError, check_url_max, err};

type Endpoint = TaskflowProjectApiEndpoint;
type TxError = Box<dyn std::error::Error + Send + Sync>;
const BUSY: &str = "taskflow:environments_busy";

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "environment write failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", None, "internal error")
}

fn tx_failed(e: TxError) -> ApiError {
    if e.to_string().contains(BUSY) {
        err(StatusCode::CONFLICT, "busy", None, "The environments are being changed right now; try again in a moment.")
    } else {
        internal(e)
    }
}

/// Owner/admin of `project`, or a superuser. 404 for outsiders.
async fn require_manager(user: i64, project: i64) -> Result<(), ApiError> {
    let me = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project)
                & taskflow_project_member::USER.eq(user)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(internal)?;
    let role = match me {
        Some(m) => m.role,
        None => {
            let su = AuthUser::objects().filter(auth_user::ID.eq(user)).first().await.map_err(internal)?.is_some_and(|u| u.is_superuser);
            let exists = TaskflowProject::objects().filter(taskflow_project::ID.eq(project)).first().await.map_err(internal)?.is_some();
            if !(su && exists) {
                return Err(err(StatusCode::NOT_FOUND, "not_found", None, "No such project."));
            }
            TaskflowProjectRole::Owner
        }
    };
    if !matches!(role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin) {
        return Err(err(StatusCode::FORBIDDEN, "owner_or_admin_only", None, "Only owners and admins can change environments."));
    }
    Ok(())
}

async fn load(project: i64, id: i64) -> Result<Endpoint, ApiError> {
    Endpoint::objects()
        .filter(taskflow_project_api_endpoint::ID.eq(id) & taskflow_project_api_endpoint::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", None, "No such environment."))
}

async fn all_of(project: i64) -> Result<Vec<Endpoint>, ApiError> {
    let mut rows = Endpoint::objects()
        .filter(taskflow_project_api_endpoint::PROJECT.eq(project))
        .order_by(taskflow_project_api_endpoint::ID.asc())
        .fetch()
        .await
        .map_err(internal)?;
    rows.sort_by_key(|r| !r.is_default);
    Ok(rows)
}

/// Realtime for every environment of the project, and the project (its
/// `default_api_base_url` may have followed).
async fn emit_all(project: i64) -> Result<Vec<Endpoint>, ApiError> {
    let rows = all_of(project).await?;
    for r in &rows {
        crate::emit::emit_post_save(r).await;
    }
    if let Ok(Some(p)) = TaskflowProject::objects().filter(taskflow_project::ID.eq(project)).first().await {
        crate::emit::emit_post_save(&p).await;
    }
    Ok(rows)
}

/// Inside a transaction: lock the project row, or fail with BUSY.
async fn lock_project(tx: &mut umbral::db::Transaction, project: i64) -> Result<(), TxError> {
    let locked = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .for_update_skip_locked()
        .on_tx(tx)
        .first()
        .await?;
    if locked.is_none() {
        return Err(BUSY.into());
    }
    Ok(())
}

/// Inside a transaction: make `id` the only default (or none, with `None`),
/// and point the project's `default_api_base_url` at it.
async fn set_default_on(tx: &mut umbral::db::Transaction, project: i64, id: Option<i64>, base_url: Option<String>) -> Result<(), TxError> {
    let mut off = serde_json::Map::new();
    off.insert("is_default".into(), json!(false));
    Endpoint::objects()
        .filter(taskflow_project_api_endpoint::PROJECT.eq(project) & taskflow_project_api_endpoint::IS_DEFAULT.eq(true))
        .on_tx(tx)
        .update_values(off)
        .await?;
    if let Some(id) = id {
        let mut on = serde_json::Map::new();
        on.insert("is_default".into(), json!(true));
        Endpoint::objects()
            .filter(taskflow_project_api_endpoint::ID.eq(id) & taskflow_project_api_endpoint::PROJECT.eq(project))
            .on_tx(tx)
            .update_values(on)
            .await?;
        let mut p = serde_json::Map::new();
        p.insert("default_api_base_url".into(), json!(base_url));
        p.insert("updated_at".into(), json!(chrono::Utc::now()));
        TaskflowProject::objects().filter(taskflow_project::ID.eq(project)).on_tx(tx).update_values(p).await?;
    }
    Ok(())
}

fn label_ok(label: &str) -> Result<String, ApiError> {
    let l = label.trim().to_string();
    if l.is_empty() || l.chars().count() > 80 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("label"), "1 to 80 characters."));
    }
    Ok(l)
}

fn notes_ok(n: Option<String>) -> Result<Option<String>, ApiError> {
    let n = n.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if n.as_ref().is_some_and(|s| s.chars().count() > 1000) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("notes_markdown"), "At most 1000 characters."));
    }
    Ok(n)
}

fn base_url_ok(u: String) -> Result<String, ApiError> {
    // 400, not the column's 500: the default row's URL is copied into
    // `project.default_api_base_url` (max 400), so one rule everywhere.
    check_url_max("base_url", Some(u), 400)?.ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid", Some("base_url"), "An http(s) address is required."))
}

fn env_str(e: TaskflowEndpointEnvironment) -> String {
    serde_json::to_value(e).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub label: String,
    pub base_url: String,
    #[serde(default)]
    pub environment: Option<TaskflowEndpointEnvironment>,
    #[serde(default)]
    pub notes_markdown: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

/// `POST /api/taskflow/projects/{project}/environments`
pub async fn create(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Json(input): Json<CreateInput>) -> Result<Response, ApiError> {
    require_manager(user, project).await?;
    let label = label_ok(&input.label)?;
    let base_url = base_url_ok(input.base_url)?;
    let notes = notes_ok(input.notes_markdown)?;
    let environment = input.environment.unwrap_or(TaskflowEndpointEnvironment::Local);
    let want_default = input.is_default;
    let url = base_url.clone();
    let id = umbral::transaction(move |tx| {
        Box::pin(async move {
            lock_project(tx, project).await?;
            let has_default = Endpoint::objects()
                .filter(taskflow_project_api_endpoint::PROJECT.eq(project) & taskflow_project_api_endpoint::IS_DEFAULT.eq(true))
                .on_tx(tx)
                .first()
                .await?
                .is_some();
            let row = Endpoint::objects()
                .on_tx(tx)
                .create(Endpoint {
                    id: 0,
                    project: ForeignKey::new(project),
                    label,
                    base_url,
                    environment,
                    health: TaskflowEndpointHealth::Unknown,
                    is_default: false,
                    notes_markdown: notes,
                    last_checked_at: None,
                    created_at: None,
                })
                .await?;
            if want_default || !has_default {
                set_default_on(tx, project, Some(row.id), Some(url)).await?;
            }
            Ok::<_, TxError>(row.id)
        })
    })
    .await
    .map_err(tx_failed)?;
    emit_all(project).await?;
    Ok((StatusCode::CREATED, Json(load(project, id).await?)).into_response())
}

/// Absent → `None`; `null` → `Some(None)`; a value → `Some(Some(v))`.
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchInput {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub environment: Option<TaskflowEndpointEnvironment>,
    #[serde(default, deserialize_with = "double_option")]
    pub notes_markdown: Option<Option<String>>,
}

/// `PATCH /api/taskflow/projects/{project}/environments/{id}`
pub async fn patch(RequireAuth(user): RequireAuth<i64>, Path((project, id)): Path<(i64, i64)>, Json(input): Json<PatchInput>) -> Result<Response, ApiError> {
    require_manager(user, project).await?;
    let current = load(project, id).await?;
    let mut v = serde_json::Map::new();
    if let Some(l) = input.label {
        v.insert("label".into(), json!(label_ok(&l)?));
    }
    let mut new_url = None;
    if let Some(u) = input.base_url {
        let u = base_url_ok(u)?;
        if u != current.base_url {
            v.insert("base_url".into(), json!(u));
            new_url = Some(u);
        }
    }
    if let Some(e) = input.environment {
        v.insert("environment".into(), json!(env_str(e)));
    }
    if let Some(n) = input.notes_markdown {
        v.insert("notes_markdown".into(), json!(notes_ok(n)?));
    }
    if v.is_empty() {
        return Ok(Json(current).into_response());
    }
    // The URL changed on the default: the project column follows, under the lock.
    umbral::transaction(move |tx| {
        Box::pin(async move {
            lock_project(tx, project).await?;
            Endpoint::objects()
                .filter(taskflow_project_api_endpoint::ID.eq(id) & taskflow_project_api_endpoint::PROJECT.eq(project))
                .on_tx(tx)
                .update_values(v)
                .await?;
            if let Some(u) = new_url {
                let is_default = Endpoint::objects()
                    .filter(taskflow_project_api_endpoint::ID.eq(id) & taskflow_project_api_endpoint::IS_DEFAULT.eq(true))
                    .on_tx(tx)
                    .first()
                    .await?
                    .is_some();
                if is_default {
                    let mut p = serde_json::Map::new();
                    p.insert("default_api_base_url".into(), json!(u));
                    p.insert("updated_at".into(), json!(chrono::Utc::now()));
                    TaskflowProject::objects().filter(taskflow_project::ID.eq(project)).on_tx(tx).update_values(p).await?;
                }
            }
            Ok::<_, TxError>(())
        })
    })
    .await
    .map_err(tx_failed)?;
    let fresh = load(project, id).await?;
    crate::emit::emit_post_save(&fresh).await;
    if fresh.is_default {
        if let Ok(Some(p)) = TaskflowProject::objects().filter(taskflow_project::ID.eq(project)).first().await {
            crate::emit::emit_post_save(&p).await;
        }
    }
    Ok(Json(fresh).into_response())
}

/// `DELETE /api/taskflow/projects/{project}/environments/{id}`
pub async fn delete(RequireAuth(user): RequireAuth<i64>, Path((project, id)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    require_manager(user, project).await?;
    load(project, id).await?;
    let new_default = umbral::transaction(move |tx| {
        Box::pin(async move {
            lock_project(tx, project).await?;
            let gone = Endpoint::objects()
                .filter(taskflow_project_api_endpoint::ID.eq(id) & taskflow_project_api_endpoint::PROJECT.eq(project))
                .on_tx(tx)
                .delete()
                .await?;
            if gone == 0 {
                return Ok::<_, TxError>((false, None));
            }
            // A default left behind, or the oldest one promoted.
            let still = Endpoint::objects()
                .filter(taskflow_project_api_endpoint::PROJECT.eq(project) & taskflow_project_api_endpoint::IS_DEFAULT.eq(true))
                .on_tx(tx)
                .first()
                .await?;
            if let Some(d) = still {
                return Ok((true, Some(d.id)));
            }
            let oldest = Endpoint::objects()
                .filter(taskflow_project_api_endpoint::PROJECT.eq(project))
                .order_by(taskflow_project_api_endpoint::ID.asc())
                .on_tx(tx)
                .first()
                .await?;
            match oldest {
                Some(o) => {
                    set_default_on(tx, project, Some(o.id), Some(o.base_url.clone())).await?;
                    Ok((true, Some(o.id)))
                }
                None => Ok((true, None)),
            }
        })
    })
    .await
    .map_err(tx_failed)?;
    let (deleted, default) = new_default;
    if deleted {
        // No manual post_delete: umbral 0.0.13's queryset delete already fires
        // a per-row `post_delete` (tested in `a_delete_fires_post_delete`).
        emit_all(project).await?;
    }
    Ok(Json(json!({ "deleted": id, "default": default })).into_response())
}

/// `POST /api/taskflow/projects/{project}/environments/{id}/default`
pub async fn make_default(RequireAuth(user): RequireAuth<i64>, Path((project, id)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    require_manager(user, project).await?;
    load(project, id).await?;
    umbral::transaction(move |tx| {
        Box::pin(async move {
            lock_project(tx, project).await?;
            // Re-read under the lock: it may have been deleted meanwhile.
            let row = Endpoint::objects()
                .filter(taskflow_project_api_endpoint::ID.eq(id) & taskflow_project_api_endpoint::PROJECT.eq(project))
                .on_tx(tx)
                .first()
                .await?
                .ok_or_else(|| -> TxError { "taskflow:environment_gone".into() })?;
            set_default_on(tx, project, Some(row.id), Some(row.base_url)).await
        })
    })
    .await
    .map_err(|e| if e.to_string().contains("environment_gone") { err(StatusCode::NOT_FOUND, "not_found", None, "No such environment.") } else { tx_failed(e) })?;
    let rows = emit_all(project).await?;
    Ok(Json(json!(rows)).into_response())
}

