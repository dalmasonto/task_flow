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

/// Write one real page through the operator route, so the manifest has a route
/// a layout document can actually name.
async fn seed_page(app: &TestApp, project: i64, user: i64, path: &str) {
    let res = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/file"),
            &json!({ "path": path, "content": "<main class=\"p-4\">Settings</main>" }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
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

#[tokio::test(flavor = "multi_thread")]
async fn a_real_page_can_be_arranged_and_read_back() {
    // Review Finding 2a: `known_routes` must yield the exact path form a client
    // sends, so the manifest and the document can never disagree. With an empty
    // known-set every other test here would still pass.
    let (app, project, user) = app_with_project().await;
    seed_page(&app, project, user, "pages/settings.html").await;

    let body = json!({
        "view": "groups",
        "routeOrder": ["/settings"],
        "groups": [{ "id": "g1", "name": "Auth", "routes": ["/settings"] }]
    });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 200, "a real page must be arrangeable: {}", res.text());

    let read = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    assert_eq!(read.status(), 200, "{}", read.text());
    let v = read.json();
    assert_eq!(v["view"], "groups");
    assert_eq!(v["routeOrder"][0], "/settings");
    assert_eq!(v["groups"][0]["routes"][0], "/settings");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_document_outlives_the_page_it_names() {
    // Review Finding 2b: the forgiving read path over HTTP. A document naming a
    // page that has since been deleted still reads 200 with its group intact —
    // refusing it would wedge the canvas against a document it cannot repair.
    use taskflow_design::models::{DesignFile, design_file};

    let (app, project, user) = app_with_project().await;
    seed_page(&app, project, user, "pages/settings.html").await;

    let body = json!({
        "view": "groups",
        "routeOrder": ["/settings"],
        "groups": [{ "id": "g1", "name": "Auth", "routes": ["/settings"] }]
    });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 200, "{}", res.text());

    // The page goes away under the stored document's feet.
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project) & design_file::PATH.eq("pages/settings.html"))
        .delete()
        .await
        .expect("delete the page");

    let read = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    assert_eq!(read.status(), 200, "a vanished route is filtered, never an error: {}", read.text());
    let v = read.json();
    assert_eq!(v["view"], "groups");
    assert_eq!(v["groups"][0]["name"], "Auth", "the grouping is a decision, not a page's");
    assert_eq!(v["groups"][0]["routes"].as_array().unwrap().len(), 0);
    assert_eq!(v["routeOrder"].as_array().unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn put_stores_the_normalised_document_not_the_raw_body() {
    // Review Finding 3: `validate` trims names and ids. Persisting the raw body
    // instead would keep every other test in this file green, because none of
    // them sends anything `validate` would change.
    let (app, project, user) = app_with_project().await;
    let body = json!({
        "view": "groups",
        "routeOrder": [],
        "groups": [{ "id": "  g1  ", "name": "  Auth  ", "routes": [] }]
    });
    let res = app.put_json_as(user, &format!("/api/design/{project}/layout"), &body).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["groups"][0]["name"], "Auth");

    // The read is what proves what was STORED: an echo could be normalised
    // while the row kept the untrimmed body.
    let read = app.get_as(user, &format!("/api/design/{project}/layout")).await;
    let v = read.json();
    assert_eq!(v["groups"][0]["name"], "Auth", "the stored name must be the trimmed one");
    assert_eq!(v["groups"][0]["id"], "g1", "ids are trimmed by the same normalisation");
}
