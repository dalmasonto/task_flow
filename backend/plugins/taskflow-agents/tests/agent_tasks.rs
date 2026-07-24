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

/// #57: an activity row has to say WHICH task. These rows previously read
/// "created_task" with an empty body, "claimed_task" with an empty body, and
/// "in_progress → partial_done" with no subject — you could see that something
/// happened but not to what, which made the feed unreadable at any volume.
///
/// The backend is the only place this can be fixed: the PostToolUse hook writes
/// a parallel row for the same event but only ever sees tool input, so it has
/// the id and never the title.
#[tokio::test]
async fn task_activity_names_the_task_it_is_about() {
    let f = fixture().await;
    let created = f
        .app
        .post_as_agent(
            &f.key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "Wire the widget", "description_markdown": "d" }),
        )
        .await;
    assert_eq!(created.status(), 200);
    let task_id = created.json().await["id"].as_i64().expect("task id");

    let claimed = f
        .app
        .post_as_agent(&f.key, &format!("/api/taskflow/agents/tasks/{task_id}/claim"), json!({}))
        .await;
    assert_eq!(claimed.status(), 200);

    let moved = f
        .app
        .post_as_agent(
            &f.key,
            &format!("/api/taskflow/agents/tasks/{task_id}/status"),
            json!({ "status": "in_progress" }),
        )
        .await;
    assert_eq!(moved.status(), 200);

    let rows = f.app.get_as_agent(&f.key, "/api/taskflow/agents/activity").await;
    assert_eq!(rows.status(), 200);
    let body = rows.json().await;
    let events = body["results"].as_array().or(body.as_array()).expect("activity list");

    let body_for = |action: &str| -> String {
        events
            .iter()
            .find(|e| e["action"] == action)
            .unwrap_or_else(|| panic!("no {action} row in {events:?}"))["body_markdown"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };

    for action in ["created_task", "claimed_task", "status_changed"] {
        let text = body_for(action);
        assert!(
            text.contains(&format!("#{task_id}")),
            "{action} body must name the task id, got {text:?}"
        );
        assert!(
            text.contains("Wire the widget"),
            "{action} body must name the task title, got {text:?}"
        );
    }

    // The transition itself must survive the added prefix.
    assert!(
        body_for("status_changed").contains("in_progress"),
        "status_changed must still report the transition"
    );
}
