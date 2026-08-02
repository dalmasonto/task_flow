//! SEC-1 regression tests (gaps3.md P0): the project-scoped GitHub endpoints
//! must authorize the caller's project membership/role BEFORE any token
//! resolution or GitHub API call. Before this, `publish_issue` discarded the
//! caller id entirely and any authenticated user could publish another project's
//! task as a GitHub issue using the owner's token.
//!
//! The invariant these tests protect: no external GitHub side effect and no
//! stored state change happens for an unauthorized caller.

mod support;

use serde_json::json;
use support::{
    TestApp, pref_row, seed_member, seed_project_linked, seed_task, seed_task_with_issue,
};
use taskflow_projects::models::TaskflowProjectRole;

fn status_path(project: i64) -> String {
    format!("/api/taskflow/github/projects/{project}/status")
}
fn pref_path(project: i64) -> String {
    format!("/api/taskflow/github/projects/{project}/pref")
}
fn comment_path(project: i64, task: i64) -> String {
    format!("/api/taskflow/github/projects/{project}/tasks/{task}/comment")
}
fn publish_path(project: i64, task: i64) -> String {
    format!("/api/taskflow/github/projects/{project}/tasks/{task}/publish")
}

#[tokio::test]
async fn non_member_cannot_read_status() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;

    let outsider = app.create_user().await; // authenticated, but NOT a member
    let res = app.get_as(outsider.id, &status_path(project)).await;

    assert_eq!(res.status(), 403);
    assert_eq!(res.json()["error"], "not_a_member");
}

#[tokio::test]
async fn non_member_cannot_get_or_set_pref_and_leaves_no_row() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;

    let outsider = app.create_user().await;

    let got = app.get_as(outsider.id, &pref_path(project)).await;
    assert_eq!(got.status(), 403);
    assert_eq!(got.json()["error"], "not_a_member");

    let set = app
        .post_body_as(outsider.id, &pref_path(project), json!({ "post_as_me": true }))
        .await;
    assert_eq!(set.status(), 403);
    assert_eq!(set.json()["error"], "not_a_member");

    // The forbidden set_pref must NOT have created a pref row for the outsider.
    assert_eq!(pref_row(outsider.id, project).await, None);
}

#[tokio::test]
async fn non_member_cannot_comment_and_makes_no_github_call() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;
    let task = seed_task_with_issue(project, "Fix", 7).await;

    let outsider = app.create_user().await;
    let res = app
        .post_body_as(outsider.id, &comment_path(project, task), json!({ "body": "hi" }))
        .await;

    assert_eq!(res.status(), 403);
    assert_eq!(res.json()["error"], "not_a_member");
    // No owner-token spend, no external side effect: auth precedes GitHub work.
    assert!(app.api_comments().is_empty());
}

#[tokio::test]
async fn non_member_cannot_publish_and_makes_no_github_call() {
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;
    let task = seed_task(project, "Fix the bug").await;

    let outsider = app.create_user().await;
    let res = app.post_body_as(outsider.id, &publish_path(project, task), json!({})).await;

    assert_eq!(res.status(), 403);
    assert_eq!(res.json()["error"], "not_a_member");
    // The whole point of SEC-1: the owner's token is never spent on an external
    // issue, and nothing is stored back on the task.
    assert!(app.api_created_issues().is_empty());
    assert_eq!(app.task_issue_number(task).await, None);
}

#[tokio::test]
async fn developer_can_read_status_but_cannot_publish() {
    // Proves the role split: publish is owner/admin only, but any member may read.
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;

    let dev = app.create_user().await;
    seed_member(project, dev.id, TaskflowProjectRole::Developer).await;

    // A developer member CAN read status...
    let status = app.get_as(dev.id, &status_path(project)).await;
    assert_eq!(status.status(), 200);
    // ...but the status contract must report they cannot publish, so the UI never
    // shows an enabled Publish control that the backend will 403 (role-aware
    // can_publish). The owner-token is ready here; only the role term flips it.
    assert_eq!(status.json()["can_publish"], false);

    // ...but CANNOT publish (member below admin -> "forbidden", distinct from a
    // non-member's "not_a_member").
    let task = seed_task(project, "Fix").await;
    let pubres = app.post_body_as(dev.id, &publish_path(project, task), json!({})).await;
    assert_eq!(pubres.status(), 403);
    assert_eq!(pubres.json()["error"], "forbidden");
    assert!(app.api_created_issues().is_empty());
    assert_eq!(app.task_issue_number(task).await, None);
}

#[tokio::test]
async fn status_does_not_leak_project_existence_to_non_members() {
    // ANTI-ENUMERATION — PINNED BEHAVIOR, DO NOT "FIX" INTO A 404 ORACLE.
    // A non-member hitting a REAL project and any user hitting a NONEXISTENT
    // project must return the SAME `403 not_a_member`, so the response cannot be
    // used to discover which project ids exist or are GitHub-linked. Membership
    // is checked before the project is ever fetched, which is what guarantees it.
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;

    let outsider = app.create_user().await;
    let real = app.get_as(outsider.id, &status_path(project)).await;
    let missing = app.get_as(outsider.id, &status_path(project + 999_999)).await;

    assert_eq!(real.status(), 403);
    assert_eq!(missing.status(), 403);
    assert_eq!(real.json()["error"], "not_a_member");
    assert_eq!(missing.json()["error"], "not_a_member");
}

#[tokio::test]
async fn superuser_pref_on_missing_project_is_404() {
    // require_member lets a superuser bypass membership, so the pref handlers need
    // a post-auth project existence check. Without it, GET would return a default
    // 200 {post_as_me:false} and POST would hit a DB FK error. A missing project
    // must 404 for both, and write nothing.
    let app = TestApp::with_owner_token("owner-tok").await;
    let su = app.create_superuser().await;
    let missing = 999_999;

    let got = app.get_as(su.id, &pref_path(missing)).await;
    assert_eq!(got.status(), 404);

    let set = app
        .post_body_as(su.id, &pref_path(missing), json!({ "post_as_me": true }))
        .await;
    assert_eq!(set.status(), 404);

    assert_eq!(pref_row(su.id, missing).await, None);
}

#[tokio::test]
async fn superuser_bypasses_membership() {
    // require_member/require_admin let a superuser through even without a
    // membership row (mirrors the existing require_admin used by link/unlink).
    let app = TestApp::with_owner_token("owner-tok").await;
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;

    let su = app.create_superuser().await; // not a member, but superuser
    let res = app.get_as(su.id, &status_path(project)).await;
    assert_eq!(res.status(), 200);
}
