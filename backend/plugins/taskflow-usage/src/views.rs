//! HTTP handlers for `taskflow-usage` (#1115). Rules live in `service.rs`.
//!
//! - Agents REPORT (`POST /agents/usage`, `activity:write`) and read their
//!   project's usage. The body is counts only (see `service::ReportInput`).
//! - Members READ usage, prices and settings. Owners and admins EDIT the
//!   budget, the alerts and the project's prices.

use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_agents::agent_auth::RequireAgent;

use crate::service::{self, ApiError, PriceInput, SettingsInput, UsageQuery, err};

type Reply = Result<Response, ApiError>;

async fn member(user: i64, project: i64) -> Result<(), ApiError> {
    if taskflow_projects::scope::can_access_project(user, project).await {
        Ok(())
    } else {
        Err(err(StatusCode::NOT_FOUND, "project"))
    }
}

async fn manager(user: i64, project: i64) -> Result<String, ApiError> {
    member(user, project).await?;
    if !service::is_manager(user, project).await {
        return Err(err(StatusCode::FORBIDDEN, "owners_and_admins_only"));
    }
    use umbral_auth::auth_user;
    Ok(umbral_auth::AuthUser::objects()
        .filter(auth_user::ID.eq(user))
        .first()
        .await
        .ok()
        .flatten()
        .map(|u| u.username)
        .unwrap_or_else(|| format!("user {user}")))
}

/// Body as raw JSON, so a malformed or over-wide body is OUR 400 naming the
/// field (axum's own extractor would answer 422 without saying which).
fn parse<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, ApiError> {
    serde_json::from_value(body).map_err(|e| {
        let msg = e.to_string();
        let field = msg.split('`').nth(1).unwrap_or("body").to_string();
        service::bad(&field, &msg)
    })
}

pub async fn report_as_agent(RequireAgent(agent): RequireAgent, Json(body): Json<Value>) -> Reply {
    agent
        .require(taskflow_agents::scopes::ACTIVITY_WRITE)
        .map_err(taskflow_agents::scopes::CapabilityError::into_status_json)?;
    let input = service::parse_report(body)?;
    let (created, report) = service::ingest(agent.project_id, agent.agent_id, input).await?;
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    Ok((status, Json(report)).into_response())
}

pub async fn usage_as_agent(RequireAgent(agent): RequireAgent, Query(q): Query<UsageQuery>) -> Reply {
    Ok(Json(service::usage(agent.project_id, &q).await?).into_response())
}

pub async fn usage(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Query(q): Query<UsageQuery>) -> Reply {
    member(user, project).await?;
    Ok(Json(service::usage(project, &q).await?).into_response())
}

pub async fn get_settings(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>) -> Reply {
    member(user, project).await?;
    let s = service::settings_for(project).await?;
    Ok(Json(json!({ "settings": service::settings_json(&s), "can_edit": service::is_manager(user, project).await })).into_response())
}

pub async fn save_settings(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Json(body): Json<Value>) -> Reply {
    let label = manager(user, project).await?;
    let input: SettingsInput = parse(body)?;
    Ok(Json(service::save_settings(project, user, &label, input).await?).into_response())
}

pub async fn prices(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>) -> Reply {
    member(user, project).await?;
    Ok(Json(service::prices(project).await?).into_response())
}

pub async fn save_price(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Json(body): Json<Value>) -> Reply {
    let label = manager(user, project).await?;
    let input: PriceInput = parse(body)?;
    Ok(Json(service::save_price(project, &label, input).await?).into_response())
}
