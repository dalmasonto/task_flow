//! #1101: bearer tokens expire, and a password change drops the user's other
//! tokens. Through the real auth routes and the real plugin.

use axum::Router;
use chrono::{Duration, Utc};
use serde_json::json;
use tokio::sync::OnceCell;
use umbral_auth::token::auth_token;
use umbral_auth::{AuthPlugin, AuthToken, AuthUser};
use umbral_testing::{TestClient, seq};

use backend::token_lifetime::{Limits, TokenLifetimePlugin, sweep_once};

static APP: OnceCell<Router> = OnceCell::const_new();

async fn app() -> &'static Router {
    APP.get_or_init(|| async {
        let pool = umbral::db::connect_sqlite("sqlite::memory:").await.expect("pool");
        let mut settings = umbral::Settings::from_env().expect("settings");
        settings.database_url = "sqlite::memory:".to_string();
        let app = umbral::App::builder()
            .settings(settings)
            .database("default", pool)
            .plugin(
                AuthPlugin::<AuthUser>::default()
                    .with_default_routes()
                    .register_throttle(1000, std::time::Duration::from_secs(3600)),
            )
            .plugin(umbral_sessions::SessionsPlugin::default())
            .plugin(TokenLifetimePlugin)
            .build()
            .expect("App::build");
        umbral::migrate::create_tables_for_tests().await.expect("schema");
        app.into_router()
    })
    .await
}

const PASSWORD: &str = "a-long-enough-pass";

async fn user() -> AuthUser {
    let n = seq();
    umbral_auth::create_user(&format!("tok{n}"), &format!("tok{n}@example.com"), PASSWORD)
        .await
        .expect("create user")
}

async fn token(u: &AuthUser) -> (i64, String) {
    let (row, plain) = AuthToken::create_for(u, "test").await.expect("mint token");
    (row.id, plain.0)
}

/// Rewrite a token's timestamps (days ago; None = never used).
async fn age(id: i64, created_days: i64, used_days: Option<i64>) {
    let now = Utc::now();
    let mut v = serde_json::Map::new();
    v.insert("created_at".into(), json!(now - Duration::days(created_days)));
    v.insert("last_used_at".into(), json!(used_days.map(|d| now - Duration::days(d))));
    AuthToken::objects().filter(auth_token::ID.eq(id)).update_values(v).await.expect("age token");
}

async fn sessions_of(u: &AuthUser) -> usize {
    umbral_sessions::Session::objects()
        .filter(umbral_sessions::session::USER_ID.eq(u.id.to_string()))
        .fetch()
        .await
        .expect("sessions")
        .len()
}

async fn exists(id: i64) -> bool {
    AuthToken::objects().filter(auth_token::ID.eq(id)).first().await.expect("lookup").is_some()
}

#[tokio::test]
async fn the_sweep_deletes_idle_and_too_old_tokens_and_nothing_else() {
    let _ = app().await;
    let u = user().await;
    let limits = Limits { idle: Duration::days(14), max_age: Duration::days(30) };

    let (fresh, _) = token(&u).await;
    let (used_13d_ago, _) = token(&u).await;
    age(used_13d_ago, 20, Some(13)).await;
    let (idle_15d, _) = token(&u).await;
    age(idle_15d, 20, Some(15)).await;
    let (busy_but_31d_old, _) = token(&u).await;
    age(busy_but_31d_old, 31, Some(0)).await;
    let (never_used_15d, _) = token(&u).await;
    age(never_used_15d, 15, None).await;
    let (never_used_13d, _) = token(&u).await;
    age(never_used_13d, 13, None).await;

    sweep_once(Utc::now(), limits).await.expect("sweep");

    assert!(exists(fresh).await, "a fresh token stays");
    assert!(exists(used_13d_ago).await, "used 13 days ago: inside the idle limit");
    assert!(!exists(idle_15d).await, "idle 15 days: gone");
    assert!(!exists(busy_but_31d_old).await, "31 days old: gone however busy");
    assert!(!exists(never_used_15d).await, "never used and 15 days old: gone");
    assert!(exists(never_used_13d).await, "never used but only 13 days old: stays");
}

#[tokio::test]
async fn an_expired_token_is_rejected_on_its_next_request() {
    let router = app().await.clone();
    let u = user().await;
    let (id, plain) = token(&u).await;
    let me = |t: String| {
        let router = router.clone();
        async move {
            let c = TestClient::new(router);
            c.set_default_header(http::header::AUTHORIZATION, http::HeaderValue::from_str(&format!("Bearer {t}")).unwrap());
            c.get("/api/auth/me").await.status().as_u16()
        }
    };
    assert_eq!(me(plain.clone()).await, 200);
    age(id, 40, Some(0)).await;
    sweep_once(Utc::now(), Limits { idle: Duration::days(14), max_age: Duration::days(30) }).await.unwrap();
    assert_eq!(me(plain).await, 401, "a swept token is a 401, which signs the app out");
}

async fn change_password(router: Router, bearer: &str, current: &str, new: &str) -> u16 {
    let c = TestClient::new(router);
    c.set_default_header(http::header::AUTHORIZATION, http::HeaderValue::from_str(&format!("Bearer {bearer}")).unwrap());
    c.post_json("/api/auth/change-password", &json!({ "current_password": current, "new_password": new }))
        .await
        .status()
        .as_u16()
}

#[tokio::test]
async fn a_password_change_drops_the_users_other_tokens_but_keeps_its_own() {
    let router = app().await.clone();
    let u = user().await;
    let other_user = user().await;
    let (laptop, laptop_key) = token(&u).await;
    let (phone, _) = token(&u).await;
    let (stolen, _) = token(&u).await;
    let (someone_else, _) = token(&other_user).await;
    umbral_sessions::create_session(Some(u.id.to_string()), None).await.expect("a cookie session");
    umbral_sessions::create_session(Some(other_user.id.to_string()), None).await.expect("theirs");

    // A failed change (wrong current password) revokes nothing.
    assert_eq!(change_password(router.clone(), &laptop_key, "wrong-password-here", "another-long-pass").await, 400);
    assert!(exists(phone).await && exists(stolen).await, "a failed change keeps every token");

    let status = change_password(router.clone(), &laptop_key, PASSWORD, "a-brand-new-long-pass").await;
    assert_eq!(status, 204);
    assert!(exists(laptop).await, "the token that changed the password stays");
    assert!(!exists(phone).await, "the user's other tokens are revoked");
    assert!(!exists(stolen).await);
    assert!(exists(someone_else).await, "another user's tokens are untouched");
    assert_eq!(sessions_of(&u).await, 0, "the user's cookie sessions are revoked too");
    assert_eq!(sessions_of(&other_user).await, 1, "another user's session is untouched");
}

/// #1101 review: a FAILED change followed by an unrelated write to the user
/// row (a login stamping `last_login`) must revoke nothing; only a real change
/// of the stored password hash does.
#[tokio::test]
async fn a_failed_change_then_an_unrelated_user_write_revokes_nothing() {
    let router = app().await.clone();
    let u = user().await;
    let (laptop, laptop_key) = token(&u).await;
    assert_eq!(change_password(router.clone(), &laptop_key, "wrong-password-here", "another-long-pass").await, 400);

    // The phone logs in within the minute: a new token and a user-row write.
    let (phone, _) = token(&u).await;
    let mut v = serde_json::Map::new();
    v.insert("last_login".into(), json!(Utc::now()));
    AuthUser::objects().filter(umbral_auth::auth_user::ID.eq(u.id)).update_values(v).await.expect("last_login write");

    assert!(exists(phone).await, "the phone's new token survives an unrelated write");
    assert!(exists(laptop).await);
}

/// #1134 review: change-password is throttled per user (5 attempts per 15
/// minutes), so a stolen session can't guess the current password.
#[tokio::test]
async fn change_password_attempts_are_throttled() {
    let router = app().await.clone();
    let u = user().await;
    let other = user().await;
    let (_, key) = token(&u).await;
    let (_, other_key) = token(&other).await;
    for _ in 0..taskflow_projects::account::password_budget::MAX {
        assert_eq!(change_password(router.clone(), &key, "wrong-password-here", "another-long-pass").await, 400);
    }
    assert_eq!(change_password(router.clone(), &key, PASSWORD, "a-brand-new-long-pass").await, 429, "even the right one waits");
    assert_eq!(change_password(router.clone(), &other_key, "wrong-password-here", "another-long-pass").await, 400, "another user is unaffected");
}
