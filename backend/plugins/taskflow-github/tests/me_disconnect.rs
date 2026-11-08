//! #1135: GitHub `me` (who you're connected as) and disconnect. What must hold:
//! 1. GET returns `login` (cached per user), `connected_at`, `scopes` and the
//!    projects whose issue sync uses your link; `login: null` when GitHub
//!    fails, never a 500.
//! 2. DELETE needs the account password (403 `password_required`), removes the
//!    link, revokes the token at GitHub, drops the login cache, and lists the
//!    projects that now need a reconnect.

mod support;

use serde_json::json;
use support::{TestApp, seed_project_linked};

#[tokio::test]
async fn me_shows_the_login_and_tracking_projects() {
    let app = TestApp::with_owner_token("tok-1").await;
    let user = app.owner_user();
    let p = seed_project_linked(user.id, "acme/widgets").await;

    let b = app.get_as(user.id, "/api/taskflow/github/me").await.json();
    assert_eq!(b["connected"], true);
    assert_eq!(b["login"], "octocat");
    assert_eq!(b["scopes"], "repo");
    assert!(b["projects_tracking"].as_array().unwrap().iter().any(|x| x["id"] == p), "{b}");
    // Cached: a second read doesn't ask GitHub again.
    app.get_as(user.id, "/api/taskflow/github/me").await;
    assert_eq!(*app.fake_api().login_calls.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_github_failure_is_a_null_login_not_an_error() {
    let app = TestApp::with_owner_token("tok-2").await;
    *app.fake_api().login.lock().unwrap() = None;
    let r = app.get_as(app.owner_user().id, "/api/taskflow/github/me").await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.json()["connected"], true);
    assert_eq!(r.json()["login"], serde_json::Value::Null);
    assert!(!r.text().contains("tok-2"), "the token never leaves");
}

#[tokio::test]
async fn disconnect_needs_the_password_and_revokes() {
    let app = TestApp::with_owner_token("tok-3").await;
    let user = app.owner_user();
    let p = seed_project_linked(user.id, "acme/widgets").await;
    app.set_password(user.id, "correct horse").await;
    app.get_as(user.id, "/api/taskflow/github/me").await; // warm the cache

    for bad in [json!({}), json!({ "password": "" }), json!({ "password": "wrong" })] {
        let r = app.delete_body_as(user.id, "/api/taskflow/github/me", bad.clone()).await;
        assert_eq!(r.status(), 403, "{bad}");
        assert_eq!(r.json()["error"], "password_required");
    }
    assert!(app.fake_api().revoked.lock().unwrap().is_empty(), "nothing revoked on a refusal");
    assert_eq!(app.get_as(user.id, "/api/taskflow/github/me").await.json()["connected"], true);

    let r = app.delete_body_as(user.id, "/api/taskflow/github/me", json!({ "password": "correct horse" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["disconnected"], true);
    assert!(r.json()["projects_tracking"].as_array().unwrap().iter().any(|x| x["id"] == p));
    assert_eq!(*app.fake_api().revoked.lock().unwrap(), vec!["tok-3".to_string()]);
    let b = app.get_as(user.id, "/api/taskflow/github/me").await.json();
    assert_eq!(b["connected"], false);
    assert_eq!(b["login"], serde_json::Value::Null, "the cache is dropped");

    // Again: nothing to disconnect, nothing revoked.
    let r = app.delete_body_as(user.id, "/api/taskflow/github/me", json!({ "password": "correct horse" })).await;
    assert_eq!(r.json()["disconnected"], false);
    assert_eq!(app.fake_api().revoked.lock().unwrap().len(), 1);
    assert_eq!(app.delete_body_as(user.id, "/api/taskflow/github/me", json!({ "password": "correct horse", "user": 1 })).await.status(), 422);
}
