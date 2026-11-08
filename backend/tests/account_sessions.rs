//! #1134 (1): me/sessions. What must hold: a person sees only their own
//! tokens and sessions, with the one making the request marked `current`;
//! a session's public id is never its cookie key; they can end any one of
//! theirs and none of anyone else's; revoke-others keeps exactly the current
//! one; a token's user agent is recorded.

use axum::Router;
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use umbral_auth::{AuthPlugin, AuthToken, AuthUser};
use umbral_testing::{TestClient, seq};

use backend::account_sessions::{AccountSessionsPlugin, session_public_id};

static APP: OnceCell<Router> = OnceCell::const_new();

async fn app() -> &'static Router {
    APP.get_or_init(|| async {
        let pool = umbral::db::connect_sqlite("sqlite::memory:").await.expect("pool");
        let mut settings = umbral::Settings::from_env().expect("settings");
        settings.database_url = "sqlite::memory:".to_string();
        let app = umbral::App::builder()
            .settings(settings)
            .database("default", pool)
            .plugin(AuthPlugin::<AuthUser>::default().with_default_routes())
            .plugin(umbral_sessions::SessionsPlugin::default())
            .plugin(AccountSessionsPlugin)
            .build()
            .expect("App::build");
        umbral::migrate::create_tables_for_tests().await.expect("schema");
        app.into_router()
    })
    .await
}

async fn user() -> AuthUser {
    let n = seq();
    umbral_auth::create_user(&format!("acct{n}"), &format!("acct{n}@example.com"), "a-long-enough-pass").await.expect("user")
}

async fn token(u: &AuthUser) -> (i64, String) {
    let (row, plain) = AuthToken::create_for(u, "laptop").await.expect("token");
    (row.id, plain.0)
}

fn client(bearer: &str, ua: Option<&str>) -> TestClient {
    let c = TestClient::new(APP.get().unwrap().clone());
    c.set_default_header(http::header::AUTHORIZATION, http::HeaderValue::from_str(&format!("Bearer {bearer}")).unwrap());
    if let Some(ua) = ua {
        c.set_default_header(http::header::USER_AGENT, http::HeaderValue::from_str(ua).unwrap());
    }
    c
}

async fn list(bearer: &str) -> Vec<Value> {
    let r = client(bearer, None).get("/api/taskflow/me/sessions").await;
    assert_eq!(r.status().as_u16(), 200, "{}", r.body_text());
    r.body_json::<Value>()["results"].as_array().unwrap().clone()
}

async fn token_exists(id: i64) -> bool {
    AuthToken::objects().filter(umbral_auth::token::auth_token::ID.eq(id)).first().await.unwrap().is_some()
}

#[tokio::test]
async fn a_person_sees_and_ends_only_their_own() {
    let _ = app().await;
    let me = user().await;
    let other = user().await;
    let (laptop, laptop_key) = token(&me).await;
    let (phone, _) = token(&me).await;
    let (theirs, _) = token(&other).await;
    let session = umbral_sessions::create_session(Some(me.id.to_string()), None).await.expect("session");
    let session_key = session.clone();

    let rows = list(&laptop_key).await;
    assert_eq!(rows.len(), 3, "two tokens and one session: {rows:?}");
    let current: Vec<&Value> = rows.iter().filter(|r| r["current"] == true).collect();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0]["id"], format!("t{laptop}"));
    let s = rows.iter().find(|r| r["kind"] == "session").unwrap();
    let stored = umbral_sessions::read_session(&session_key).await.unwrap().unwrap().id;
    assert_eq!(s["id"], session_public_id(&stored));
    let raw = serde_json::to_string(&rows).unwrap();
    assert!(!raw.contains(&session_key) && !raw.contains(&stored), "neither the cookie nor the stored id leaves the server");
    assert!(!raw.contains(&format!("t{theirs}")), "someone else's token is not listed");

    // Someone else's token, or a made-up id: 404, nothing ended.
    let c = client(&laptop_key, None);
    assert_eq!(c.delete(&format!("/api/taskflow/me/sessions/t{theirs}")).await.status().as_u16(), 404);
    assert!(token_exists(theirs).await);
    assert_eq!(c.delete("/api/taskflow/me/sessions/s0000").await.status().as_u16(), 404);
    // My phone and my session: ended.
    assert_eq!(c.delete(&format!("/api/taskflow/me/sessions/t{phone}")).await.status().as_u16(), 204);
    assert!(!token_exists(phone).await);
    assert_eq!(c.delete(&format!("/api/taskflow/me/sessions/{}", session_public_id(&stored))).await.status().as_u16(), 204);
    assert!(umbral_sessions::read_session(&session_key).await.unwrap().is_none());
}

#[tokio::test]
async fn revoke_others_keeps_exactly_the_current_one() {
    let _ = app().await;
    let me = user().await;
    let other = user().await;
    let (keep, keep_key) = token(&me).await;
    let (drop1, _) = token(&me).await;
    let (drop2, _) = token(&me).await;
    let (theirs, _) = token(&other).await;
    let session = umbral_sessions::create_session(Some(me.id.to_string()), None).await.expect("session");

    let r = client(&keep_key, None).post_json("/api/taskflow/me/sessions/revoke-others", &json!({})).await;
    assert_eq!(r.status().as_u16(), 200, "{}", r.body_text());
    assert_eq!(r.body_json::<Value>()["revoked_tokens"], 2);
    assert_eq!(r.body_json::<Value>()["revoked_sessions"], 1);
    assert!(token_exists(keep).await);
    assert!(!token_exists(drop1).await && !token_exists(drop2).await);
    assert!(token_exists(theirs).await, "another person's token is untouched");
    assert!(umbral_sessions::read_session(&session).await.unwrap().is_none());
}

#[tokio::test]
async fn a_tokens_user_agent_is_recorded() {
    let _ = app().await;
    let me = user().await;
    let (_, key) = token(&me).await;
    let ua = "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0";
    client(&key, Some(ua)).get("/api/taskflow/me/sessions").await;
    // Recorded off the request path; give it a moment.
    let mut seen = Value::Null;
    for _ in 0..50 {
        seen = list(&key).await[0]["user_agent"].clone();
        if seen.is_string() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(seen, ua);
}

#[tokio::test]
async fn the_cookie_session_making_the_request_is_current() {
    let _ = app().await;
    let me = user().await;
    let (_, key) = token(&me).await;
    let session = umbral_sessions::create_session(Some(me.id.to_string()), None).await.expect("session");
    let c = client(&key, None);
    c.set_default_header(http::header::COOKIE, http::HeaderValue::from_str(&format!("umbral_session={session}")).unwrap());
    let rows = c.get("/api/taskflow/me/sessions").await.body_json::<Value>()["results"].as_array().unwrap().clone();
    let s = rows.iter().find(|r| r["kind"] == "session").unwrap();
    assert_eq!(s["current"], true, "{rows:?}");
    // revoke-others from this request keeps that session.
    c.post_json("/api/taskflow/me/sessions/revoke-others", &json!({})).await;
    assert!(umbral_sessions::read_session(&session).await.unwrap().is_some());
}
