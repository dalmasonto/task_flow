//! HTTP handlers for `taskflow-decisions` (#1094).
//!
//! Handlers resolve WHO is calling and nothing else; the rules live in
//! `service.rs`. Two surfaces:
//!
//! - **Human** (`/api/taskflow/decisions/{project}/…`, bearer or session):
//!   every caller must be an active project member. Humans may also rule and
//!   supersede.
//! - **Agent** (`/api/taskflow/agents/decisions/…`, `Agent <key>`): the
//!   credential pins the project. Writes need the `tasks:write` capability.
//!   There is NO rule and NO supersede route here, by design.

use serde::Deserialize;
use serde_json::Value;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_agents::agent_auth::{AgentIdentity, RequireAgent};

use crate::service::{self, Actor, ApiError, AskInput, ListFilter, OptionInput, err};

type Reply = Result<Response, ApiError>;

fn ok(value: Value) -> Reply {
    Ok(Json(value).into_response())
}

fn created(value: Value) -> Reply {
    Ok((StatusCode::CREATED, Json(value)).into_response())
}

async fn member(user: i64, project: i64) -> Result<Actor, ApiError> {
    if !taskflow_projects::scope::can_access_project(user, project).await {
        // A project the caller cannot see answers like one that does not exist.
        return Err(err(StatusCode::NOT_FOUND, "project"));
    }
    Ok(Actor::User { id: user, label: user_label(user).await })
}

async fn user_label(user_id: i64) -> String {
    use umbral_auth::auth_user;
    umbral_auth::AuthUser::objects()
        .filter(auth_user::ID.eq(user_id))
        .first()
        .await
        .ok()
        .flatten()
        .map(|u| if u.username.trim().is_empty() { u.email } else { u.username })
        .unwrap_or_else(|| format!("user {user_id}"))
}

fn agent_actor(agent: &AgentIdentity) -> Actor {
    Actor::Agent { id: agent.agent_id, label: agent.display_name.clone() }
}

fn require_write(agent: &AgentIdentity) -> Result<(), ApiError> {
    agent
        .require(taskflow_agents::scopes::TASKS_WRITE)
        .map_err(taskflow_agents::scopes::CapabilityError::into_status_json)
}

#[derive(Deserialize)]
pub struct CommentInput {
    pub body_markdown: String,
}

#[derive(Deserialize)]
pub struct LinkInput {
    pub task_id: i64,
    /// `true` (default) links, `false` unlinks.
    #[serde(default = "yes")]
    pub link: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
pub struct RecommendInput {
    pub option_id: i64,
}

#[derive(Deserialize)]
pub struct RuleInput {
    pub option_id: i64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Deserialize)]
pub struct SupersedeInput {
    /// Key of the open decision that replaces this one.
    pub by: String,
}

// ---------------------------------------------------------------------------
// Human surface
// ---------------------------------------------------------------------------

pub async fn list(
    RequireAuth(user): RequireAuth<i64>,
    Path(project): Path<i64>,
    Query(filter): Query<ListFilter>,
) -> Reply {
    member(user, project).await?;
    ok(service::list(project, &filter, Some(user)).await?)
}

pub async fn blocking(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>) -> Reply {
    member(user, project).await?;
    ok(service::blocking(project).await?)
}

pub async fn ask(
    RequireAuth(user): RequireAuth<i64>,
    Path(project): Path<i64>,
    Json(input): Json<AskInput>,
) -> Reply {
    let actor = member(user, project).await?;
    created(service::ask(project, &actor, input).await?)
}

pub async fn get(RequireAuth(user): RequireAuth<i64>, Path((project, key)): Path<(i64, String)>) -> Reply {
    member(user, project).await?;
    let d = service::find(project, &key).await?;
    ok(service::decision_json(&d, true).await?)
}

pub async fn add_option(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, key)): Path<(i64, String)>,
    Json(input): Json<OptionInput>,
) -> Reply {
    let actor = member(user, project).await?;
    let d = service::find(project, &key).await?;
    created(service::add_option(d, &actor, input).await?)
}

pub async fn recommend(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, key)): Path<(i64, String)>,
    Json(input): Json<RecommendInput>,
) -> Reply {
    let actor = member(user, project).await?;
    let d = service::find(project, &key).await?;
    ok(service::recommend(d, &actor, input.option_id).await?)
}

pub async fn comment(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, key)): Path<(i64, String)>,
    Json(input): Json<CommentInput>,
) -> Reply {
    let actor = member(user, project).await?;
    let d = service::find(project, &key).await?;
    created(service::comment(d, &actor, input.body_markdown).await?)
}

pub async fn link(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, key)): Path<(i64, String)>,
    Json(input): Json<LinkInput>,
) -> Reply {
    let actor = member(user, project).await?;
    let d = service::find(project, &key).await?;
    ok(service::set_link(d, &actor, input.task_id, input.link).await?)
}

pub async fn rule(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, key)): Path<(i64, String)>,
    Json(input): Json<RuleInput>,
) -> Reply {
    let actor = member(user, project).await?;
    let d = service::find(project, &key).await?;
    ok(service::rule(d, user, actor.label(), input.option_id, input.note).await?)
}

pub async fn supersede(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, key)): Path<(i64, String)>,
    Json(input): Json<SupersedeInput>,
) -> Reply {
    let actor = member(user, project).await?;
    let d = service::find(project, &key).await?;
    ok(service::supersede(d, input.by.trim(), user, actor.label()).await?)
}

// ---------------------------------------------------------------------------
// Agent surface (no rule, no supersede)
// ---------------------------------------------------------------------------

pub async fn agent_list(RequireAgent(agent): RequireAgent, Query(filter): Query<ListFilter>) -> Reply {
    ok(service::list(agent.project_id, &filter, None).await?)
}

pub async fn agent_ask(RequireAgent(agent): RequireAgent, Json(input): Json<AskInput>) -> Reply {
    require_write(&agent)?;
    created(service::ask(agent.project_id, &agent_actor(&agent), input).await?)
}

/// `is_ruled`: the whole record, with `is_ruled`, `ruled_option` and the note.
pub async fn agent_get(RequireAgent(agent): RequireAgent, Path(key): Path<String>) -> Reply {
    let d = service::find(agent.project_id, &key).await?;
    ok(service::decision_json(&d, true).await?)
}

pub async fn agent_add_option(
    RequireAgent(agent): RequireAgent,
    Path(key): Path<String>,
    Json(input): Json<OptionInput>,
) -> Reply {
    require_write(&agent)?;
    let d = service::find(agent.project_id, &key).await?;
    created(service::add_option(d, &agent_actor(&agent), input).await?)
}

pub async fn agent_recommend(
    RequireAgent(agent): RequireAgent,
    Path(key): Path<String>,
    Json(input): Json<RecommendInput>,
) -> Reply {
    require_write(&agent)?;
    let d = service::find(agent.project_id, &key).await?;
    ok(service::recommend(d, &agent_actor(&agent), input.option_id).await?)
}

pub async fn agent_comment(
    RequireAgent(agent): RequireAgent,
    Path(key): Path<String>,
    Json(input): Json<CommentInput>,
) -> Reply {
    require_write(&agent)?;
    let d = service::find(agent.project_id, &key).await?;
    created(service::comment(d, &agent_actor(&agent), input.body_markdown).await?)
}

pub async fn agent_link(
    RequireAgent(agent): RequireAgent,
    Path(key): Path<String>,
    Json(input): Json<LinkInput>,
) -> Reply {
    require_write(&agent)?;
    let d = service::find(agent.project_id, &key).await?;
    ok(service::set_link(d, &agent_actor(&agent), input.task_id, input.link).await?)
}
