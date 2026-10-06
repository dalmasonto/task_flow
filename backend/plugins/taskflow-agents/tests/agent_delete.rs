//! `DELETE /api/taskflow/agents/{agent}` — who may remove an agent, and what
//! goes with it. The linker or a project owner/admin may; any other member may
//! not; a non-member sees 404. The agent's key stops working at once.

use serde_json::json;

mod support;
use support::{TestApp, make_active_project_member, make_project_member_with_role, seed_project};
use taskflow_projects::models::TaskflowProjectRole;

async fn mint(app: &TestApp, user: i64, project: i64, profile: &str) -> (i64, String) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Deletable", "profile": profile }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    let body = resp.json().await;
    (body["agent_id"].as_i64().unwrap(), body["key"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn the_linker_can_delete_their_agent_and_its_key_stops_working() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, key) = mint(&app, linker, project, "linker-del").await;

    assert_eq!(app.get_as_agent(&key, "/api/taskflow/agents/whoami").await.status(), 200);
    let resp = app.delete_as(linker, &format!("/api/taskflow/agents/{agent}")).await;
    assert_eq!(resp.status(), 204);
    assert_eq!(app.get_as_agent(&key, "/api/taskflow/agents/whoami").await.status(), 401);
    // Gone: a second delete is a 404.
    assert_eq!(app.delete_as(linker, &format!("/api/taskflow/agents/{agent}")).await.status(), 404);
}

#[tokio::test]
async fn another_developer_cannot_delete_someone_elses_agent() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let other = app.create_user().await;
    make_active_project_member(project, other).await;
    let (agent, _) = mint(&app, linker, project, "dev-del").await;

    assert_eq!(app.delete_as(other, &format!("/api/taskflow/agents/{agent}")).await.status(), 403);
}

#[tokio::test]
async fn an_admin_can_delete_any_agent_in_the_project() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    let (agent, _) = mint(&app, linker, project, "admin-del").await;

    assert_eq!(app.delete_as(admin, &format!("/api/taskflow/agents/{agent}")).await.status(), 204);
}

#[tokio::test]
async fn a_non_member_gets_404() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let stranger = app.create_user().await;
    let (agent, _) = mint(&app, linker, project, "stranger-del").await;

    assert_eq!(app.delete_as(stranger, &format!("/api/taskflow/agents/{agent}")).await.status(), 404);
}
