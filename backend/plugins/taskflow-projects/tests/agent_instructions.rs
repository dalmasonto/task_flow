//! #616: the project's agent instructions are written only by its owners and
//! admins (or a superuser) through `PUT /api/taskflow/projects/{project}/agent-instructions`.

use serde_json::{Value, json};
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectRole, taskflow_project,
};

mod support;
use support::{TestApp, seed_member, seed_project};

fn path(project: i64) -> String {
    format!("/api/taskflow/projects/{project}/agent-instructions")
}

async fn stored(project: i64) -> TaskflowProject {
    TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .first()
        .await
        .expect("load project")
        .expect("project exists")
}

async fn member(app: &TestApp, project: i64, role: TaskflowProjectRole) -> i64 {
    let user = app.create_user().await;
    seed_member(project, user.id, role, TaskflowMembershipStatus::Active).await;
    user.id
}

#[tokio::test]
async fn an_owner_sets_them_and_the_time_is_stamped() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = member(&app, project, TaskflowProjectRole::Owner).await;

    let resp = app.put_body_as(owner, &path(project), json!({ "markdown": "## House rules\nUse pnpm." })).await;
    assert_eq!(resp.status(), 200);
    let body = resp.json();
    assert_eq!(body["project"], json!(project));
    assert_eq!(body["markdown"], json!("## House rules\nUse pnpm."));
    assert!(body["updated_at"].is_string());

    let row = stored(project).await;
    assert_eq!(row.agent_instructions_markdown.as_deref(), Some("## House rules\nUse pnpm."));
    assert!(row.agent_instructions_updated_at.is_some());
}

#[tokio::test]
async fn an_admin_may_but_developers_viewers_and_strangers_may_not() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let admin = member(&app, project, TaskflowProjectRole::Admin).await;
    let developer = member(&app, project, TaskflowProjectRole::Developer).await;
    let viewer = member(&app, project, TaskflowProjectRole::Viewer).await;
    let stranger = app.create_user().await.id;

    for user in [developer, viewer, stranger] {
        assert_eq!(app.put_body_as(user, &path(project), json!({ "markdown": "x" })).await.status(), 403);
    }
    assert_eq!(stored(project).await.agent_instructions_markdown, None);

    assert_eq!(app.put_body_as(admin, &path(project), json!({ "markdown": "admin's" })).await.status(), 200);
    assert_eq!(stored(project).await.agent_instructions_markdown.as_deref(), Some("admin's"));
}

#[tokio::test]
async fn a_superuser_needs_no_membership_and_a_missing_project_is_404() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let root = app.create_superuser().await;

    assert_eq!(app.put_body_as(root.id, &path(project), json!({ "markdown": "root's" })).await.status(), 200);
    assert_eq!(stored(project).await.agent_instructions_markdown.as_deref(), Some("root's"));
    assert_eq!(app.put_body_as(root.id, &path(999_999_999), json!({ "markdown": "x" })).await.status(), 404);
}

#[tokio::test]
async fn a_no_op_save_keeps_the_timestamp_and_blank_clears() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = member(&app, project, TaskflowProjectRole::Owner).await;

    assert_eq!(app.put_body_as(owner, &path(project), json!({ "markdown": "same" })).await.status(), 200);
    let t0 = stored(project).await.agent_instructions_updated_at;
    assert!(t0.is_some());
    // Same text again: nothing changed, so nothing is stamped. Compared DB-read to
    // DB-read (the first reply's in-memory `now` may be more precise than the column).
    assert_eq!(app.put_body_as(owner, &path(project), json!({ "markdown": "same" })).await.status(), 200);
    assert_eq!(stored(project).await.agent_instructions_updated_at, t0);

    let cleared = app.put_body_as(owner, &path(project), json!({ "markdown": "   " })).await;
    assert_eq!(cleared.status(), 200);
    let cleared = cleared.json();
    assert_eq!(cleared["markdown"], Value::Null);
    assert!(cleared["updated_at"].is_string());
    let row = stored(project).await;
    assert_eq!(row.agent_instructions_markdown, None);
    assert!(row.agent_instructions_updated_at.is_some());
}

#[tokio::test]
async fn a_body_without_the_markdown_key_is_rejected_and_changes_nothing() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = member(&app, project, TaskflowProjectRole::Owner).await;
    assert_eq!(app.put_body_as(owner, &path(project), json!({ "markdown": "keep me" })).await.status(), 200);

    let status = app.put_body_as(owner, &path(project), json!({})).await.status();
    assert!((400..500).contains(&status), "expected 4xx, got {status}");
    assert_eq!(stored(project).await.agent_instructions_markdown.as_deref(), Some("keep me"));
}
