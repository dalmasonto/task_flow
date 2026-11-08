//! #1139: API environment handlers. What must hold:
//! 1. Owner/admin only: a developer 403, an outsider 404, another project's
//!    environment 404.
//! 2. Exactly one default whenever any exist: the first is the default,
//!    `is_default` on create moves it, `/default` switches it, deleting the
//!    default promotes the oldest left.
//! 3. The project's `default_api_base_url` follows the default row (switch,
//!    promote, and editing the default's URL).
//! 4. `health` / `is_default` aren't client-writable through create or PATCH.

use serde_json::{Value, json};

mod support;
use support::{TestApp, seed_member, seed_project};
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectApiEndpoint, TaskflowProjectRole, taskflow_project,
    taskflow_project_api_endpoint,
};

async fn defaults(project: i64) -> Vec<i64> {
    TaskflowProjectApiEndpoint::objects()
        .filter(taskflow_project_api_endpoint::PROJECT.eq(project) & taskflow_project_api_endpoint::IS_DEFAULT.eq(true))
        .fetch()
        .await
        .unwrap()
        .iter()
        .map(|r| r.id)
        .collect()
}

async fn project_url(project: i64) -> Option<String> {
    TaskflowProject::objects().filter(taskflow_project::ID.eq(project)).first().await.unwrap().unwrap().default_api_base_url
}

async fn manager(app: &TestApp, project: i64, role: TaskflowProjectRole) -> i64 {
    let u = app.create_user().await.id;
    seed_member(project, u, role, TaskflowMembershipStatus::Active).await;
    u
}

async fn create(app: &TestApp, user: i64, project: i64, body: Value) -> Value {
    let r = app.post_body_as(user, &format!("/api/taskflow/projects/{project}/environments"), body).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    r.json()
}

#[tokio::test]
async fn only_owners_and_admins_manage_environments() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let other = seed_project().await;
    let admin = manager(&app, project, TaskflowProjectRole::Admin).await;
    let dev = manager(&app, project, TaskflowProjectRole::Developer).await;
    let outsider = app.create_user().await.id;
    let other_admin = manager(&app, other, TaskflowProjectRole::Admin).await;
    let base = format!("/api/taskflow/projects/{project}/environments");
    let body = json!({ "label": "Prod", "base_url": "https://api.example.test" });

    assert_eq!(app.post_body_as(dev, &base, body.clone()).await.status(), 403);
    assert_eq!(app.post_body_as(outsider, &base, body.clone()).await.status(), 404);
    let row = create(&app, admin, project, body).await;
    let id = row["id"].as_i64().unwrap();
    let one = format!("{base}/{id}");
    assert_eq!(app.patch_body_as(dev, &one, json!({ "label": "x" })).await.status(), 403);
    // Another project's admin, through their own project's path: 404.
    let theirs = format!("/api/taskflow/projects/{other}/environments/{id}");
    assert_eq!(app.patch_body_as(other_admin, &theirs, json!({ "label": "x" })).await.status(), 404);
    assert_eq!(app.post_body_as(other_admin, &format!("{theirs}/default"), json!({})).await.status(), 404);
    // Server-only fields aren't accepted.
    assert_eq!(app.patch_body_as(admin, &one, json!({ "health": "healthy" })).await.status(), 422);
    assert_eq!(app.patch_body_as(admin, &one, json!({ "is_default": false })).await.status(), 422);
    assert_eq!(app.post_body_as(admin, &base, json!({ "label": "L", "base_url": "javascript:alert(1)" })).await.status(), 400);
}

#[tokio::test]
async fn there_is_always_exactly_one_default_and_the_project_follows_it() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = manager(&app, project, TaskflowProjectRole::Owner).await;
    let base = format!("/api/taskflow/projects/{project}/environments");

    // The first is the default, whatever it says.
    let a = create(&app, owner, project, json!({ "label": "A", "base_url": "https://a.test", "is_default": false })).await;
    let a = a["id"].as_i64().unwrap();
    assert_eq!(defaults(project).await, vec![a]);
    assert_eq!(project_url(project).await.as_deref(), Some("https://a.test"));
    // A second without is_default doesn't move it; with it, it does.
    let b = create(&app, owner, project, json!({ "label": "B", "base_url": "https://b.test" })).await["id"].as_i64().unwrap();
    assert_eq!(defaults(project).await, vec![a]);
    let c = create(&app, owner, project, json!({ "label": "C", "base_url": "https://c.test", "is_default": true })).await["id"].as_i64().unwrap();
    assert_eq!(defaults(project).await, vec![c]);
    assert_eq!(project_url(project).await.as_deref(), Some("https://c.test"));

    // Switch.
    let r = app.post_body_as(owner, &format!("{base}/{b}/default"), json!({})).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()[0]["id"], b, "default first");
    assert_eq!(defaults(project).await, vec![b]);
    assert_eq!(project_url(project).await.as_deref(), Some("https://b.test"));

    // Editing the default's URL moves the project column; another's doesn't.
    assert_eq!(app.patch_body_as(owner, &format!("{base}/{b}"), json!({ "base_url": "https://b2.test" })).await.status(), 200);
    assert_eq!(project_url(project).await.as_deref(), Some("https://b2.test"));
    assert_eq!(app.patch_body_as(owner, &format!("{base}/{a}"), json!({ "base_url": "https://a2.test", "notes_markdown": null })).await.status(), 200);
    assert_eq!(project_url(project).await.as_deref(), Some("https://b2.test"));

    // Deleting the default promotes the oldest left (a).
    let r = app.delete_as(owner, &format!("{base}/{b}")).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["default"], a);
    assert_eq!(defaults(project).await, vec![a]);
    assert_eq!(project_url(project).await.as_deref(), Some("https://a2.test"));
    // Deleting a non-default leaves the default alone.
    assert_eq!(app.delete_as(owner, &format!("{base}/{c}")).await.json()["default"], a);
    assert_eq!(app.delete_as(owner, &format!("{base}/{a}")).await.json()["default"], Value::Null);
    assert!(defaults(project).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_switches_leave_one_default() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = manager(&app, project, TaskflowProjectRole::Owner).await;
    let base = format!("/api/taskflow/projects/{project}/environments");
    let mut ids = Vec::new();
    for n in 0..3 {
        ids.push(create(&app, owner, project, json!({ "label": format!("E{n}"), "base_url": format!("https://e{n}.test") })).await["id"].as_i64().unwrap());
    }
    for _ in 0..5 {
        let (x, y) = (format!("{base}/{}/default", ids[1]), format!("{base}/{}/default", ids[2]));
        let _ = tokio::join!(app.post_body_as(owner, &x, json!({})), app.post_body_as(owner, &y, json!({})));
        assert_eq!(defaults(project).await.len(), 1);
    }
}

/// Realtime: a delete fires `post_delete` for the row exactly once (the board
/// removes it). umbral's queryset delete fires it; a manual emit would double it.
#[tokio::test]
async fn a_delete_fires_post_delete() {
    use std::sync::Mutex;
    static SEEN: Mutex<Vec<i64>> = Mutex::new(Vec::new());
    umbral::signals::subscribe_async("post_delete:taskflow_project_api_endpoint", |p| {
        let id = p["instance"]["id"].as_i64();
        async move {
            if let Some(id) = id {
                SEEN.lock().unwrap().push(id);
            }
        }
    });
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = manager(&app, project, TaskflowProjectRole::Owner).await;
    let id = create(&app, owner, project, json!({ "label": "Gone", "base_url": "https://gone.test" })).await["id"].as_i64().unwrap();
    assert_eq!(app.delete_as(owner, &format!("/api/taskflow/projects/{project}/environments/{id}")).await.status(), 200);
    let n = SEEN.lock().unwrap().iter().filter(|x| **x == id).count();
    assert_eq!(n, 1, "post_delete fired {n} times for {id}");
}
