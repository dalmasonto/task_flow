//! #1136: a member's role, and removing a member. What must hold:
//! 1. Only owners and admins change roles; a developer gets 403, an outsider 404.
//! 2. No one gives a role above their own; only an owner makes or changes an owner.
//! 3. The last active owner can't be demoted, removed, or leave (409 `last_owner`).
//! 4. Removal sets the membership `left`; an admin can't remove an owner.
//! 5. Anyone may leave (unless they're the last owner).

use serde_json::json;

mod support;
use support::{TestApp, seed_member, seed_project};
use taskflow_projects::models::{TaskflowMembershipStatus, TaskflowProjectMember, TaskflowProjectRole, taskflow_project_member};

async fn role_of(project: i64, user: i64) -> String {
    let m = TaskflowProjectMember::objects()
        .filter(taskflow_project_member::PROJECT.eq(project) & taskflow_project_member::USER.eq(user))
        .first()
        .await
        .unwrap()
        .unwrap();
    serde_json::to_value(m.role).unwrap().as_str().unwrap().to_string()
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
        let u = app.create_user().await.id;
        seed_member(project, u, role, TaskflowMembershipStatus::Active).await;
        ids.push(u);
    }
    Team { project, owner: ids[0], admin: ids[1], dev: ids[2], viewer: ids[3] }
}

fn member_path(project: i64, user: i64) -> String {
    format!("/api/taskflow/projects/{project}/members/{user}")
}

#[tokio::test]
async fn roles_are_capped_by_the_callers_own() {
    let app = TestApp::new().await;
    let t = team(&app).await;
    let outsider = app.create_user().await.id;
    let viewer = member_path(t.project, t.viewer);

    assert_eq!(app.patch_body_as(t.dev, &viewer, json!({ "role": "developer" })).await.status(), 403);
    assert_eq!(app.patch_body_as(outsider, &viewer, json!({ "role": "developer" })).await.status(), 404);
    // An admin: up to admin, never owner, and never touches an owner.
    let r = app.patch_body_as(t.admin, &viewer, json!({ "role": "admin" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(role_of(t.project, t.viewer).await, "admin");
    assert_eq!(app.patch_body_as(t.admin, &viewer, json!({ "role": "owner" })).await.status(), 403);
    assert_eq!(app.patch_body_as(t.admin, &member_path(t.project, t.owner), json!({ "role": "viewer" })).await.status(), 403);
    assert_eq!(role_of(t.project, t.owner).await, "owner");
    // An owner makes an owner.
    assert_eq!(app.patch_body_as(t.owner, &member_path(t.project, t.dev), json!({ "role": "owner" })).await.status(), 200);
    assert_eq!(role_of(t.project, t.dev).await, "owner");
    // Unknown fields are refused, not ignored.
    assert_eq!(app.patch_body_as(t.owner, &viewer, json!({ "role": "viewer", "status": "active" })).await.status(), 422);
}

#[tokio::test]
async fn the_last_owner_stays() {
    let app = TestApp::new().await;
    let t = team(&app).await;
    let me = member_path(t.project, t.owner);
    let r = app.patch_body_as(t.owner, &me, json!({ "role": "admin" })).await;
    assert_eq!(r.status(), 409, "{}", r.text());
    assert_eq!(r.json()["error"], "last_owner");
    assert_eq!(app.delete_as(t.owner, &me).await.status(), 409, "the last owner left");
    assert_eq!(role_of(t.project, t.owner).await, "owner");
    assert_eq!(app.member_status(t.project, t.owner).await.as_deref(), Some("active"));

    // With a second owner, the first may step down.
    assert_eq!(app.patch_body_as(t.owner, &member_path(t.project, t.admin), json!({ "role": "owner" })).await.status(), 200);
    assert_eq!(app.patch_body_as(t.owner, &me, json!({ "role": "admin" })).await.status(), 200);
}

#[tokio::test]
async fn removing_and_leaving() {
    let app = TestApp::new().await;
    let t = team(&app).await;
    // A developer can't remove anyone; an admin can't remove an owner.
    assert_eq!(app.delete_as(t.dev, &member_path(t.project, t.viewer)).await.status(), 403);
    assert_eq!(app.delete_as(t.admin, &member_path(t.project, t.owner)).await.status(), 403);
    // An admin removes a viewer: `left`, and they're gone from the active roster.
    assert_eq!(app.delete_as(t.admin, &member_path(t.project, t.viewer)).await.status(), 204);
    assert_eq!(app.member_status(t.project, t.viewer).await.as_deref(), Some("left"));
    assert_eq!(app.count_active_members(t.project, t.viewer).await, 0);
    // The removed viewer can no longer act here.
    assert_eq!(app.delete_as(t.viewer, &member_path(t.project, t.dev)).await.status(), 404);
    // A developer leaves on their own.
    assert_eq!(app.delete_as(t.dev, &member_path(t.project, t.dev)).await.status(), 204);
    assert_eq!(app.member_status(t.project, t.dev).await.as_deref(), Some("left"));
}

