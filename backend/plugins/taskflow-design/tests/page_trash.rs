//! #501: the page trash — an agent or the operator trashes a page, it drops out
//! of everything that renders, and the operator can restore it.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

async fn setup() -> (TestApp, i64, i64, String) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = seed_agent(project, "Builder").await;
    (app, project, user.id, key)
}

async fn seed_page(app: &TestApp, project: i64, user: i64, path: &str, body: &str) {
    let res = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/file"),
            &json!({ "path": path, "content": format!("<main class=\"p-4\">{body}</main>") }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
}

async fn manifest_routes(app: &TestApp, project: i64, user: i64) -> Vec<String> {
    let m = app.get_as(user, &format!("/api/design/{project}/manifest")).await.json();
    m["routes"]
        .as_array()
        .expect("routes")
        .iter()
        .map(|r| r["path"].as_str().unwrap_or_default().to_string())
        .collect()
}

const AGENT_PAGE: &str = "/api/taskflow/agents/design/page";

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_trashes_a_page_and_the_operator_restores_it() {
    let (app, project, user, key) = setup().await;
    seed_page(&app, project, user, "pages/index.html", "Home").await;
    seed_page(&app, project, user, "pages/draft.html", "Draft").await;
    assert!(manifest_routes(&app, project, user).await.contains(&"/draft".to_string()));

    let res = app
        .delete_json_as_agent(
            &key,
            AGENT_PAGE,
            &json!({ "project": project, "route": "/draft", "reason": "superseded by /settings" }),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["trashed"], "pages/draft.html");

    // Gone from the manifest and from the agent's page read.
    assert!(!manifest_routes(&app, project, user).await.contains(&"/draft".to_string()));
    let read = app
        .get_as_agent(&key, &format!("{AGENT_PAGE}?project={project}&route=/draft"))
        .await;
    assert_eq!(read.status(), 404, "a trashed page must not read back: {}", read.text());

    // In the trash, restorable.
    let trash = app.get_as(user, &format!("/api/design/{project}/trash")).await.json();
    assert_eq!(trash["files"][0]["path"], "pages/draft.html", "{trash}");
    assert_eq!(trash["files"][0]["route"], "/draft");

    let restored = app
        .post_json_as(
            user,
            &format!("/api/design/{project}/trash/restore"),
            &json!({ "path": "pages/draft.html" }),
        )
        .await;
    assert_eq!(restored.status(), 200, "{}", restored.text());
    assert!(manifest_routes(&app, project, user).await.contains(&"/draft".to_string()));
    let trash = app.get_as(user, &format!("/api/design/{project}/trash")).await.json();
    assert_eq!(trash["files"].as_array().map(Vec::len), Some(0), "{trash}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_operator_trashes_by_route() {
    let (app, project, user, _key) = setup().await;
    seed_page(&app, project, user, "pages/old.html", "Old").await;
    let res = app.delete_as(user, &format!("/api/design/{project}/page?route=/old")).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert!(!manifest_routes(&app, project, user).await.contains(&"/old".to_string()));
    // Trashing it again finds no live page.
    let again = app.delete_as(user, &format!("/api/design/{project}/page?route=/old")).await;
    assert_eq!(again.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn writing_a_new_page_at_a_trashed_route_replaces_the_trashed_copy() {
    // The trashed row still holds the unique (project, path) slot; without the
    // purge this write would fail with a storage error.
    let (app, project, user, _key) = setup().await;
    seed_page(&app, project, user, "pages/about.html", "First").await;
    let res = app.delete_as(user, &format!("/api/design/{project}/page?route=/about")).await;
    assert_eq!(res.status(), 200, "{}", res.text());

    seed_page(&app, project, user, "pages/about.html", "Second").await;
    let trash = app.get_as(user, &format!("/api/design/{project}/trash")).await.json();
    assert_eq!(trash["files"].as_array().map(Vec::len), Some(0), "the old copy is purged: {trash}");
    let restore = app
        .post_json_as(
            user,
            &format!("/api/design/{project}/trash/restore"),
            &json!({ "path": "pages/about.html" }),
        )
        .await;
    assert_eq!(restore.status(), 404, "nothing to restore over the new page");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_must_give_a_reason() {
    let (app, project, user, key) = setup().await;
    seed_page(&app, project, user, "pages/x.html", "X").await;
    let res = app
        .delete_json_as_agent(&key, AGENT_PAGE, &json!({ "project": project, "route": "/x", "reason": "no" }))
        .await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert!(manifest_routes(&app, project, user).await.contains(&"/x".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_member_cannot_see_or_restore_the_trash() {
    let (app, project, user, _key) = setup().await;
    seed_page(&app, project, user, "pages/x.html", "X").await;
    let (stranger, _other) = app.create_member_with_project().await;
    assert_eq!(app.delete_as(stranger.id, &format!("/api/design/{project}/page?route=/x")).await.status(), 403);
    assert_eq!(app.get_as(stranger.id, &format!("/api/design/{project}/trash")).await.status(), 403);
}
