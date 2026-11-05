//! Human routes (#885), under `/api/db/{project}/...`: read the schema, save
//! it (every field you change becomes yours and locked), list and read
//! versions, restore one. Membership-gated like the design routes.

use serde::Deserialize;
use serde_json::json;
use umbral::web::{IntoResponse, Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_projects::scope::can_access_project;

use crate::schema_doc::{Author, SchemaDoc, apply_human_save};
use crate::store::{self, Current, SaveError};

/// One mapping from a refused save to its response, shared with the agent
/// routes so both sides read the same errors.
pub fn save_error(err: SaveError) -> Response {
    match err {
        SaveError::Stale { current } => (
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": "version_conflict",
                "message": "The schema changed since you read it. Read it again, merge, and retry with the new base_version.",
                "current_version": current,
            })),
        )
            .into_response(),
        SaveError::Invalid(errors) => (
            StatusCode::BAD_REQUEST,
            // `message` carries the problems too: an agent's tool shows only the
            // envelope's sentence, and "invalid_schema" alone says nothing.
            Json(json!({ "ok": false, "error": "invalid_schema", "message": errors.join("; "), "errors": errors })),
        )
            .into_response(),
        SaveError::Locked(conflict) => (
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": "locked_by_user",
                "message": format!(
                    "A person changed {} on `{}`, so it is locked. Ask them first; resend with override: true only if they agreed.",
                    conflict.fields.iter().map(|f| format!("`{f}`")).collect::<Vec<_>>().join(", "),
                    conflict.model,
                ),
                "model": conflict.model,
                "fields": conflict.fields,
            })),
        )
            .into_response(),
        SaveError::NotFound(what) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "not_found", "message": what })),
        )
            .into_response(),
        SaveError::Db(e) => {
            eprintln!("taskflow-db: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub fn current_json(c: &Current) -> serde_json::Value {
    json!({
        "version": c.version,
        "doc": c.doc,
        "updated_by": c.updated_by,
        "updated_by_label": c.updated_by_label,
        "updated_at": c.updated_at,
    })
}

async fn username(user_id: i64) -> String {
    umbral_auth::AuthUser::objects()
        .filter(umbral_auth::auth_user::ID.eq(user_id))
        .first()
        .await
        .ok()
        .flatten()
        .map(|u| u.username)
        .unwrap_or_else(|| format!("user {user_id}"))
}

async fn gate(user_id: i64, project_id: i64) -> Result<(), Response> {
    if can_access_project(user_id, project_id).await {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN.into_response())
    }
}

/// `GET /api/db/{project}/schema`
pub async fn get_schema(RequireAuth(user_id): RequireAuth<i64>, Path(project_id): Path<i64>) -> Response {
    if let Err(r) = gate(user_id, project_id).await {
        return r;
    }
    match store::load(project_id).await {
        Ok(c) => Json(current_json(&c)).into_response(),
        Err(e) => save_error(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct SaveInput {
    pub base_version: i64,
    pub doc: SchemaDoc,
}

/// `PUT /api/db/{project}/schema` — the human's save. Fields that differ from
/// the current document become written by this user and locked.
pub async fn put_schema(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<SaveInput>,
) -> Response {
    if let Err(r) = gate(user_id, project_id).await {
        return r;
    }
    let label = username(user_id).await;
    let who = Author::user(user_id, &label);
    let res = store::save(project_id, Some(input.base_version), &format!("user:{user_id}"), &label, |prev| {
        let next = apply_human_save(prev, input.doc, &who);
        let changed = next
            .models
            .iter()
            .flat_map(|m| m.fields.iter())
            .filter(|f| f.written_by.as_ref() == Some(&who))
            .count();
        Ok((next, format!("{label} edited the schema ({changed} field(s) now theirs)")))
    })
    .await;
    match res {
        Ok(c) => Json(current_json(&c)).into_response(),
        Err(e) => save_error(e),
    }
}

/// `GET /api/db/{project}/versions` — newest first.
pub async fn list_versions(RequireAuth(user_id): RequireAuth<i64>, Path(project_id): Path<i64>) -> Response {
    if let Err(r) = gate(user_id, project_id).await {
        return r;
    }
    match store::list_versions(project_id).await {
        Ok(v) => Json(json!({ "versions": v })).into_response(),
        Err(e) => save_error(e),
    }
}

/// `GET /api/db/{project}/versions/{version}`
pub async fn read_version(
    RequireAuth(user_id): RequireAuth<i64>,
    Path((project_id, version)): Path<(i64, i64)>,
) -> Response {
    if let Err(r) = gate(user_id, project_id).await {
        return r;
    }
    match store::read_version(project_id, version).await {
        Ok(Some(doc)) => Json(json!({ "version": version, "doc": doc })).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => save_error(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct RestoreInput {
    pub version: i64,
    pub base_version: i64,
}

/// `POST /api/db/{project}/restore` — bring an old version back as a new one.
/// It is a human save, so whatever it changes becomes theirs and locked.
pub async fn restore(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Json(input): Json<RestoreInput>,
) -> Response {
    if let Err(r) = gate(user_id, project_id).await {
        return r;
    }
    let old = match store::read_version(project_id, input.version).await {
        Ok(Some(doc)) => doc,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return save_error(e),
    };
    let label = username(user_id).await;
    let who = Author::user(user_id, &label);
    let res = store::save(project_id, Some(input.base_version), &format!("user:{user_id}"), &label, |prev| {
        Ok((apply_human_save(prev, old, &who), format!("{label} restored v{}", input.version)))
    })
    .await;
    match res {
        Ok(c) => Json(current_json(&c)).into_response(),
        Err(e) => save_error(e),
    }
}

/// `GET /api/db/{project}/room` — the database chat room (created on first use).
pub async fn get_room(RequireAuth(user_id): RequireAuth<i64>, Path(project_id): Path<i64>) -> Response {
    if let Err(r) = gate(user_id, project_id).await {
        return r;
    }
    match crate::room::ensure_db_room(project_id).await {
        Ok(ch) => Json(json!({ "channel_id": ch.id, "title": ch.title })).into_response(),
        Err(e) => save_error(SaveError::Db(e)),
    }
}
