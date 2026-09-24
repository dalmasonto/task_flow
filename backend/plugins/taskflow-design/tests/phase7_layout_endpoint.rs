//! Phase 4 acceptance: the shared layout document endpoint.
//!
//! A project with no arrangement reads the default (never a 404 to special-case
//! on the client); a PUT stores and echoes it; unknown routes are refused on
//! write but filtered out on read.

mod support;

use serde_json::json;
use support::TestApp;

async fn app_with_project() -> (TestApp, i64, i64) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    (app, project, user.id)
}

#[tokio::test(flavor = "multi_thread")]
async fn get_returns_the_default_layout_for_a_fresh_project() {
    let (app, project, user) = app_with_project().await;
    let res = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let v = res.json();
    assert_eq!(v["view"], "rows");
    assert_eq!(v["groups"].as_array().unwrap().len(), 0);
    assert!(v["routeOrder"].is_array());
}

#[tokio::test(flavor = "multi_thread")]
async fn put_then_get_round_trips_the_document() {
    let (app, project, user) = app_with_project().await;
    let body = json!({
        "view": "groups",
        "routeOrder": [],
        "groups": [{ "id": "g1", "name": "Auth", "routes": [] }]
    });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["view"], "groups");

    let read = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    let v = read.json();
    assert_eq!(v["view"], "groups");
    assert_eq!(v["groups"][0]["name"], "Auth");
}

#[tokio::test(flavor = "multi_thread")]
async fn put_rejects_a_route_that_is_not_a_page() {
    let (app, project, user) = app_with_project().await;
    let body = json!({
        "view": "groups",
        "routeOrder": [],
        "groups": [{ "id": "g1", "name": "Auth", "routes": ["/nope"] }]
    });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn put_ignores_unknown_fields_and_defaults_a_missing_view() {
    // Review Focus #3.
    let (app, project, user) = app_with_project().await;
    let body = json!({ "routeOrder": [], "groups": [], "somethingNew": true });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["view"], "rows");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_member_cannot_read_or_write_the_layout() {
    let (app, project, _user) = app_with_project().await;
    let (outsider, _other_project) = app.create_member_with_project().await;
    let get = app.get_as(outsider.id, &format!("/api/design/{project}/layout")).await;
    assert_eq!(get.status(), 403);
    let put = app
        .put_json_as(outsider.id, &format!("/api/design/{project}/layout"), &json!({"groups":[]}))
        .await;
    assert_eq!(put.status(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_default_view_serialises_as_the_string_rows() {
    let (app, project, user) = app_with_project().await;
    let res = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    assert_eq!(res.json()["view"], "rows", "the frontend sends and expects this exact string");
}
