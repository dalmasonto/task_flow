//! #1078: an agent's display name, provider and model.
//!
//! `PATCH /api/taskflow/agents/{agent}` `{display_name?, provider?, model?}`
//! (`deny_unknown_fields`). Who: the same rule as driving it
//! (`may_drive_agent`: owner/admin, its linked human, a superuser); another
//! member 403, outside the project 404.
//!
//! **A rename does not change `identifier`.** The agent keeps its id, keys and
//! history; re-linking matches the identifier, so linking again with the NEW
//! name makes a new agent.
//!
//! **Display names are unique within a project** (trimmed, case-insensitive;
//! 409 `name_taken`), checked here and on link/create ([`name_taken`]). Chat,
//! inbox and activity show `display_name`, so a second "reviewer (codex)" would
//! read as the real one.
//!
//! Agents don't self-report `provider`/`model` yet (that needs an MCP
//! release); when they do, the human's edit wins: a report fills a field only
//! while it's null.

use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use crate::models::{TaskflowAgent, taskflow_agent};

pub const PROVIDERS: [&str; 4] = ["anthropic", "openai", "google", "other"];

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, field: Option<&str>, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "field": field, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "agent profile write failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", None, "internal error")
}

fn norm(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Is `name` already another agent's display name in `project`? Trimmed and
/// case-insensitive. `except` is the agent being renamed or re-linked.
pub async fn name_taken(project: i64, name: &str, except: Option<i64>) -> Result<bool, StatusCode> {
    let want = norm(name);
    let agents = TaskflowAgent::objects()
        .filter(taskflow_agent::PROJECT.eq(project))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(agents.iter().any(|a| Some(a.id) != except && norm(&a.display_name) == want))
}

pub fn name_taken_response() -> Response {
    err(
        StatusCode::CONFLICT,
        "name_taken",
        Some("display_name"),
        "Another agent in this project already has that name. Pick another, so nobody mistakes one for the other.",
    )
    .into_response()
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileInput {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub provider: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub model: Option<Option<String>>,
}

/// `PATCH /api/taskflow/agents/{agent}`
pub async fn patch(RequireAuth(user): RequireAuth<i64>, Path(agent_id): Path<i64>, Json(input): Json<ProfileInput>) -> Result<Response, ApiError> {
    let not_found = || err(StatusCode::NOT_FOUND, "not_found", None, "No such agent.");
    let agent = TaskflowAgent::objects().filter(taskflow_agent::ID.eq(agent_id)).first().await.map_err(internal)?.ok_or_else(not_found)?;
    if !taskflow_projects::scope::can_access_project(user, agent.project.id()).await {
        return Err(not_found());
    }
    let allowed = crate::views::may_drive_agent(user, &agent).await.map_err(|s| err(s, "internal", None, "internal error"))?;
    if !allowed {
        return Err(err(
            StatusCode::FORBIDDEN,
            "not_allowed_to_edit_agent",
            None,
            "Only the project's owners and admins, or the person who linked this agent, can change it.",
        ));
    }

    let mut v = serde_json::Map::new();
    if let Some(name) = input.display_name {
        let name = name.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("display_name"), "1 to 80 characters."));
        }
        if name != agent.display_name {
            if name_taken(agent.project.id(), &name, Some(agent.id)).await.map_err(|s| err(s, "internal", None, "internal error"))? {
                return Ok(name_taken_response());
            }
            v.insert("display_name".into(), json!(name));
        }
    }
    if let Some(p) = input.provider {
        let p = p.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        if p.as_deref().is_some_and(|p| !PROVIDERS.contains(&p)) {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("provider"), "One of anthropic, openai, google or other."));
        }
        v.insert("provider".into(), json!(p));
    }
    if let Some(m) = input.model {
        let m = m.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if m.as_ref().is_some_and(|m| m.chars().count() > 80 || m.chars().any(char::is_control)) {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", Some("model"), "At most 80 characters."));
        }
        v.insert("model".into(), json!(m));
    }
    if v.is_empty() {
        return Ok(Json(agent).into_response());
    }
    let renamed_from = v.contains_key("display_name").then(|| agent.display_name.clone());
    // Guarded on the name we checked, so a rename of THIS agent in between is
    // a 409. Two different agents taking one new name in the same instant is
    // still possible (the check is a read); closing that needs a unique index
    // on a normalized name column.
    let mut q = TaskflowAgent::objects().filter(taskflow_agent::ID.eq(agent.id));
    if let Some(old) = &renamed_from {
        q = q.filter(taskflow_agent::DISPLAY_NAME.eq(old.as_str()));
    }
    let n = q.update_values(v).await.map_err(internal)?;
    if n == 0 {
        return Err(err(StatusCode::CONFLICT, "changed", None, "The agent changed meanwhile; reload."));
    }
    let fresh = TaskflowAgent::objects().filter(taskflow_agent::ID.eq(agent.id)).first().await.map_err(internal)?.ok_or_else(not_found)?;
    crate::emit::emit_post_save(&fresh).await;
    Ok(Json(fresh).into_response())
}
