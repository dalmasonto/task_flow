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

// An agent must be able to correct a task it authored. Before this the agent API
// could create a task and advance its status and nothing else — a task written
// under a superseded scheme could never be fixed, only abandoned or duplicated,
// and both lose history.
#[tokio::test]
async fn an_agent_can_edit_its_own_task() {
    let f = fixture().await;
    let created = f
        .app
        .post_as_agent(
            &f.key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "old title", "description_markdown": "old body" }),
        )
        .await
        .json()
        .await;
    let id = created["id"].as_i64().expect("task id");

    let resp = f
        .app
        .post_as_agent(
            &f.key,
            &format!("/api/taskflow/agents/tasks/{id}"),
            json!({
                "title": "new title",
                "description_markdown": "new body",
                "priority": "high",
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "an agent must be able to edit its own task");

    let body = resp.json().await;
    assert_eq!(body["id"].as_i64().unwrap(), id, "an edit must not create a new task");
    assert_eq!(body["title"], json!("new title"));
    assert_eq!(body["description_markdown"], json!("new body"));
    assert_eq!(body["priority"], json!("high"));
}

// A partial edit must leave everything it did not name alone. Sending only a
// title must not blank the description — the difference between an edit and an
// overwrite.
#[tokio::test]
async fn an_edit_leaves_unnamed_fields_untouched() {
    let f = fixture().await;
    let created = f
        .app
        .post_as_agent(
            &f.key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "t", "description_markdown": "keep me", "notes_markdown": "and me" }),
        )
        .await
        .json()
        .await;
    let id = created["id"].as_i64().expect("task id");

    let body = f
        .app
        .post_as_agent(
            &f.key,
            &format!("/api/taskflow/agents/tasks/{id}"),
            json!({ "title": "renamed" }),
        )
        .await
        .json()
        .await;

    assert_eq!(body["title"], json!("renamed"));
    assert_eq!(body["description_markdown"], json!("keep me"), "description must survive");
    assert_eq!(body["notes_markdown"], json!("and me"), "notes must survive");
}

// The project boundary is the authorization boundary, exactly as it is for the
// status and claim endpoints: an agent may only touch tasks in its own project.
#[tokio::test]
async fn an_agent_cannot_edit_a_task_in_another_project() {
    let app = TestApp::new().await;

    let project_a = seed_project().await;
    let user_a = app.create_user().await;
    make_active_project_member(project_a, user_a).await;
    let (_id_a, key_a) = mint(&app, user_a, project_a).await;

    let project_b = seed_project().await;
    let user_b = app.create_user().await;
    make_active_project_member(project_b, user_b).await;
    let (_id_b, key_b) = mint(&app, user_b, project_b).await;

    let theirs = app
        .post_as_agent(&key_b, "/api/taskflow/agents/tasks", json!({ "title": "theirs" }))
        .await
        .json()
        .await;
    let id = theirs["id"].as_i64().expect("task id");

    let resp = app
        .post_as_agent(
            &key_a,
            &format!("/api/taskflow/agents/tasks/{id}"),
            json!({ "title": "hijacked" }),
        )
        .await;
    assert_eq!(resp.status(), 403, "an agent must not edit another project's task");
}
