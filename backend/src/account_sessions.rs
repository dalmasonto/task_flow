//! #1134 (1): "Where you're logged in". A person lists and ends their own
//! bearer tokens and cookie sessions. Caller-only: every route reads the
//! caller from the auth gate, and an id that isn't theirs is a 404.
//!
//! | Route | |
//! |---|---|
//! | `GET /api/taskflow/me/sessions` | `{results: [{id, kind, name, created_at, last_used_at, expires_at, user_agent, current}]}` |
//! | `DELETE /api/taskflow/me/sessions/{id}` | end one (yours only; ending the current one signs you out) |
//! | `POST /api/taskflow/me/sessions/revoke-others` | end every other token and session, keep the current one |
//!
//! **Ids.** A token is `t<row id>`. A cookie session is `s<first 32 hex of
//! sha256(stored id)>`. umbral-sessions already stores only sha256(cookie),
//! so the cookie secret is never here; the extra hash keeps even the stored
//! id private, which is enough to name a row.
//!
//! **What is stored.** Tokens carry `created_at` and a coalesced
//! `last_used_at` (umbral-auth). Sessions carry `created_at` and `expires_at`
//! only, so their `last_used_at` is null. The user agent of each token is
//! recorded by `RecordTokenAgent` (at most once every 10 minutes per token,
//! truncated to 300 characters). No IP address is stored.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant};

use axum::extract::Request;
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use umbral::middleware::Middleware;
use umbral::orm::ForeignKey;
use umbral::plugin::Plugin;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Router, StatusCode, delete, get, post};
use umbral_auth::token::auth_token;
use umbral_auth::{AuthToken, RequireAuth};

const RECORD_EVERY: StdDuration = StdDuration::from_secs(600);
const MAX_UA_CHARS: usize = 300;

/// The user agent a bearer token was last used from.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct TaskflowTokenAgent {
    pub id: i64,
    #[umbral(on_delete = "cascade", unique)]
    pub token: ForeignKey<AuthToken>,
    #[umbral(string, max_length = 300)]
    pub user_agent: String,
    pub seen_at: DateTime<Utc>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The public id of a cookie session, from its STORED id (umbral-sessions
/// keeps `sha256(cookie)` as the row's primary key).
pub fn session_public_id(stored_id: &str) -> String {
    format!("s{}", &hex(&Sha256::digest(stored_id.as_bytes()))[..32])
}

/// The stored id of the session whose cookie came with this request.
async fn current_session_id(headers: &HeaderMap) -> Option<String> {
    let cookie = umbral_sessions::cookie_from_headers(headers)?;
    umbral_sessions::read_session(&cookie).await.ok().flatten().map(|s| s.id)
}

/// Delete one session row by its stored id. (`destroy_session` takes the raw
/// cookie, which the server doesn't have for other devices.)
async fn delete_session_row(stored_id: &str) -> Result<u64, sqlx::Error> {
    umbral_sessions::Session::objects().filter(umbral_sessions::session::ID.eq(stored_id)).delete().await
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, key) = v.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| key.trim().to_string()).filter(|k| !k.is_empty())
}

async fn current_token_id(headers: &HeaderMap) -> Option<i64> {
    let key = bearer(headers)?;
    AuthToken::lookup(&key).await.ok().flatten().map(|t| t.id)
}

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, Json<Value>) {
    tracing::error!(error = %e, "me/sessions failed");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal" })))
}

type Reply = Result<Response, (StatusCode, Json<Value>)>;

async fn my_sessions(user: i64) -> Result<Vec<umbral_sessions::Session>, sqlx::Error> {
    let now = Utc::now();
    umbral_sessions::Session::objects()
        .filter(umbral_sessions::session::USER_ID.eq(user.to_string()) & umbral_sessions::session::EXPIRES_AT.gt(now))
        .fetch()
        .await
}

/// `GET /api/taskflow/me/sessions`
pub async fn list(RequireAuth(user): RequireAuth<i64>, headers: HeaderMap) -> Reply {
    let current_token = current_token_id(&headers).await;
    let current_session = current_session_id(&headers).await;
    let tokens = AuthToken::objects()
        .filter(auth_token::USER_ID.eq(user))
        .order_by(auth_token::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    let ids: Vec<i64> = tokens.iter().map(|t| t.id).collect();
    let agents = if ids.is_empty() {
        Vec::new()
    } else {
        TaskflowTokenAgent::objects()
            .filter(taskflow_token_agent::TOKEN.in_(&ids))
            .fetch()
            .await
            .map_err(internal)?
    };
    let mut results: Vec<Value> = tokens
        .iter()
        .map(|t| {
            let ua = agents.iter().find(|a| a.token.id() == t.id).map(|a| a.user_agent.clone());
            json!({
                "id": format!("t{}", t.id), "kind": "token", "name": t.name,
                "created_at": t.created_at, "last_used_at": t.last_used_at, "expires_at": null,
                "user_agent": ua, "current": current_token == Some(t.id),
            })
        })
        .collect();
    for s in my_sessions(user).await.map_err(internal)? {
        results.push(json!({
            "id": session_public_id(&s.id), "kind": "session", "name": null,
            "created_at": s.created_at, "last_used_at": null, "expires_at": s.expires_at,
            "user_agent": null, "current": current_session.as_deref() == Some(s.id.as_str()),
        }));
    }
    Ok(Json(json!({ "results": results })).into_response())
}

/// End one of the caller's tokens or sessions. `Ok(false)` if it isn't theirs.
async fn end(user: i64, public_id: &str) -> Result<bool, (StatusCode, Json<Value>)> {
    if let Some(n) = public_id.strip_prefix('t').and_then(|n| n.parse::<i64>().ok()) {
        let deleted = AuthToken::objects()
            .filter(auth_token::ID.eq(n) & auth_token::USER_ID.eq(user))
            .delete()
            .await
            .map_err(internal)?;
        return Ok(deleted > 0);
    }
    if public_id.starts_with('s') {
        for s in my_sessions(user).await.map_err(internal)? {
            if session_public_id(&s.id) == public_id {
                return Ok(delete_session_row(&s.id).await.map_err(internal)? > 0);
            }
        }
    }
    Ok(false)
}

/// `DELETE /api/taskflow/me/sessions/{id}`
pub async fn end_one(RequireAuth(user): RequireAuth<i64>, Path(id): Path<String>) -> Reply {
    if end(user, &id).await? {
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Err((StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))))
    }
}

/// `POST /api/taskflow/me/sessions/revoke-others`: keep only what made this request.
pub async fn revoke_others(RequireAuth(user): RequireAuth<i64>, headers: HeaderMap) -> Reply {
    let keep_token = current_token_id(&headers).await;
    let keep_session = current_session_id(&headers).await;
    let mut tokens = auth_token::USER_ID.eq(user);
    if let Some(keep) = keep_token {
        tokens = tokens & auth_token::ID.ne(keep);
    }
    let revoked_tokens = AuthToken::objects().filter(tokens).delete().await.map_err(internal)?;
    let mut revoked_sessions = 0u64;
    for s in my_sessions(user).await.map_err(internal)? {
        if keep_session.as_deref() != Some(s.id.as_str()) {
            revoked_sessions += delete_session_row(&s.id).await.map_err(internal)?;
        }
    }
    Ok(Json(json!({ "revoked_tokens": revoked_tokens, "revoked_sessions": revoked_sessions })).into_response())
}

/// key-hash -> when this process last recorded that token's user agent.
fn recorded() -> &'static Mutex<HashMap<String, Instant>> {
    static R: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn record(key: String, user_agent: String) {
    let Ok(Some(token)) = AuthToken::lookup(&key).await else { return };
    let ua: String = user_agent.chars().filter(|c| !c.is_control()).take(MAX_UA_CHARS).collect();
    let now = Utc::now();
    let mut v = serde_json::Map::new();
    v.insert("user_agent".into(), json!(ua));
    v.insert("seen_at".into(), json!(now));
    let updated = TaskflowTokenAgent::objects()
        .filter(taskflow_token_agent::TOKEN.eq(token.id))
        .update_values(v)
        .await
        .unwrap_or(0);
    if updated == 0 {
        // A racing first record loses on the unique `token`; that's fine.
        let _ = TaskflowTokenAgent::objects()
            .create(TaskflowTokenAgent { id: 0, token: ForeignKey::new(token.id), user_agent: ua, seen_at: now })
            .await;
    }
}

/// Records which user agent each bearer token is used from, at most once per
/// `RECORD_EVERY` per token per process, off the request path.
pub struct RecordTokenAgent;

#[umbral::async_trait]
impl Middleware for RecordTokenAgent {
    fn name(&self) -> &'static str {
        "record-token-agent"
    }

    async fn before_request(&self, req: Request) -> Result<Request, Response> {
        let Some(key) = bearer(req.headers()) else { return Ok(req) };
        let Some(ua) = req.headers().get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok()).map(str::to_string) else {
            return Ok(req);
        };
        let cache_key = hex(&Sha256::digest(key.as_bytes()));
        let due = {
            let mut map = recorded().lock().expect("recorded user agents");
            let due = map.get(&cache_key).is_none_or(|at| at.elapsed() >= RECORD_EVERY);
            if due {
                if map.len() > 50_000 {
                    map.retain(|_, at| at.elapsed() < RECORD_EVERY);
                }
                map.insert(cache_key, Instant::now());
            }
            due
        };
        if due && tokio::runtime::Handle::try_current().is_ok() {
            tokio::spawn(record(key, ua));
        }
        Ok(req)
    }
}

#[derive(Debug, Default, Clone)]
pub struct AccountSessionsPlugin;

impl Plugin for AccountSessionsPlugin {
    fn name(&self) -> &'static str {
        "taskflow_account_sessions"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "sessions"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![umbral::migrate::ModelMeta::for_::<TaskflowTokenAgent>()]
    }

    fn middleware(&self) -> Vec<Arc<dyn Middleware>> {
        vec![Arc::new(RecordTokenAgent)]
    }

    fn routes(&self) -> Router {
        Router::new()
            .route("/api/taskflow/me/sessions", get(list))
            .route("/api/taskflow/me/sessions/revoke-others", post(revoke_others))
            .route("/api/taskflow/me/sessions/{id}", delete(end_one))
    }
}

