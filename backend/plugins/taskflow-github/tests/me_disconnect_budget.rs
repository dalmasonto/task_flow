//! #6036 review of #1135 part 6. What must hold:
//! 1. DELETE github/me takes at most 5 wrong passwords per user per 15 min,
//!    then 429 `too_many_attempts`, even for the right password; another
//!    user's budget is untouched. (Own binary: the budget is per process.)
//! 2. Linking a different GitHub account without disconnecting never shows
//!    the old account's cached login.

mod support;

use serde_json::json;
use support::{TestApp, seed_project_linked};

#[tokio::test]
async fn wrong_passwords_are_rate_limited() {
    let app = TestApp::with_owner_token("tok-b1").await;
    let user = app.owner_user();
    seed_project_linked(user.id, "acme/widgets").await;
    app.set_password(user.id, "correct horse").await;

    for i in 0..5 {
        let r = app.delete_body_as(user.id, "/api/taskflow/github/me", json!({ "password": "wrong" })).await;
        assert_eq!(r.status(), 403, "attempt {i}");
    }
    let r = app.delete_body_as(user.id, "/api/taskflow/github/me", json!({ "password": "correct horse" })).await;
    assert_eq!(r.status(), 429, "{}", r.text());
    assert_eq!(r.json()["error"], "too_many_attempts");
    assert!(app.fake_api().revoked.lock().unwrap().is_empty(), "nothing revoked while throttled");
    assert_eq!(app.get_as(user.id, "/api/taskflow/github/me").await.json()["connected"], true);

    // Someone else isn't throttled by it.
    let other = app.create_user().await;
    app.set_password(other.id, "pw-2").await;
    let r = app.delete_body_as(other.id, "/api/taskflow/github/me", json!({ "password": "pw-2" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
}

#[tokio::test]
async fn a_right_password_spends_nothing() {
    let app = TestApp::with_owner_token("tok-b2").await;
    let user = app.owner_user();
    app.set_password(user.id, "correct horse").await;
    for _ in 0..4 {
        assert_eq!(app.delete_body_as(user.id, "/api/taskflow/github/me", json!({ "password": "wrong" })).await.status(), 403);
    }
    // Six right ones in a row: none counted.
    for _ in 0..6 {
        assert_eq!(app.delete_body_as(user.id, "/api/taskflow/github/me", json!({ "password": "correct horse" })).await.status(), 200);
    }
}

#[tokio::test]
async fn relinking_another_account_drops_the_cached_login() {
    let app = TestApp::with_owner_token("tok-b3").await;
    let user = app.owner_user();
    assert_eq!(app.get_as(user.id, "/api/taskflow/github/me").await.json()["login"], "octocat");
    *app.fake_api().login.lock().unwrap() = Some("hubot".into());
    // Same account: still cached.
    assert_eq!(app.get_as(user.id, "/api/taskflow/github/me").await.json()["login"], "octocat");
    app.relink(user.id, "tok-b3-other");
    assert_eq!(app.get_as(user.id, "/api/taskflow/github/me").await.json()["login"], "hubot");
}
