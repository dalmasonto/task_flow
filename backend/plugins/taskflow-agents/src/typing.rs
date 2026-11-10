//! #5988 item 6: "X is writing" (chat composer, design captions). Ephemeral:
//! no table, one realtime event.
//!
//! `POST /api/taskflow/channels/{c}/typing` (people) and
//! `POST /api/taskflow/agents/channels/{c}/typing` (agents), body
//! `{context?}` (`deny_unknown_fields`), answer `{published}`.
//!
//! * The caller must see the room (404 otherwise) and it must not be archived
//!   (409).
//! * The event is published server-side to `project:{p}:typing` as `typing`
//!   with `{channel, who: {kind, id}, label, context, until}`. Everything but
//!   `context` is derived on the server; `context` is validated: `kind` is
//!   `design_page` (`route` starts with `/`, at most 200 characters) or
//!   `design_comment` (`id` is a design comment of this project), else 400.
//! * **Private rooms (DM/Group) are accepted and dropped** (`published:
//!   false`): realtime groups are per project, so the event would tell the
//!   whole project who is typing in a private room (gaps6 #29).
//! * At most one event per (caller, room) per [`THROTTLE`], in memory per
//!   process, silently (`published: false`); the map evicts entries older than
//!   [`EVICT`], so it can't grow without bound.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use crate::agent_auth::RequireAgent;
use crate::models::{TaskflowAgentChannel, taskflow_agent_channel};

pub const THROTTLE: Duration = Duration::from_secs(2);
pub const EVICT: Duration = Duration::from_secs(10);
/// How long a client shows "is writing" after one event.
pub const SHOW_FOR_SECS: i64 = 6;
pub const SUFFIX: &str = "typing";
const MAX_ROUTE: usize = 200;

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "typing failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

fn last_sent() -> &'static Mutex<HashMap<(String, i64), Instant>> {
    static M: OnceLock<Mutex<HashMap<(String, i64), Instant>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True if `(who, channel)` may publish now (and records it). Evicts stale keys.
fn admit(who: &str, channel: i64) -> bool {
    let now = Instant::now();
    let mut m = last_sent().lock().unwrap_or_else(|p| p.into_inner());
    m.retain(|_, t| now.duration_since(*t) < EVICT);
    let key = (who.to_string(), channel);
    if m.get(&key).is_some_and(|t| now.duration_since(*t) < THROTTLE) {
        return false;
    }
    m.insert(key, now);
    true
}

/// True if `(who, channel)` sent within [`THROTTLE`] (read-only).
fn throttled(who: &str, channel: i64) -> bool {
    let now = Instant::now();
    let m = last_sent().lock().unwrap_or_else(|p| p.into_inner());
    m.get(&(who.to_string(), channel)).is_some_and(|t| now.duration_since(*t) < THROTTLE)
}

/// Test hook: forget the throttle state.
#[doc(hidden)]
pub fn reset_throttle() {
    last_sent().lock().unwrap_or_else(|p| p.into_inner()).clear();
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextInput {
    pub kind: String,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypingInput {
    #[serde(default)]
    pub context: Option<ContextInput>,
}

async fn design_comment_in(project: i64, id: i64) -> Result<bool, ApiError> {
    // taskflow-design depends on this crate, so its model can't be named here.
    let sql = "SELECT 1 FROM design_comment WHERE id = $1 AND project = $2";
    let pool = umbral::db::pool_dispatched();
    let found = match &pool {
        umbral::db::DbPool::Sqlite(p) => sqlx::query(sql).bind(id).bind(project).fetch_optional(p).await.map(|r| r.is_some()),
        umbral::db::DbPool::Postgres(p) => sqlx::query(sql).bind(id).bind(project).fetch_optional(p).await.map(|r| r.is_some()),
    };
    found.map_err(internal)
}

async fn context_json(project: i64, c: Option<ContextInput>) -> Result<Value, ApiError> {
    let Some(c) = c else { return Ok(Value::Null) };
    let bad = |d: &str| err(StatusCode::BAD_REQUEST, "invalid_context", d);
    match c.kind.as_str() {
        "design_page" => {
            let route = c.route.unwrap_or_default();
            if c.id.is_some() || !route.starts_with('/') || route.chars().count() > MAX_ROUTE || route.chars().any(char::is_control) {
                return Err(bad("A design_page context is {route}: starts with /, at most 200 characters."));
            }
            Ok(json!({ "kind": "design_page", "route": route }))
        }
        "design_comment" => {
            let Some(id) = c.id.filter(|_| c.route.is_none()) else {
                return Err(bad("A design_comment context is {id}."));
            };
            if !design_comment_in(project, id).await? {
                return Err(bad("No such design comment in this project."));
            }
            Ok(json!({ "kind": "design_comment", "id": id }))
        }
        _ => Err(bad("context.kind is design_page or design_comment.")),
    }
}

async fn publish(channel: TaskflowAgentChannel, who_kind: &str, who_id: i64, label: String, context: Option<ContextInput>) -> Result<Response, ApiError> {
    if channel.archived {
        return Err(err(StatusCode::CONFLICT, "archived", "This room is archived."));
    }
    let project = channel.project.id();
    if channel.kind.is_private() {
        return Ok(Json(json!({ "published": false })).into_response());
    }
    // Validate before admitting, so a bad context isn't charged a throttle
    // slot; but a throttled call never reaches the context's SELECT (#5999).
    let key = format!("{who_kind}:{who_id}");
    if throttled(&key, channel.id) {
        return Ok(Json(json!({ "published": false })).into_response());
    }
    let context = context_json(project, context).await?;
    if !admit(&key, channel.id) {
        return Ok(Json(json!({ "published": false })).into_response());
    }
    let until = chrono::Utc::now() + chrono::Duration::seconds(SHOW_FOR_SECS);
    let event = json!({
        "channel": channel.id,
        "who": { "kind": who_kind, "id": who_id },
        "label": label,
        "context": context,
        "until": until,
    });
    umbral_realtime::Realtime::to_group(format!("project:{project}:{SUFFIX}")).send("typing", &event).await;
    Ok(Json(json!({ "published": true })).into_response())
}

/// `POST /api/taskflow/channels/{channel}/typing`
pub async fn user_typing(RequireAuth(user): RequireAuth<i64>, Path(channel): Path<i64>, Json(i): Json<TypingInput>) -> Result<Response, ApiError> {
    let c = crate::views::ensure_channel_visible(user, channel).await.map_err(|_| err(StatusCode::NOT_FOUND, "not_found", "No such room."))?;
    let label = crate::pins::person_label(user, c.project.id()).await?;
    publish(c, "user", user, label, i.context).await
}

/// `POST /api/taskflow/agents/channels/{channel}/typing`
pub async fn agent_typing(RequireAgent(a): RequireAgent, Path(channel): Path<i64>, Json(i): Json<TypingInput>) -> Result<Response, ApiError> {
    let c = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "No such room."))?;
    let ok = crate::views::agent_can_see_channel(&c, a.agent_id, a.project_id).await.map_err(|_| err(StatusCode::NOT_FOUND, "not_found", "No such room."))?;
    if !ok {
        return Err(err(StatusCode::NOT_FOUND, "not_found", "No such room."));
    }
    publish(c, "agent", a.agent_id, a.display_name.clone(), i.context).await
}
