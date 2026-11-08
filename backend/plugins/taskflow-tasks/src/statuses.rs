//! #5907 1b: per-project board columns (`taskflow_project_status`).
//!
//! | Route | Body | Returns |
//! |---|---|---|
//! | `GET /api/taskflow/projects/{p}/statuses` | | 200 `{columns, version, custom}` |
//! | `PUT /api/taskflow/projects/{p}/statuses` | `{columns:[{key,label,kind,color?,hidden?}], base_version}` | 200, same shape |
//!
//! Every column maps onto one built-in status `kind`, and `task.status` stays
//! the truth: agents, the MCP, reviews, timers and stats never see a column.
//! `task.status_column` names the column inside the kind:
//!
//! * **Invariant:** `status_column` is the key of a column whose kind is the
//!   task's status. [`register`] restores it after every task write, on both
//!   signal paths: a stale or missing key becomes the FIRST column of the
//!   task's kind. Status wins, so writing only `status` (the MCP, older
//!   clients) lands in that first column. To move a task to a specific column,
//!   write `status` AND `status_column`.
//! * **Editing columns never changes a task's status.** A task in a removed
//!   column (or one whose kind changed) moves to the first column of its own
//!   kind, in the same transaction.
//! * No rows means [`defaults`], whose keys are the kind names. Every kind
//!   keeps at least one column (it may be hidden), so every status has a home.
//!
//! GET: any project member (404 for an outsider). PUT: owner/admin (a
//! superuser counts), another member 403. PUT replaces the whole ordered list
//! under a `FOR UPDATE SKIP LOCKED` lock on the project row (409 `busy`) and a
//! `base_version` check (409 `stale`).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use umbral::orm::{ForeignKey, Q};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use taskflow_projects::models::{
    TaskflowProject, TaskflowProjectMember, TaskflowProjectRole, taskflow_project, taskflow_project_member,
};
use taskflow_projects::scope::can_access_project;

use crate::models::{TaskflowProjectStatus, TaskflowTask, TaskflowTaskStatus, taskflow_project_status, taskflow_task};

/// Every built-in status, in board order.
pub const KINDS: [&str; 7] = ["not_started", "in_progress", "paused", "blocked", "partial_done", "done", "archived"];
pub const MAX_COLUMNS: usize = 30;
const MAX_KEY: usize = 40;
const MAX_LABEL: usize = 40;
const BUSY: &str = "taskflow:statuses_busy";
const STALE: &str = "taskflow:statuses_stale";

type ApiError = (StatusCode, Json<Value>);
type TxError = Box<dyn std::error::Error + Send + Sync>;

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "project statuses failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

/// One column as served.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Column {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub position: i64,
    pub color: Option<String>,
    pub hidden: bool,
}

pub fn kind_str(k: TaskflowTaskStatus) -> String {
    serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// The columns of a project that has never edited them: one per kind, keyed by
/// the kind's name; archived hidden.
pub fn defaults() -> Vec<Column> {
    let labels = ["Not started", "In progress", "Paused", "Blocked", "Partially done", "Done", "Archived"];
    KINDS
        .iter()
        .zip(labels)
        .enumerate()
        .map(|(i, (k, l))| Column {
            key: (*k).into(),
            label: l.into(),
            kind: (*k).into(),
            position: i as i64,
            color: None,
            hidden: *k == "archived",
        })
        .collect()
}

/// The project's columns in order, and the list's version (0 = defaults).
pub async fn effective(project: i64) -> Result<(Vec<Column>, i64), sqlx::Error> {
    let rows = TaskflowProjectStatus::objects()
        .filter(taskflow_project_status::PROJECT.eq(project))
        .order_by(taskflow_project_status::POSITION.asc())
        .fetch()
        .await?;
    Ok(columns_of(rows))
}

fn columns_of(rows: Vec<TaskflowProjectStatus>) -> (Vec<Column>, i64) {
    if rows.is_empty() {
        return (defaults(), 0);
    }
    let version = rows.iter().map(|r| r.version).max().unwrap_or(0);
    let cols = rows
        .into_iter()
        .map(|r| Column { key: r.key, label: r.label, kind: kind_str(r.kind), position: r.position, color: r.color, hidden: r.hidden })
        .collect();
    (cols, version)
}

/// The column a task of `kind` falls back to: the first of that kind.
pub fn first_of<'a>(cols: &'a [Column], kind: &str) -> Option<&'a str> {
    cols.iter().filter(|c| c.kind == kind).min_by_key(|c| c.position).map(|c| c.key.as_str())
}

/// Where a task belongs: its own column if that is a column of its kind, else
/// the first column of its kind.
pub fn home_for<'a>(cols: &'a [Column], status: &str, current: Option<&'a str>) -> Option<&'a str> {
    if let Some(cur) = current {
        if cols.iter().any(|c| c.key == cur && c.kind == status) {
            return Some(cur);
        }
    }
    first_of(cols, status)
}

// ---------------------------------------------------------------- reconciler

/// Keep `status_column` valid after every task write. Called once from
/// `on_ready`. `post_save` (Manager::save: the MCP, reviews) and
/// `bulk_post_save` (REST PATCH/POST, `update_values`) both funnel here.
pub fn register() {
    umbral::signals::subscribe_async("post_save:taskflow_task", |payload| {
        let id = payload["instance"]["id"].as_i64();
        async move {
            if let Some(id) = id {
                reconcile(id).await;
            }
        }
    });
    umbral::signals::subscribe_async("bulk_post_save:taskflow_task", |payload| {
        let ids: Vec<i64> =
            payload["ids"].as_array().map(|a| a.iter().filter_map(|v| v.as_i64()).collect()).unwrap_or_default();
        async move {
            for id in ids {
                reconcile(id).await;
            }
        }
    });
}

/// Idempotent: a task already in a valid column is left alone (so the
/// re-fired signal of our own write ends here).
pub async fn reconcile(task_id: i64) {
    let Ok(Some(task)) = TaskflowTask::objects().filter(taskflow_task::ID.eq(task_id)).first().await else { return };
    let Ok((cols, _)) = effective(task.project.id()).await else { return };
    let status = kind_str(task.status);
    let Some(home) = home_for(&cols, &status, task.status_column.as_deref()) else { return };
    if task.status_column.as_deref() == Some(home) {
        return;
    }
    // Guarded on what we read: a concurrent move wins, and re-fires its own
    // reconcile.
    let seen = match task.status_column.as_deref() {
        Some(c) => taskflow_task::STATUS_COLUMN.eq(c),
        None => taskflow_task::STATUS_COLUMN.is_null(),
    };
    let mut v = serde_json::Map::new();
    v.insert("status_column".into(), json!(home));
    let changed = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id) & taskflow_task::STATUS.eq(status.as_str()) & seen)
        .update_values(v)
        .await
        .unwrap_or(0);
    if changed > 0 {
        if let Ok(Some(fresh)) = TaskflowTask::objects().filter(taskflow_task::ID.eq(task_id)).first().await {
            taskflow_projects::emit::emit_post_save(&fresh).await;
        }
    }
}

/// Boot: give every task without a column its home. Idempotent; after the
/// first boot it finds nothing.
pub async fn backfill() {
    let Ok(rows) = TaskflowTask::objects().filter(taskflow_task::STATUS_COLUMN.is_null()).fetch().await else { return };
    for t in rows {
        reconcile(t.id).await;
    }
}

// ---------------------------------------------------------------- handlers

async fn task_count(project: i64, cols: &[Column], c: &Column) -> Result<i64, sqlx::Error> {
    let mut n = TaskflowTask::objects()
        .filter(taskflow_task::PROJECT.eq(project) & taskflow_task::STATUS_COLUMN.eq(c.key.as_str()) & taskflow_task::STATUS.eq(c.kind.as_str()))
        .count()
        .await?;
    // Not reconciled yet (just written, or before the boot backfill): counted
    // where they will land.
    if first_of(cols, &c.kind) == Some(c.key.as_str()) {
        let keys: Vec<&str> = cols.iter().filter(|x| x.kind == c.kind).map(|x| x.key.as_str()).collect();
        n += TaskflowTask::objects()
            .filter(
                taskflow_task::PROJECT.eq(project)
                    & taskflow_task::STATUS.eq(c.kind.as_str())
                    & (taskflow_task::STATUS_COLUMN.is_null() | Q::not(taskflow_task::STATUS_COLUMN.in_(&keys))),
            )
            .count()
            .await?;
    }
    Ok(n)
}

async fn body(project: i64) -> Result<Value, ApiError> {
    let (cols, version) = effective(project).await.map_err(internal)?;
    let mut out = Vec::with_capacity(cols.len());
    for c in &cols {
        let n = task_count(project, &cols, c).await.map_err(internal)?;
        let mut v = serde_json::to_value(c).map_err(internal)?;
        v["task_count"] = json!(n);
        out.push(v);
    }
    Ok(json!({ "columns": out, "version": version, "custom": version > 0 }))
}

/// `GET /api/taskflow/projects/{project}/statuses`
pub async fn list(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>) -> Result<Response, ApiError> {
    if !can_access_project(user, project).await {
        return Err(err(StatusCode::NOT_FOUND, "not_found", "No such project."));
    }
    Ok(Json(body(project).await?).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnInput {
    pub key: String,
    pub label: String,
    pub kind: TaskflowTaskStatus,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutInput {
    pub columns: Vec<ColumnInput>,
    pub base_version: i64,
}

fn key_ok(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= MAX_KEY
        && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        && k.as_bytes()[0].is_ascii_alphanumeric()
}

fn color_ok(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validate and normalise the list. Positions are the list order.
pub fn validate(input: Vec<ColumnInput>) -> Result<Vec<Column>, ApiError> {
    let bad = |d: &str| err(StatusCode::BAD_REQUEST, "invalid", d);
    if input.is_empty() || input.len() > MAX_COLUMNS {
        return Err(bad("Between 1 and 30 columns."));
    }
    let mut out: Vec<Column> = Vec::with_capacity(input.len());
    for (i, c) in input.into_iter().enumerate() {
        let key = c.key.trim().to_string();
        if !key_ok(&key) {
            return Err(bad("A key is 1-40 characters of a-z, 0-9, _ and -, starting with a letter or digit."));
        }
        if out.iter().any(|o| o.key == key) {
            return Err(err(StatusCode::BAD_REQUEST, "duplicate_key", &format!("The key `{key}` is used twice.")));
        }
        let label = c.label.split_whitespace().collect::<Vec<_>>().join(" ");
        if label.is_empty() || label.chars().count() > MAX_LABEL || label.chars().any(char::is_control) {
            return Err(bad("A label is 1-40 characters."));
        }
        let color = c.color.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
        if color.as_deref().is_some_and(|s| !color_ok(s)) {
            return Err(bad("A color is #rrggbb."));
        }
        out.push(Column { key, label, kind: kind_str(c.kind), position: i as i64, color, hidden: c.hidden });
    }
    let missing: Vec<&str> = KINDS.iter().copied().filter(|k| !out.iter().any(|c| c.kind == *k)).collect();
    if !missing.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "kind_missing",
                "detail": "Every status needs at least one column (it can be hidden).",
                "missing": missing,
            })),
        ));
    }
    Ok(out)
}

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
            if su && exists {
                TaskflowProjectRole::Owner
            } else {
                return Err(err(StatusCode::NOT_FOUND, "not_found", "No such project."));
            }
        }
    };
    if !matches!(role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin) {
        return Err(err(StatusCode::FORBIDDEN, "owner_or_admin_only", "Only owners and admins can change the board's columns."));
    }
    Ok(())
}

/// `PUT /api/taskflow/projects/{project}/statuses`
pub async fn replace(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Json(input): Json<PutInput>) -> Result<Response, ApiError> {
    require_manager(user, project).await?;
    let cols = validate(input.columns)?;
    let base = input.base_version;
    let res = umbral::transaction(move |tx| {
        Box::pin(async move {
            let locked = TaskflowProject::objects()
                .filter(taskflow_project::ID.eq(project))
                .for_update_skip_locked()
                .on_tx(tx)
                .first()
                .await?;
            if locked.is_none() {
                return Err::<(), TxError>(BUSY.into());
            }
            let current = TaskflowProjectStatus::objects()
                .filter(taskflow_project_status::PROJECT.eq(project))
                .on_tx(tx)
                .fetch()
                .await?;
            let version = current.iter().map(|r| r.version).max().unwrap_or(0);
            if version != base {
                return Err(STALE.into());
            }
            TaskflowProjectStatus::objects().filter(taskflow_project_status::PROJECT.eq(project)).on_tx(tx).delete().await?;
            for c in &cols {
                let kind: TaskflowTaskStatus = serde_json::from_value(json!(c.kind))?;
                TaskflowProjectStatus::objects()
                    .on_tx(tx)
                    .create(TaskflowProjectStatus {
                        id: 0,
                        project: ForeignKey::new(project),
                        key: c.key.clone(),
                        label: c.label.clone(),
                        kind,
                        position: c.position,
                        color: c.color.clone(),
                        hidden: c.hidden,
                        version: version + 1,
                    })
                    .await?;
            }
            // Re-home tasks whose column is gone or now of another kind. Their
            // status is untouched.
            for kind in KINDS {
                let keys: Vec<&str> = cols.iter().filter(|c| c.kind == kind).map(|c| c.key.as_str()).collect();
                let home = first_of(&cols, kind).expect("validate keeps every kind");
                let mut v = serde_json::Map::new();
                v.insert("status_column".into(), json!(home));
                TaskflowTask::objects()
                    .filter(
                        taskflow_task::PROJECT.eq(project)
                            & taskflow_task::STATUS.eq(kind)
                            & (taskflow_task::STATUS_COLUMN.is_null() | Q::not(taskflow_task::STATUS_COLUMN.in_(&keys))),
                    )
                    .on_tx(tx)
                    .update_values(v)
                    .await?;
            }
            Ok(())
        })
    })
    .await;
    if let Err(e) = res {
        let s = e.to_string();
        return Err(if s.contains(BUSY) {
            err(StatusCode::CONFLICT, "busy", "The columns are being changed right now; try again in a moment.")
        } else if s.contains(STALE) {
            err(StatusCode::CONFLICT, "stale", "Someone else changed the columns; reload them and try again.")
        } else {
            internal(e)
        });
    }
    Ok(Json(body(project).await?).into_response())
}
