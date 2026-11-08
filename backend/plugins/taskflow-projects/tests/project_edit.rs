//! #1137: project settings are edited only through the owner/admin PATCH,
//! with an allowlist. A developer or viewer gets 403, an outsider 404; github_*
//! and owner can't be written here (unknown field); archiving needs an owner.

use serde_json::json;

mod support;
use support::{TestApp, seed_member, seed_project};
use taskflow_projects::models::{TaskflowMembershipStatus, TaskflowProject, TaskflowProjectRole, taskflow_project};

async fn project_row(id: i64) -> TaskflowProject {
    TaskflowProject::objects().filter(taskflow_project::ID.eq(id)).first().await.unwrap().unwrap()
}

#[tokio::test]
async fn only_owners_and_admins_edit_settings_through_the_allowlist() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let other = seed_project().await;
    let path = format!("/api/taskflow/projects/{project}");
    let mut users = Vec::new();
    for role in [TaskflowProjectRole::Owner, TaskflowProjectRole::Admin, TaskflowProjectRole::Developer, TaskflowProjectRole::Viewer] {
        let u = app.create_user().await;
        seed_member(project, u.id, role, TaskflowMembershipStatus::Active).await;
        users.push(u.id);
    }
    let (owner, admin, dev, viewer) = (users[0], users[1], users[2], users[3]);
    let outsider = app.create_user().await.id;

    for who in [dev, viewer] {
        let r = app.patch_body_as(who, &path, json!({ "name": "pwned" })).await;
        assert_eq!(r.status(), 403, "{who}: {}", r.text());
    }
    assert_eq!(app.patch_body_as(outsider, &path, json!({ "name": "pwned" })).await.status(), 404);
    // github_* and owner aren't in the allowlist at all.
    for body in [json!({ "github_repo": "evil/repo" }), json!({ "github_linked_by": owner }), json!({ "owner": admin })] {
        assert_eq!(app.patch_body_as(admin, &path, body.clone()).await.status(), 422, "{body}");
    }
    let before = project_row(project).await;
    assert!(before.github_repo.is_none() && before.github_linked_by.is_none());

    // An admin renames and repoints; bad URLs and a taken slug are refused.
    let r = app
        .patch_body_as(admin, &path, json!({ "name": " Renamed ", "default_api_base_url": "https://api.example.test", "repository_url": null }))
        .await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["name"], "Renamed");
    assert_eq!(r.json()["default_api_base_url"], "https://api.example.test");
    assert_eq!(app.patch_body_as(admin, &path, json!({ "default_api_base_url": "javascript:alert(1)" })).await.status(), 400);
    let taken = project_row(other).await.slug;
    assert_eq!(app.patch_body_as(admin, &path, json!({ "slug": taken })).await.status(), 409);

    // Archiving needs an owner.
    let r = app.patch_body_as(admin, &path, json!({ "status": "archived" })).await;
    assert_eq!(r.status(), 403, "{}", r.text());
    assert_eq!(app.patch_body_as(admin, &path, json!({ "status": "paused" })).await.status(), 200, "pausing is fine for an admin");
    assert_eq!(app.patch_body_as(owner, &path, json!({ "status": "archived" })).await.status(), 200);
    assert_eq!(app.patch_body_as(admin, &path, json!({ "status": "active" })).await.status(), 403, "unarchiving too");
}

/// #1137 review nit: an empty body changes nothing, so it writes nothing and
/// tells realtime nothing (no `post_save`, `updated_at` untouched).
#[tokio::test]
async fn an_empty_patch_is_a_no_op() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static POSTS: AtomicUsize = AtomicUsize::new(0);
    static WATCHED: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await.id;
    seed_member(project, owner, TaskflowProjectRole::Owner, TaskflowMembershipStatus::Active).await;
    WATCHED.store(project, Ordering::SeqCst);
    umbral::signals::subscribe_async("post_save:taskflow_project", |p| {
        let id = p["instance"]["id"].as_i64();
        async move {
            if id == Some(WATCHED.load(Ordering::SeqCst)) {
                POSTS.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    let before = project_row(project).await;
    let r = app.patch_body_as(owner, &format!("/api/taskflow/projects/{project}"), json!({})).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json()["id"], project);
    assert_eq!(POSTS.load(Ordering::SeqCst), 0, "an empty patch emitted post_save");
    assert_eq!(project_row(project).await.updated_at, before.updated_at);
    // A real change still emits once.
    app.patch_body_as(owner, &format!("/api/taskflow/projects/{project}"), json!({ "name": "Changed" })).await;
    assert_eq!(POSTS.load(Ordering::SeqCst), 1);
}
