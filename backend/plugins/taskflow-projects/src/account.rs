//! #1134 (2): the caller's own profile.
//!
//! | Route | |
//! |---|---|
//! | `GET /api/taskflow/me/profile` | `{id, username, email, full_name, email_verified}` |
//! | `PATCH /api/taskflow/me/profile` | `{full_name?, username?, email?, current_password?}` |
//!
//! Caller-only: there's no id to name another user. Username and email follow
//! the signup rules (shape, then a case-insensitive `409 username_taken` /
//! `email_taken`); umbral-auth stores both trimmed and lowercased.
//!
//! **An email change needs `current_password`.** Org and project invites are
//! accepted by matching the account's email, so a hijacked session that could
//! change the email could then accept invites meant for that address. A wrong
//! or missing password is `403 password_required`.

use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use crate::models::{TaskflowUserSettings, taskflow_user_settings};

pub const USERNAME_MIN: usize = 2;
pub const USERNAME_MAX: usize = 40;
const EMAIL_MAX: usize = 254;
const EMAIL_LOCAL_MAX: usize = 64;
const FULL_NAME_MAX: usize = 120;

/// 2–40 of `[A-Za-z0-9_.-]`, no spaces. Shared with signup (#1114).
pub fn validate_username(username: &str) -> Result<(), &'static str> {
    let n = username.chars().count();
    if !(USERNAME_MIN..=USERNAME_MAX).contains(&n) {
        return Err("2 to 40 characters");
    }
    if !username.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
        return Err("letters, digits, _ . and - only, no spaces");
    }
    Ok(())
}

/// Deliberately plain, not RFC 5322: one `@`, a non-empty local part, and a
/// dotted domain of non-empty labels, with no whitespace or control characters.
/// Shared with signup (#1114).
pub fn validate_email(email: &str) -> Result<(), &'static str> {
    const BAD: &str = "a valid email address";
    if email.len() > EMAIL_MAX || email.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(BAD);
    }
    let Some((local, domain)) = email.split_once('@') else { return Err(BAD) };
    if local.is_empty() || local.len() > EMAIL_LOCAL_MAX || domain.contains('@') {
        return Err(BAD);
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty() || l.starts_with('-') || l.ends_with('-')) {
        return Err(BAD);
    }
    if !domain.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-')) {
        return Err(BAD);
    }
    Ok(())
}

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, field: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "field": field, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "me/profile failed");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal" })))
}

async fn load_me(user: i64) -> Result<AuthUser, ApiError> {
    AuthUser::objects()
        .filter(auth_user::ID.eq(user))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))))
}

async fn full_name_of(user: i64) -> Result<Option<String>, ApiError> {
    Ok(TaskflowUserSettings::objects()
        .filter(taskflow_user_settings::USER.eq(user))
        .first()
        .await
        .map_err(internal)?
        .and_then(|s| s.full_name))
}

async fn profile_json(user: i64) -> Result<Value, ApiError> {
    let me = load_me(user).await?;
    Ok(json!({
        "id": me.id, "username": me.username, "email": me.email,
        "full_name": full_name_of(user).await?, "email_verified": me.email_verified_at.is_some(),
    }))
}

/// Is `value` used by another account in `column` (case-insensitive)?
/// `icontains` escapes LIKE wildcards; the exact match is made here.
async fn taken_by_other(column: &str, value: &str, me: i64) -> Result<bool, ApiError> {
    let rows = match column {
        "username" => AuthUser::objects().filter(auth_user::USERNAME.icontains(value)).fetch().await,
        _ => AuthUser::objects().filter(auth_user::EMAIL.icontains(value)).fetch().await,
    }
    .map_err(internal)?;
    Ok(rows.iter().any(|u| {
        u.id != me && (if column == "username" { &u.username } else { &u.email }).trim().eq_ignore_ascii_case(value)
    }))
}

/// `GET /api/taskflow/me/profile`
pub async fn get_profile(RequireAuth(user): RequireAuth<i64>) -> Result<Response, ApiError> {
    Ok(Json(profile_json(user).await?).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfilePatch {
    #[serde(default)]
    pub full_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub current_password: Option<String>,
}

/// `PATCH /api/taskflow/me/profile`
pub async fn patch_profile(RequireAuth(user): RequireAuth<i64>, Json(input): Json<ProfilePatch>) -> Result<Response, ApiError> {
    let me = load_me(user).await?;
    let mut account = serde_json::Map::new();

    if let Some(username) = input.username.as_deref().map(|u| u.trim().to_lowercase()) {
        if username != me.username {
            validate_username(&username).map_err(|why| err(StatusCode::BAD_REQUEST, "invalid_username", "username", &format!("Username: {why}.")))?;
            if taken_by_other("username", &username, user).await? {
                return Err(err(StatusCode::CONFLICT, "username_taken", "username", "That username is taken."));
            }
            account.insert("username".into(), json!(username));
        }
    }
    if let Some(email) = input.email.as_deref().map(|e| e.trim().to_lowercase()) {
        if !email.eq_ignore_ascii_case(&me.email) {
            validate_email(&email).map_err(|why| err(StatusCode::BAD_REQUEST, "invalid_email", "email", &format!("Email: {why}.")))?;
            // Password before the duplicate check, so an unauthenticated
            // session can't use this route to probe which emails exist.
            let ok = match input.current_password.as_deref() {
                Some(pw) if !pw.is_empty() => umbral_auth::verify_password_async(pw, &me.password_hash).await.unwrap_or(false),
                _ => false,
            };
            if !ok {
                return Err(err(StatusCode::FORBIDDEN, "password_required", "current_password", "Enter your current password to change your email."));
            }
            if taken_by_other("email", &email, user).await? {
                return Err(err(StatusCode::CONFLICT, "email_taken", "email", "That email already has an account."));
            }
            account.insert("email".into(), json!(email));
            // A new address is not a verified one.
            account.insert("email_verified_at".into(), Value::Null);
        }
    }
    let full_name = match input.full_name.map(|n| n.trim().to_string()) {
        Some(n) if n.chars().count() > FULL_NAME_MAX => {
            return Err(err(StatusCode::BAD_REQUEST, "invalid", "full_name", "At most 120 characters."));
        }
        other => other,
    };

    if !account.is_empty() {
        // A unique-constraint race (someone took it after our check) is a 409.
        AuthUser::objects()
            .filter(auth_user::ID.eq(user))
            .update_values(account.clone())
            .await
            .map_err(|e| {
                let field = if account.contains_key("username") { "username" } else { "email" };
                if e.to_string().to_lowercase().contains("unique") {
                    err(StatusCode::CONFLICT, &format!("{field}_taken"), field, "That is taken.")
                } else {
                    internal(e)
                }
            })?;
    }
    if let Some(name) = full_name {
        crate::views::ensure_user_settings(user).await.map_err(|s| (s, Json(json!({ "error": "internal" }))))?;
        let mut v = serde_json::Map::new();
        v.insert("full_name".into(), if name.is_empty() { Value::Null } else { json!(name) });
        v.insert("updated_at".into(), json!(Utc::now()));
        TaskflowUserSettings::objects()
            .filter(taskflow_user_settings::USER.eq(user))
            .update_values(v)
            .await
            .map_err(internal)?;
    }
    Ok(Json(profile_json(user).await?).into_response())
}
