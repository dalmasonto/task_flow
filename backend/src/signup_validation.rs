//! #1114: server-side signup validation, in front of umbral-auth's register.
//!
//! umbral-auth's `POST /api/auth/register` (0.0.10) accepted an invalid email
//! and a username with spaces, and answered every duplicate with an opaque
//! `create_failed`. We can't patch the vendored crate (gap logged in
//! `umbra/planning/gaps6.md`), so this middleware sits in front of that one
//! route:
//!
//! - **Shape:** the username is 2–40 of `[A-Za-z0-9_.-]`, and the email is a
//!   plausible `local@domain.tld` with no whitespace. A failure is `400
//!   invalid_username` / `invalid_email`, naming the `field`. Nothing is read
//!   from the database for these, so they reveal nothing.
//! - **Duplicates:** `409 username_taken` / `email_taken`, case-insensitive (so
//!   "Alice" can't sit beside "alice"). Answering "taken" reveals that an
//!   account exists, as the old generic 409 already did, so it is held to the
//!   SAME per-IP register budget: the check spends one unit of
//!   `register_throttle_check` before it answers, and is a 429 once the budget
//!   is gone. A request that passes falls through to umbral-auth, which spends
//!   its own unit; each attempt costs exactly one either way.
//!
//! Everything else (missing fields, the password policy, the throttle on the
//! happy path) stays umbral-auth's.
//!
//! **Bodies (#1124):** since 0.0.12 umbral-auth's register takes JSON OR a
//! form (`JsonOrForm`). This reads the body exactly the way it does: the same
//! content-type test and the same struct-shaped parse, so any body umbral-auth
//! would accept is validated here first. A body neither can parse falls
//! through untouched, and umbral-auth rejects it.

use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use umbral::middleware::Middleware;

/// A register body is three short strings; anything bigger is not one.
const MAX_BODY_BYTES: usize = 16 * 1024;

pub const USERNAME_MIN: usize = 2;
pub const USERNAME_MAX: usize = 40;
const EMAIL_MAX: usize = 254;
const EMAIL_LOCAL_MAX: usize = 64;

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
/// Mail delivery is the real test; this only refuses what can't be an address.
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

fn reject(status: StatusCode, error: &'static str, field: &'static str, detail: &str) -> Response {
    (status, axum::Json(json!({ "error": error, "field": field, "detail": detail }))).into_response()
}

/// Which of the two is already taken (username wins when both are), compared
/// case-insensitively.
async fn taken(username: &str, email: &str) -> Result<Option<&'static str>, sqlx::Error> {
    const SQL: &str = "SELECT \
        MAX(CASE WHEN LOWER(username) = LOWER($1) THEN 1 ELSE 0 END), \
        MAX(CASE WHEN LOWER(email) = LOWER($2) THEN 1 ELSE 0 END) \
        FROM auth_user WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)";
    let row: (Option<i64>, Option<i64>) = match umbral::db::pool_dispatched() {
        umbral::db::DbPool::Sqlite(pool) => sqlx::query_as(SQL).bind(username).bind(email).fetch_one(pool).await?,
        umbral::db::DbPool::Postgres(pool) => {
            // Postgres types MAX over an int CASE as int4; widen for the tuple.
            let r: (Option<i32>, Option<i32>) = sqlx::query_as(SQL).bind(username).bind(email).fetch_one(pool).await?;
            (r.0.map(i64::from), r.1.map(i64::from))
        }
    };
    Ok(match row {
        (Some(1), _) => Some("username"),
        (_, Some(1)) => Some("email"),
        _ => None,
    })
}

/// The two fields this checks, parsed the way umbral-auth parses the whole
/// body (unknown fields ignored, a duplicate field is an error), so the two
/// can never disagree about what was sent.
#[derive(Deserialize)]
struct RegisterShape {
    username: String,
    email: String,
}

/// Mirrors umbral-auth 0.0.13's `JsonOrForm::from_request`.
fn is_form(parts: &axum::http::request::Parts) -> bool {
    parts
        .headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.to_ascii_lowercase().starts_with("application/x-www-form-urlencoded"))
}

fn parse_shape(form: bool, bytes: &[u8]) -> Option<(String, String)> {
    let shape: RegisterShape = if form {
        serde_urlencoded::from_bytes(bytes).ok()?
    } else {
        serde_json::from_slice(bytes).ok()?
    };
    Some((shape.username, shape.email))
}

fn is_register(req: &Request) -> bool {
    req.method() == Method::POST && matches!(req.uri().path(), "/api/auth/register" | "/api/auth/register/")
}

pub struct SignupValidation;

#[umbral::async_trait]
impl Middleware for SignupValidation {
    fn name(&self) -> &'static str {
        "signup-validation"
    }

    async fn before_request(&self, req: Request) -> Result<Request, Response> {
        if !is_register(&req) {
            return Ok(req);
        }
        let (parts, body) = req.into_parts();
        let bytes = to_bytes(body, MAX_BODY_BYTES)
            .await
            .map_err(|_| reject(StatusCode::PAYLOAD_TOO_LARGE, "invalid_input", "body", "request too large"))?;

        // Unparseable, or missing fields: rebuild untouched and let umbral-auth
        // answer exactly as it always has.
        let parsed = parse_shape(is_form(&parts), &bytes);
        if let Some((username, email)) = parsed.filter(|(u, e)| !u.is_empty() && !e.is_empty()) {
            if let Err(why) = validate_username(&username) {
                return Err(reject(StatusCode::BAD_REQUEST, "invalid_username", "username", &format!("Username: {why}.")));
            }
            if let Err(why) = validate_email(&email) {
                return Err(reject(StatusCode::BAD_REQUEST, "invalid_email", "email", &format!("Email: {why}.")));
            }
            match taken(&username, &email).await {
                Ok(Some(field)) => {
                    let ip = umbral::settings::client_ip(&parts.headers).unwrap_or_else(|| "unknown".to_string());
                    if !umbral_auth::register_throttle_check(&ip) {
                        return Err(reject(
                            StatusCode::TOO_MANY_REQUESTS,
                            "rate_limited",
                            "body",
                            "too many registration attempts; try again later",
                        ));
                    }
                    return Err(if field == "username" {
                        reject(StatusCode::CONFLICT, "username_taken", "username", "That username is taken.")
                    } else {
                        reject(StatusCode::CONFLICT, "email_taken", "email", "That email already has an account.")
                    });
                }
                Ok(None) => {}
                // A lookup failure must not block signup: umbral-auth's own
                // unique constraint still refuses a real duplicate.
                Err(e) => tracing::warn!(error = %e, "signup duplicate check failed; deferring to umbral-auth"),
            }
        }
        Ok(Request::from_parts(parts, Body::from(bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_email, validate_username};

    #[test]
    fn usernames() {
        for ok in ["al", "alice", "a.b-c_d", "A1", &"x".repeat(40)] {
            assert!(validate_username(ok).is_ok(), "{ok}");
        }
        for bad in ["a", "v3 probe", " alice", "alice!", "al@ice", "émile", &"x".repeat(41), ""] {
            assert!(validate_username(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn emails() {
        for ok in ["a@b.co", "first.last+tag@example.com", "x@sub.domain.org"] {
            assert!(validate_email(ok).is_ok(), "{ok}");
        }
        for bad in ["bad", "@b.co", "a@", "a@b", "a@b.", "a@.co", "a b@c.co", "a@b@c.co", "a@-b.co", "a@b_c.co", "a@b.co\n"] {
            assert!(validate_email(bad).is_err(), "{bad:?}");
        }
    }
}
