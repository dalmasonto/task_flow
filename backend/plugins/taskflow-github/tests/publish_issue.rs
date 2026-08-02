mod support;
use support::{TestApp, seed_member, seed_project_linked, seed_task};
use taskflow_projects::models::TaskflowProjectRole;

use serde_json::json;

#[tokio::test]
async fn publish_creates_issue_with_owner_key_and_stores_number() {
    let app = TestApp::with_owner_token("owner-tok").await; // fake api returns #7
    let owner = app.owner_user(); // github_linked_by
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    // SEC-1: publishing is owner/admin gated.
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;
    let task = seed_task(project, "Fix the bug").await;

    let res = app
        .post_body_as(
            owner.id,
            &format!("/api/taskflow/github/projects/{project}/tasks/{task}/publish"),
            json!({}),
        )
        .await;

    assert_eq!(res.status(), 200);
    assert_eq!(res.json()["issue_number"], 7);

    // stored back on the task
    assert_eq!(app.task_issue_number(task).await, Some(7));

    // used the OWNER token, once
    let calls = app.api_created_issues();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "owner-tok");
    assert_eq!(calls[0].1, "acme/widgets");
}

#[tokio::test]
async fn publish_needs_connect_when_linker_unlinked() {
    let app = TestApp::with_no_tokens().await; // token source returns None
    let owner = app.owner_user();
    let project = seed_project_linked(owner.id, "acme/widgets").await;
    // SEC-1: publishing is owner/admin gated; seed membership so the test
    // reaches the needs_connect path rather than being stopped at authorization.
    seed_member(project, owner.id, TaskflowProjectRole::Owner).await;
    let task = seed_task(project, "Fix the bug").await;

    let res = app
        .post_body_as(
            owner.id,
            &format!("/api/taskflow/github/projects/{project}/tasks/{task}/publish"),
            json!({}),
        )
        .await;

    assert_eq!(res.status(), 409);
    assert_eq!(res.json()["error"], "needs_connect");
    assert_eq!(app.task_issue_number(task).await, None);
}
