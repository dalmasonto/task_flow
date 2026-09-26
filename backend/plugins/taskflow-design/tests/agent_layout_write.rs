//! The agent layout write: four operations over one route.
//!
//! The read is in `agent_layout_read.rs`; this file owns everything that
//! CHANGES the arrangement.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

/// An app, a member with a project, and an agent credential for that project.
async fn app_with_agent() -> (TestApp, i64, i64, String) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = seed_agent(project, "Builder").await;
    (app, project, user.id, key)
}

/// One real page, through the operator file route, so the manifest has a route
/// a layout document can name.
async fn seed_page(app: &TestApp, project: i64, user: i64, path: &str, name: &str) {
    let res = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/file"),
            &json!({ "path": path, "content": format!("<main class=\"p-4\">{name}</main>") }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
}

/// The agent layout route, read or write — ONE path, and the query carries the
/// project. (The read and the write are the same URL by design: the body is
/// what differs, and only one of the two verbs accepts one.)
fn layout_path(project: i64) -> String {
    format!("/api/taskflow/agents/design/layout?project={project}")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_creates_a_group_and_reads_it_back() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Player" } } }),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let body = res.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["version"], 1, "the first write creates the row at version 1");
    let group_id = body["changed"]["groups"][0].as_str().expect("the new group id");

    // And it is really there, through the read the agent already has.
    let read = app.get_as_agent(&key, &layout_path(project)).await;
    let doc = read.json();
    assert_eq!(doc["groups"][0]["id"], group_id);
    assert_eq!(doc["groups"][0]["name"], "Player");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_page_does_not_wedge_future_writes() {
    // Review Focus 1. The stored document still names a page that is gone;
    // `validate` REJECTS unknown routes while `load_layout` FILTERS them, so a
    // write that began from the raw row would fail forever on a page nobody can
    // see. The write must begin from the served view.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;
    seed_page(&app, project, user, "pages/b.html", "B").await;

    let created = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await
        .json();
    let group_id = created["changed"]["groups"][0].as_str().unwrap().to_string();

    // Arrange /b into that group, then delete /b behind the document's back.
    app.put_as_agent(
        &key,
        &layout_path(project),
        json!({ "project": project, "op": { "reorder_page": { "route": "/b", "group_id": group_id } } }),
    )
    .await;
    app.delete_page_row(project, "pages/b.html").await;

    // A fresh, unrelated write must still succeed.
    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Two" } } }),
        )
        .await;
    assert_eq!(res.status(), 200, "a dead route must not block an edit: {}", res.text());

    let after = app.get_as_agent(&key, &layout_path(project)).await.json();
    let named: Vec<String> = after["flow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(!named.contains(&"/b".to_string()), "and the dead route is gone: {named:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unparseable_row_is_refused_rather_than_reset() {
    // Review Focus 2. `load_layout` degrades to `default_doc()` on a row that
    // will not parse. Doing that on the WRITE side would persist `default + op`
    // and silently discard the real arrangement.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // The operator arranges something real, then the bytes go bad underneath.
    app.put_json_as(
        user,
        &format!("/api/design/{project}/layout"),
        &json!({
            "view": "groups",
            "routeOrder": ["/a"],
            "groups": [{ "id": "gkeep", "name": "Keep Me", "routes": ["/a"] }],
            "pageLabels": {}
        }),
    )
    .await;
    app.write_layout_json(project, "{ this is not json").await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Player" } } }),
        )
        .await;
    assert_eq!(res.status(), 500, "refused, not repaired: {}", res.text());

    let row = app.latest_layout_row(project).await;
    assert_eq!(row.layout_json, "{ this is not json", "and nothing was written");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_write_another_projects_layout() {
    let (app, project, _user, key) = app_with_agent().await;
    let (_other_user, other_project) = app.create_member_with_project().await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(other_project),
            json!({ "project": other_project, "op": { "create_group": { "name": "Nope" } } }),
        )
        .await;
    assert!(res.status() >= 400, "the credential's own project only: {}", res.text());

    // Positive control: the SAME credential and the SAME body against its own
    // project is accepted, so the refusal above is about the project and not
    // about the request being malformed.
    let ok = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Nope" } } }),
        )
        .await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_arguments_are_refused_with_a_reason() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // A blank name is refused by `validate`, which owns the name rules.
    let blank = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "   " } } }),
        )
        .await;
    assert_eq!(blank.status(), 400, "{}", blank.text());
    assert!(
        blank.json()["message"].as_str().unwrap_or_default().contains("empty"),
        "validate's own message is surfaced: {}",
        blank.text()
    );

    // An unknown group id names the id.
    let ghost = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "update_group": { "group_id": "ghost", "name": "X" } } }),
        )
        .await;
    assert_eq!(ghost.status(), 400, "{}", ghost.text());
    assert!(ghost
        .json()["message"]
        .as_str()
        .unwrap_or_default()
        .contains("ghost"));
}
