//! #1137: the ONE way to edit a project's settings.
//!
//! auto-REST `taskflow_project` used to keep `Update`, and its project scope
//! admits every active member, so a viewer could rename or archive a project,
//! repoint `default_api_base_url` (what agents test against), or set
//! `github_linked_by` to the owner and `github_repo` to any repo, so the next
//! publish spent the owner's GitHub token there. REST is read-only now; this
//! handler is the writer.
//!
//! `PATCH /api/taskflow/projects/{project}` (owner or admin) takes ONLY
//! `{name?, slug?, description_markdown?, repository_url?,
//! default_api_base_url?, status?}` (`deny_unknown_fields`). Archiving, or
//! bringing a project back from archived, needs an owner. `github_*` columns
//! are written only by the GitHub routes; `owner` never from a client.

use chrono::Utc;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use crate::models::{
    TaskflowProject, TaskflowProjectMember, TaskflowProjectRole, TaskflowProjectStatus, taskflow_project,
    taskflow_project_member,
};

pub(crate) type ApiError = (StatusCode, Json<Value>);

pub(crate) fn err(status: StatusCode, code: &str, field: Option<&str>, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "field": field, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "project edit failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", None, "internal error")
}

/// Absent → `None`; `null` → `Some(None)`; a value → `Some(Some(v))`.
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub description_markdown: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub repository_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub default_api_base_url: Option<Option<String>>,
    #[serde(default)]
    pub status: Option<TaskflowProjectStatus>,
}

fn status_str(s: TaskflowProjectStatus) -> String {
    serde_json::to_value(s).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// An http(s) URL of at most 400 characters, or none.
pub(crate) fn check_url_max(field: &str, v: Option<String>, max: usize) -> Result<Option<String>, ApiError> {
    let v = v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(u) = &v {
        let ok = u.len() <= max
            && (u.starts_with("https://") || u.starts_with("http://"))
            && !u.chars().any(|c| c.is_whitespace() || c.is_control());
        if !ok {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", Some(field), &format!("An http(s) address, at most {max} characters.")));
        }
    }
    Ok(v)
}

fn check_url(field: &str, v: Option<String>) -> Result<Option<String>, ApiError> {
    check_url_max(field, v, 400)
}

fn valid_slug(s: &str) -> bool {
    (2..=120).contains(&s.len())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// `PATCH /api/taskflow/projects/{project}`
pub async fn patch_project(
    RequireAuth(user): RequireAuth<i64>,
    Path(project): Path<i64>,
    Json(input): Json<ProjectPatch>,
) -> Result<Response, ApiError> {
    let is_superuser = AuthUser::objects()
        .filter(auth_user::ID.eq(user))
        .first()
        .await
        .map_err(internal)?
        .is_some_and(|u| u.is_superuser);
    let me = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project)
                & taskflow_project_member::USER.eq(user)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(internal)?;
    let role = match (&me, is_superuser) {
        (Some(m), _) => m.role,
        (None, true) => TaskflowProjectRole::Owner,
        (None, false) => return Err(err(StatusCode::NOT_FOUND, "not_found", None, "No such project.")),
    };
    if !matches!(role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin) {
        return Err(err(StatusCode::FORBIDDEN, "owner_or_admin_only", None, "Only owners and admins can change project settings."));
    }
    let current = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", None, "No such project."))?;

    let mut v = serde_json::Map::new();
    if let Some(name) = input.name {
        let name = name.trim().to_string();
        if name.is_empty() || name.chars().count() > 160 {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("name"), "1 to 160 characters."));
        }
        v.insert("name".into(), json!(name));
    }
    if let Some(slug) = input.slug {
        let slug = slug.trim().to_lowercase();
        if !valid_slug(&slug) {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("slug"), "2 to 120 lowercase letters, digits and dashes."));
        }
        if slug != current.slug {
            let taken = TaskflowProject::objects()
                .filter(taskflow_project::SLUG.eq(slug.as_str()) & taskflow_project::ID.ne(project))
                .first()
                .await
                .map_err(internal)?
                .is_some();
            if taken {
                return Err(err(StatusCode::CONFLICT, "slug_taken", Some("slug"), "Another project uses that address."));
            }
            v.insert("slug".into(), json!(slug));
        }
    }
    if let Some(d) = input.description_markdown {
        if d.chars().count() > 4000 {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("description_markdown"), "At most 4000 characters."));
        }
        v.insert("description_markdown".into(), json!(d.trim()));
    }
    if let Some(u) = input.repository_url {
        v.insert("repository_url".into(), json!(check_url("repository_url", u)?));
    }
    if let Some(u) = input.default_api_base_url {
        v.insert("default_api_base_url".into(), json!(check_url("default_api_base_url", u)?));
    }
    if let Some(status) = input.status {
        let touches_archive = status == TaskflowProjectStatus::Archived || current.status == TaskflowProjectStatus::Archived;
        if status != current.status && touches_archive && role != TaskflowProjectRole::Owner {
            return Err(err(StatusCode::FORBIDDEN, "owner_only", Some("status"), "Only an owner can archive a project or bring it back."));
        }
        v.insert("status".into(), json!(status_str(status)));
    }
    // Nothing to change (`{}`, or only values equal to what's stored for slug):
    // no write, no read-back, no `post_save` (#1137 review nit).
    if v.is_empty() {
        return Ok(Json(current).into_response());
    }
    {
        v.insert("updated_at".into(), json!(Utc::now()));
        TaskflowProject::objects()
            .filter(taskflow_project::ID.eq(project))
            .update_values(v)
            .await
            .map_err(|e| {
                if e.to_string().to_lowercase().contains("unique") {
                    err(StatusCode::CONFLICT, "slug_taken", Some("slug"), "Another project uses that address.")
                } else {
                    internal(e)
                }
            })?;
    }
    let fresh = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", None, "No such project."))?;
    crate::emit::emit_post_save(&fresh).await;
    Ok(Json(fresh).into_response())
}
