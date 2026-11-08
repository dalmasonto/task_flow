//! #1136: a member's role, and removing a member. What must hold:
//! 1. Only owners and admins change roles; a developer gets 403, an outsider 404.
//! 2. No one gives a role above their own; only an owner makes or changes an owner.
//! 3. The last active owner can't be demoted, removed, or leave (409 `last_owner`).
//! 4. Removal sets the membership `left`; an admin can't remove an owner.
//! 5. Anyone may leave (unless they're the last owner).
//! 6. Removal stops the keys of agents the member linked, and says which.
//! 7. Each change writes one activity row.

mod support;

use serde_json::json;
use support::{TestApp, make_project_member_with_role, seed_project};
use taskflow_projects::models::{TaskflowProjectMember, TaskflowProjectRole, taskflow_project_member};
use taskflow_tasks::models::{TaskflowTaskActivity, taskflow_task_activity};

async fn member(project: i64, user: i64) -> TaskflowProjectMember {
    TaskflowProjectMember::objects()
        .filter(taskflow_project_member::PROJECT.eq(project) & taskflow_project_member::USER.eq(user))
        .first()
        .await
        .unwrap()
        .unwrap()
}

async fn role_of(project: i64, user: i64) -> String {
    serde_json::to_value(member(project, user).await.role).unwrap().as_str().unwrap().to_string()
}

async fn status_of(project: i64, user: i64) -> String {
    serde_json::to_value(member(project, user).await.status).unwrap().as_str().unwrap().to_string()
}

async fn activities(project: i64, action: &str) -> usize {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::PROJECT.eq(project) & taskflow_task_activity::ACTION.eq(action))
        .fetch()
        .await
        .unwrap()
        .len()
}

struct Team {
    project: i64,
    owner: i64,
    admin: i64,
    dev: i64,
    viewer: i64,
}

async fn team(app: &TestApp) -> Team {
    let project = seed_project().await;
    let mut ids = Vec::new();
    for role in [TaskflowProjectRole::Owner, TaskflowProjectRole::Admin, TaskflowProjectRole::Developer, TaskflowProjectRole::Viewer] {
        let u = app.create_user().await;
        make_project_member_with_role(project, u, role).await;
        ids.push(u);
    }
    Team { project, owner: ids[0], admin: ids[1], dev: ids[2], viewer: ids[3] }
}

fn path(project: i64, user: i64) -> String {
    format!("/api/taskflow/projects/{project}/members/{user}")
}

#[tokio::test(flavor = "multi_thread")]
async fn roles_are_capped_by_the_callers_own() {
    let app = TestApp::new().await;
    let t = team(&app).await;
    let outsider = app.create_user().await;
    let viewer = path(t.project, t.viewer);

    assert_eq!(app.patch_as(t.dev, &viewer, json!({ "role": "developer" })).await.status(), 403);
    assert_eq!(app.patch_as(outsider, &viewer, json!({ "role": "developer" })).await.status(), 404);
    // An admin: up to admin, never owner, and never touches an owner.
    let r = app.patch_as(t.admin, &viewer, json!({ "role": "admin" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(role_of(t.project, t.viewer).await, "admin");
    assert_eq!(activities(t.project, "member_role_changed").await, 1);
    assert_eq!(app.patch_as(t.admin, &viewer, json!({ "role": "owner" })).await.status(), 403);
    assert_eq!(app.patch_as(t.admin, &path(t.project, t.owner), json!({ "role": "viewer" })).await.status(), 403);
    assert_eq!(role_of(t.project, t.owner).await, "owner");
    // An owner makes an owner.
    assert_eq!(app.patch_as(t.owner, &path(t.project, t.dev), json!({ "role": "owner" })).await.status(), 200);
    assert_eq!(role_of(t.project, t.dev).await, "owner");
    // Unknown fields are refused, not ignored.
    assert_eq!(app.patch_as(t.owner, &viewer, json!({ "role": "viewer", "status": "active" })).await.status(), 422);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_last_owner_stays() {
    let app = TestApp::new().await;
    let t = team(&app).await;
    let me = path(t.project, t.owner);
    let r = app.patch_as(t.owner, &me, json!({ "role": "admin" })).await;
    assert_eq!(r.status(), 409, "{}", r.text());
    assert_eq!(r.json().await["error"], "last_owner");
    assert_eq!(app.delete_as(t.owner, &me).await.status(), 409, "the last owner left");
    assert_eq!(role_of(t.project, t.owner).await, "owner");
    assert_eq!(status_of(t.project, t.owner).await, "active");

    // With a second owner, the first may step down.
    assert_eq!(app.patch_as(t.owner, &path(t.project, t.admin), json!({ "role": "owner" })).await.status(), 200);
    assert_eq!(app.patch_as(t.owner, &me, json!({ "role": "admin" })).await.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_and_leaving() {
    let app = TestApp::new().await;
    let t = team(&app).await;
    // A developer can't remove anyone; an admin can't remove an owner.
    assert_eq!(app.delete_as(t.dev, &path(t.project, t.viewer)).await.status(), 403);
    assert_eq!(app.delete_as(t.admin, &path(t.project, t.owner)).await.status(), 403);
    // An admin removes a viewer: `left`.
    let r = app.delete_as(t.admin, &path(t.project, t.viewer)).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(status_of(t.project, t.viewer).await, "left");
    // The removed viewer can no longer act here.
    assert_eq!(app.delete_as(t.viewer, &path(t.project, t.dev)).await.status(), 404);
    // A developer leaves on their own.
    assert_eq!(app.delete_as(t.dev, &path(t.project, t.dev)).await.status(), 200);
    assert_eq!(status_of(t.project, t.dev).await, "left");
    assert_eq!(activities(t.project, "member_removed").await, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn removal_stops_the_keys_of_agents_they_linked() {
    let app = TestApp::new().await;
    let t = team(&app).await;
    let link = |user: i64, name: &'static str| {
        let app = &app;
        async move {
            let r = app.post_as(user, "/api/taskflow/agents/link", json!({ "project": t.project, "display_name": name, "profile": "main" })).await;
            assert_eq!(r.status(), 200, "{}", r.text());
            r.json().await["key"].as_str().unwrap().to_string()
        }
    };
    let devs_key = link(t.dev, "Dev's helper").await;
    let admins_key = link(t.admin, "Admin's helper").await;
    let whoami = |key: String| {
        let app = &app;
        async move { app.get_as_agent(&key, "/api/taskflow/agents/whoami").await.status() }
    };
    assert_eq!(whoami(devs_key.clone()).await, 200);

    let r = app.delete_as(t.owner, &path(t.project, t.dev)).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b = r.json().await;
    assert_eq!(b["revoked_agent_keys"], 1, "{b}");
    assert_eq!(b["agents"][0]["display_name"], "Dev's helper");
    assert_eq!(whoami(devs_key).await, 401, "a removed member's agent key still works");
    assert_eq!(whoami(admins_key).await, 200, "someone else's agent was stopped");
}
