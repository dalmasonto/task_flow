//! #606: a task may name which of the project's repos it belongs to.
//!
//! The write paths validate it, because a task that names a repo the project
//! does not link is a trap: the name looks like configuration, nothing uses it
//! until the first publish, and the failure then lands on whoever pressed
//! publish. Refusing it at the write names the problem where it entered.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, seed_project};
use taskflow_projects::models::{TaskflowProject, taskflow_project};

async fn mint(app: &TestApp, user: i64, project: i64) -> String {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed");
    resp.json().await["key"].as_str().expect("key").to_string()
}

/// Link `repo` on the project, the way the link endpoint does.
async fn link(project: i64, repo: &str) {
    TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .update_values(
            json!({ "github_repo": repo }).as_object().cloned().unwrap_or_default(),
        )
        .await
        .expect("link");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_can_put_a_task_in_a_linked_repo() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let key = mint(&app, user, project).await;
    link(project, "acme/widgets").await;

    let created = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "api work", "repo": "acme/widgets" }),
        )
        .await;
    assert_eq!(created.status(), 200, "{}", created.text());
    assert_eq!(created.json().await["github_repo"], "acme/widgets");

    // Omitted means the project default — the behaviour every task had before
    // this field existed.
    let plain = app
        .post_as_agent(&key, "/api/taskflow/agents/tasks", json!({ "title": "plain" }))
        .await;
    assert_eq!(plain.status(), 200, "{}", plain.text());
    assert!(plain.json().await["github_repo"].is_null());

    // update_task can move it, and `null` puts it back on the default.
    let task_id = plain.json().await["id"].as_i64().expect("id");
    let moved = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/tasks/{task_id}"),
            json!({ "repo": "acme/widgets" }),
        )
        .await;
    assert_eq!(moved.status(), 200, "{}", moved.text());
    assert_eq!(moved.json().await["github_repo"], "acme/widgets");

    let cleared = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/tasks/{task_id}"),
            json!({ "repo": null }),
        )
        .await;
    assert_eq!(cleared.status(), 200, "{}", cleared.text());
    assert!(cleared.json().await["github_repo"].is_null(), "cleared to the default");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_the_project_does_not_link_is_refused() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let key = mint(&app, user, project).await;
    link(project, "acme/widgets").await;

    let malformed = app
        .post_as_agent(&key, "/api/taskflow/agents/tasks", json!({ "title": "x", "repo": "nope" }))
        .await;
    assert_eq!(malformed.status(), 400, "{}", malformed.text());

    let unlinked = app
        .post_as_agent(&key, "/api/taskflow/agents/tasks", json!({ "title": "x", "repo": "acme/other" }))
        .await;
    assert_eq!(unlinked.status(), 400, "{}", unlinked.text());
}
