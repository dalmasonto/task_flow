mod support;
use support::{TestApp, seed_pref, seed_project_linked, seed_task_with_issue};
use serde_json::json;

#[tokio::test]
async fn comment_posts_under_actor_token_when_opted_in() {
    let app = TestApp::with_user_token("alice", "alice-tok").await;
    let alice = app.user("alice");
    let project = seed_project_linked(alice.id, "acme/widgets").await;
    let task = seed_task_with_issue(project, "Fix", 7).await;
    seed_pref(alice.id, project, true).await; // opted in

    let res = app
        .post_body_as(
            alice.id,
            &format!("/api/taskflow/github/projects/{project}/tasks/{task}/comment"),
            json!({ "body": "on it" }),
        )
        .await;

    assert_eq!(res.status(), 204);
    let comments = app.api_comments();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].0, "alice-tok"); // actor's token, not owner's
    assert_eq!(comments[0].2, 7); // issue number
    assert_eq!(comments[0].3, "on it");
}

#[tokio::test]
async fn comment_needs_connect_when_opted_out() {
    let app = TestApp::with_user_token("alice", "alice-tok").await;
    let alice = app.user("alice");
    let project = seed_project_linked(alice.id, "acme/widgets").await;
    let task = seed_task_with_issue(project, "Fix", 7).await;
    seed_pref(alice.id, project, false).await; // opted OUT

    let res = app
        .post_body_as(
            alice.id,
            &format!("/api/taskflow/github/projects/{project}/tasks/{task}/comment"),
            json!({ "body": "on it" }),
        )
        .await;

    assert_eq!(res.status(), 409);
    assert_eq!(res.json()["error"], "needs_connect");
    assert!(app.api_comments().is_empty());
}
