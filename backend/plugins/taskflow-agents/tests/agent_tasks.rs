//! An agent authoring a task via `POST /api/taskflow/agents/tasks` must be
//! recorded as the creator: `created_by_agent_id` carries its id, and the human
//! `created_by` stays null (no human authored it).

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, seed_project};

/// Mint an agent credential for `user` in `project`, returning `(agent_id, key)`.
async fn mint(app: &TestApp, user: i64, project: i64) -> (i64, String) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed");
    let body = resp.json().await;
    (
        body["agent_id"].as_i64().expect("agent_id"),
        body["key"].as_str().expect("key").to_string(),
    )
}

struct Fixture {
    app: TestApp,
    key: String,
    agent_id: i64,
}

async fn fixture() -> Fixture {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent_id, key) = mint(&app, user, project).await;
    Fixture { app, key, agent_id }
}

#[tokio::test]
async fn an_agent_created_task_records_the_agent_as_creator() {
    let f = fixture().await;
    let resp = f
        .app
        .post_as_agent(
            &f.key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "by the agent", "description_markdown": "d" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "agent task create must succeed");
    let body = resp.json().await;
    assert_eq!(body["created_by_agent_id"], json!(f.agent_id));
    assert_eq!(body["created_by"], serde_json::Value::Null);
}
