mod support;
use serde_json::json;
use support::{
    TestApp, project_github_link, seed_member, seed_pref, seed_project, seed_project_linked,
};
use taskflow_projects::models::TaskflowProjectRole;

#[tokio::test]
async fn status_reflects_connected_linked_and_optin() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    // SEC-1: reading status is active-member gated.
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;
    seed_pref(owner.id, project, true).await;

    let res = app
        .get_as(owner.id, &format!("/api/taskflow/github/projects/{project}/status"))
        .await;

    assert_eq!(res.status(), 200);
    let b = res.json();
    assert_eq!(b["user_connected"], true);
    assert_eq!(b["project_linked"], true);
    assert_eq!(b["github_repo"], "acme/widgets");
    assert_eq!(b["can_publish"], true);
    assert_eq!(b["post_as_me"], true);
}

#[tokio::test]
async fn status_shows_disconnected_and_unlinked() {
    let app = TestApp::with_no_tokens().await;
    let user = app.owner_user();
    let project = seed_project().await; // not linked
    // SEC-1: reading status is active-member gated.
    seed_member(project, user.id, TaskflowProjectRole::Developer).await;

    let res = app
        .get_as(user.id, &format!("/api/taskflow/github/projects/{project}/status"))
        .await;

    assert_eq!(res.status(), 200);
    let b = res.json();
    assert_eq!(b["user_connected"], false);
    assert_eq!(b["project_linked"], false);
    assert_eq!(b["can_publish"], false);
    assert_eq!(b["post_as_me"], false);
}

#[tokio::test]
async fn link_sets_repo_and_linked_by_for_admin_with_token() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let admin = app.owner_user();
    let project = seed_project().await;
    seed_member(project, admin.id, TaskflowProjectRole::Owner).await;

    let res = app
        .post_body_as(
            admin.id,
            &format!("/api/taskflow/github/projects/{project}/link"),
            json!({ "repo": "acme/widgets" }),
        )
        .await;

    assert_eq!(res.status(), 200);
    let (repo, linked_by) = project_github_link(project).await;
    assert_eq!(repo.as_deref(), Some("acme/widgets"));
    assert_eq!(linked_by, Some(admin.id));
}

#[tokio::test]
async fn link_needs_connect_when_caller_unlinked() {
    let app = TestApp::with_no_tokens().await;
    let owner = app.owner_user();
    let project = seed_project().await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;

    let res = app
        .post_body_as(
            owner.id,
            &format!("/api/taskflow/github/projects/{project}/link"),
            json!({ "repo": "acme/widgets" }),
        )
        .await;

    assert_eq!(res.status(), 409);
    assert_eq!(res.json()["error"], "needs_connect");
    assert_eq!(project_github_link(project).await, (None, None));
}

#[tokio::test]
async fn link_forbidden_for_non_admin() {
    let app = TestApp::with_owner_token("dev-tok").await;
    let dev = app.owner_user();
    let project = seed_project().await;
    seed_member(project, dev.id, TaskflowProjectRole::Developer).await;

    let res = app
        .post_body_as(
            dev.id,
            &format!("/api/taskflow/github/projects/{project}/link"),
            json!({ "repo": "acme/widgets" }),
        )
        .await;

    assert_eq!(res.status(), 403);
    assert_eq!(project_github_link(project).await, (None, None));
}

#[tokio::test]
async fn auto_mirror_defaults_false_and_owner_can_toggle_it() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;

    // Default: off, reported by status.
    let status = app
        .get_as(owner.id, &format!("/api/taskflow/github/projects/{project}/status"))
        .await;
    assert_eq!(status.json()["auto_mirror"], false);

    // Owner turns it on.
    let toggled = app
        .post_body_as(
            owner.id,
            &format!("/api/taskflow/github/projects/{project}/auto-mirror"),
            json!({ "enabled": true }),
        )
        .await;
    assert_eq!(toggled.status(), 200);
    assert_eq!(toggled.json()["auto_mirror"], true);

    // Status now reflects it.
    let status2 = app
        .get_as(owner.id, &format!("/api/taskflow/github/projects/{project}/status"))
        .await;
    assert_eq!(status2.json()["auto_mirror"], true);
}

#[tokio::test]
async fn auto_mirror_toggle_forbidden_for_non_admin() {
    let app = TestApp::with_owner_token("dev-tok").await;
    let dev = app.owner_user();
    let project = seed_project_linked(dev.id, "acme/widgets").await;
    seed_member(project, dev.id, TaskflowProjectRole::Developer).await;

    let res = app
        .post_body_as(
            dev.id,
            &format!("/api/taskflow/github/projects/{project}/auto-mirror"),
            json!({ "enabled": true }),
        )
        .await;
    assert_eq!(res.status(), 403);
}
