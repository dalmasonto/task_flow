//! #5955: a person's Resolve and Reopen (design--comments, design--pin).
//!
//! | Route | Returns |
//! |---|---|
//! | `POST /api/design/{p}/comments/{id}/resolve` | 200 comment |
//! | `POST /api/design/{p}/comments/{id}/reopen` | 200 comment |
//!
//! Any project member. **Resolve** moves an open, sent or addressed comment
//! to `resolved` and records who and when; **reopen** moves a resolved or
//! dismissed one back to `sent` when it was handed to an agent, else `open`,
//! and clears the resolution. Both are compare-and-set writes through
//! `comment_write` (409 `changed` if it moved meanwhile; 404 `not_found`). An
//! agent's own resolve stops at `addressed`; only a person makes it Done.

use chrono::Utc;
use serde_json::{Value, json};
use umbral::web::{IntoResponse, Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use taskflow_projects::scope::can_access_project;

use crate::comment_write::{WriteError, status_str, write};
use crate::models::{CommentStatus, DesignComment, design_comment};

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

fn from_write(e: WriteError) -> ApiError {
    match e {
        WriteError::NotFound => err(StatusCode::NOT_FOUND, "not_found"),
        WriteError::Conflict => err(StatusCode::CONFLICT, "changed"),
        WriteError::Internal => err(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    }
}

/// A person's label in the project: their member name, else their username.
pub async fn person_label(user: i64, project: i64) -> String {
    let name = TaskflowProjectMember::objects()
        .filter(taskflow_project_member::PROJECT.eq(project) & taskflow_project_member::USER.eq(user))
        .first()
        .await
        .ok()
        .flatten()
        .map(|m| m.display_name)
        .filter(|n| !n.trim().is_empty());
    match name {
        Some(n) => n,
        None => AuthUser::objects()
            .filter(auth_user::ID.eq(user))
            .first()
            .await
            .ok()
            .flatten()
            .map(|u| u.username)
            .unwrap_or_else(|| format!("user {user}")),
    }
}

async fn member(user: i64, project: i64) -> Result<(), ApiError> {
    if can_access_project(user, project).await {
        Ok(())
    } else {
        Err(err(StatusCode::NOT_FOUND, "not_found"))
    }
}

/// `POST /api/design/{project}/comments/{id}/resolve`
pub async fn resolve(RequireAuth(user): RequireAuth<i64>, Path((project, id)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    member(user, project).await?;
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!(status_str(CommentStatus::Resolved)));
    v.insert("resolved_by_label".into(), json!(person_label(user, project).await));
    v.insert("resolved_at".into(), json!(Utc::now()));
    let row = write(project, id, Some(&[CommentStatus::Open, CommentStatus::Sent, CommentStatus::Addressed]), v)
        .await
        .map_err(from_write)?;
    Ok(Json(row).into_response())
}

/// `POST /api/design/{project}/comments/{id}/reopen`
pub async fn reopen(RequireAuth(user): RequireAuth<i64>, Path((project, id)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    member(user, project).await?;
    let current = DesignComment::objects()
        .filter(design_comment::PROJECT.eq(project) & design_comment::ID.eq(id))
        .first()
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let back = if current.sent_to_agent.is_some() { CommentStatus::Sent } else { CommentStatus::Open };
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!(status_str(back)));
    v.insert("resolved_by_label".into(), Value::Null);
    v.insert("resolved_at".into(), Value::Null);
    let row = write(project, id, Some(&[CommentStatus::Resolved, CommentStatus::Dismissed]), v).await.map_err(from_write)?;
    Ok(Json(row).into_response())
}
