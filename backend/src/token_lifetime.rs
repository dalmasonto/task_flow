//! #1101: people's bearer tokens get a lifetime, and a password change drops
//! the user's OTHER tokens.
//!
//! umbral-auth 0.0.13 mints tokens that live until logout, forever (gap filed
//! in umbra/planning/gaps6.md). It does stamp `last_used_at` (coalesced to one
//! write a minute), and documents that column as "so cleanup jobs can prune
//! stale tokens". This is that job, plus one rule:
//!
//! - **Idle limit** (default 14 days, `TASKFLOW_TOKEN_IDLE_DAYS`): a token not
//!   used for that long, counted from `last_used_at`, or `created_at` if it
//!   was never used, is deleted.
//! - **Absolute limit** (default 30 days, `TASKFLOW_TOKEN_MAX_AGE_DAYS`): a
//!   token that old is deleted however busy it is. Sign in again.
//! - **Password change:** umbral-auth's `change-password` deliberately keeps
//!   every token ("the user proved the current password"). A stolen token
//!   would then outlive the change by up to 30 days, so after a successful
//!   change every OTHER bearer token of that user is deleted (the one that made
//!   the change stays), and so are the user's cookie sessions: a stolen cookie
//!   is the same risk. (A password RESET already revokes everything upstream.)
//!   "Successful" is judged by the stored `password_hash` actually changing,
//!   never by "some write to the user row happened" (#1101 review: a failed
//!   change followed by a login's `last_login` write must revoke nothing).
//!
//! The sweep runs at boot, then every 10 minutes, so a token can outlive its
//! limit by at most that. A deleted token is a 401 on its next request, and
//! the frontend signs out on 401.
//!
//! Agent keys are NOT these tokens; they carry their own `expires_at`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant};

use axum::extract::Request;
use axum::http::Method;
use axum::response::Response;
use chrono::{DateTime, Duration, Utc};
use umbral::middleware::Middleware;
use umbral::plugin::{AppContext, Plugin, PluginError};
use umbral_auth::token::auth_token;
use umbral_auth::{AuthToken, AuthUser, auth_user};

pub const DEFAULT_IDLE_DAYS: i64 = 14;
pub const DEFAULT_MAX_AGE_DAYS: i64 = 30;
const SWEEP_EVERY: StdDuration = StdDuration::from_secs(600);
/// How long a recorded "this token is changing its password" stays valid: the
/// handler's write follows within the same request, so seconds are plenty.
const PENDING_TTL: StdDuration = StdDuration::from_secs(60);

fn days_from_env(name: &str, default: i64) -> i64 {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(default).clamp(1, 365)
}

/// The two limits, read from the environment (clamped to 1..=365 days).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub idle: Duration,
    pub max_age: Duration,
}

impl Limits {
    pub fn from_env() -> Self {
        Self {
            idle: Duration::days(days_from_env("TASKFLOW_TOKEN_IDLE_DAYS", DEFAULT_IDLE_DAYS)),
            max_age: Duration::days(days_from_env("TASKFLOW_TOKEN_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS)),
        }
    }
}

/// Delete every token past either limit at `now`. Returns how many went.
pub async fn sweep_once(now: DateTime<Utc>, limits: Limits) -> Result<u64, sqlx::Error> {
    let idle_cut = now - limits.idle;
    let age_cut = now - limits.max_age;
    let expired = auth_token::CREATED_AT.lt(age_cut)
        | auth_token::LAST_USED_AT.lt(idle_cut)
        | (auth_token::LAST_USED_AT.is_null() & auth_token::CREATED_AT.lt(idle_cut));
    let n = AuthToken::objects().filter(expired).delete().await?;
    if n > 0 {
        tracing::info!(deleted = n, "expired auth tokens swept");
    }
    Ok(n)
}

/// A change-password request in flight: the token making it, the password
/// hash it started from, and when it was recorded.
#[derive(Debug, Clone)]
struct Pending {
    token: i64,
    hash_before: String,
    at: Instant,
}

/// user id -> the change in flight for that user.
fn pending() -> &'static Mutex<HashMap<i64, Pending>> {
    static P: OnceLock<Mutex<HashMap<i64, Pending>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn password_hash(user: i64) -> Option<String> {
    AuthUser::objects()
        .filter(auth_user::ID.eq(user))
        .first()
        .await
        .ok()
        .flatten()
        .map(|u| u.password_hash)
}

fn is_change_password(req: &Request) -> bool {
    req.method() == Method::POST && matches!(req.uri().path(), "/api/auth/change-password" | "/api/auth/change-password/")
}

fn bearer(req: &Request) -> Option<String> {
    let v = req.headers().get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, key) = v.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| key.trim().to_string()).filter(|k| !k.is_empty())
}

/// The user row was just written. If a change-password request from one of
/// their tokens is in flight AND the stored hash really changed, delete their
/// other tokens and their sessions. Any other write (a login's `last_login`)
/// leaves the entry alone and revokes nothing.
async fn user_row_written(user: i64) {
    let entry = {
        let mut map = pending().lock().expect("pending password changes");
        map.retain(|_, p| p.at.elapsed() < PENDING_TTL);
        map.get(&user).cloned()
    };
    let Some(entry) = entry else { return };
    let Some(now_hash) = password_hash(user).await else { return };
    if now_hash == entry.hash_before {
        return; // not the password write: keep waiting (or let it expire)
    }
    pending().lock().expect("pending password changes").remove(&user);
    let keep = entry.token;
    if let Err(e) = umbral_sessions::revoke_user_sessions(&user.to_string()).await {
        tracing::error!(user, error = %e, "password changed: could not revoke the user's sessions");
    }
    match AuthToken::objects()
        .filter(auth_token::USER_ID.eq(user) & auth_token::ID.ne(keep))
        .delete()
        .await
    {
        Ok(n) => tracing::info!(user, revoked = n, "password changed: the user's other tokens were revoked"),
        Err(e) => tracing::error!(user, error = %e, "password changed: could not revoke the user's other tokens"),
    }
}

/// Records which token is changing its password, before umbral-auth's handler
/// runs. Revocation itself happens on the user-row write (a failed change
/// writes nothing, so it revokes nothing).
pub struct ChangePasswordRevokesOthers;

#[umbral::async_trait]
impl Middleware for ChangePasswordRevokesOthers {
    fn name(&self) -> &'static str {
        "change-password-revokes-others"
    }

    async fn before_request(&self, req: Request) -> Result<Request, Response> {
        if !is_change_password(&req) {
            return Ok(req);
        }
        // Cookie-session changes carry no bearer and are left as umbral-auth
        // has them (the app always sends a bearer; gap filed upstream).
        if let Some(key) = bearer(&req) {
            if let Ok(Some(token)) = AuthToken::lookup(&key).await {
                let user = token.user_id.id();
                if let Some(hash_before) = password_hash(user).await {
                    pending()
                        .lock()
                        .expect("pending password changes")
                        .insert(user, Pending { token: token.id, hash_before, at: Instant::now() });
                }
            }
        }
        Ok(req)
    }
}

/// The plugin: the sweep (boot + every 10 minutes), the password-write hook,
/// and the change-password middleware.
#[derive(Debug, Default, Clone)]
pub struct TokenLifetimePlugin;

impl Plugin for TokenLifetimePlugin {
    fn name(&self) -> &'static str {
        "taskflow_token_lifetime"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth"]
    }

    fn middleware(&self) -> Vec<Arc<dyn Middleware>> {
        vec![Arc::new(ChangePasswordRevokesOthers)]
    }

    fn on_ready(&self, _ctx: &AppContext) -> Result<(), PluginError> {
        static SUBSCRIBED: std::sync::Once = std::sync::Once::new();
        SUBSCRIBED.call_once(|| {
            // `set_password` writes through `update_values`: ids only.
            umbral::signals::subscribe_async("bulk_post_save:auth_user", |payload| {
                let ids: Vec<i64> = payload["ids"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                    .unwrap_or_default();
                async move {
                    for id in ids {
                        user_row_written(id).await;
                    }
                }
            });
        });
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::spawn(async {
                let limits = Limits::from_env();
                let mut tick = tokio::time::interval(SWEEP_EVERY);
                loop {
                    tick.tick().await;
                    if let Err(e) = sweep_once(Utc::now(), limits).await {
                        tracing::warn!(error = %e, "auth token sweep failed; it retries next tick");
                    }
                }
            });
        }
        Ok(())
    }
}
