//! Stage 5 of the agent identity system: agent-authed activity ingest. An agent
//! (via Claude Code hooks) posts its REAL actions — a single event or a batch —
//! to `POST /api/taskflow/agents/activity`. Each becomes a `TaskflowTaskActivity`
//! stamped with the agent's identity (derived server-side from the credential,
//! never accepted from the body). A `task` link survives only when that task is
//! in the agent's own project; a stale/foreign id drops the link rather than
//! failing the batch. Empty `action` is a 400; an unauthenticated caller is 401.

use serde_json::json;

mod support;
use support::{TestApp, make_active_project_member, seed_project};
use taskflow_tasks::models::{
    TaskflowActorKind, TaskflowTask, TaskflowTaskActivity, TaskflowTaskPriority, TaskflowTaskStatus,
    taskflow_task_activity,
};
use umbral::orm::ForeignKey;

/// Mint a fresh agent key for `(project, display_name, profile)` as `user`,
/// returning `(key, agent_id)`.
async fn mint_agent(
    app: &TestApp,
    user: i64,
    project: i64,
    display_name: &str,
    profile: &str,
) -> (String, i64) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": display_name, "profile": profile }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    let body = resp.json().await;
    (
        body["key"].as_str().unwrap().to_string(),
        body["agent_id"].as_i64().unwrap(),
    )
}

/// Seed a bare task directly in `project` (there is no agent-facing create used
/// here — a plain row is enough to point a `task` link at). Returns its id.
async fn seed_task(project: i64) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: "Seed task".to_string(),
            description_markdown: String::new(),
            notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            assigned_user: None,
            assigned_agent_id: None,
            assignee_label: None,
            due_at: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id
}

/// All activity rows written by `agent_id`, newest last (by id).
async fn agent_activity(agent_id: i64) -> Vec<TaskflowTaskActivity> {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::ACTOR_AGENT_ID.eq(agent_id))
        .order_by(taskflow_task_activity::ID.asc())
        .fetch()
        .await
        .expect("load agent activity")
}

// A single event and a batch both create agent-stamped rows: `actor_kind=agent`,
// `actor_agent_id=<id>`, `actor_label=<display_name>`, project = the agent's.
#[tokio::test]
async fn agent_posts_activity_single_and_batch() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Single event.
    let single = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/activity",
            json!({ "action": "Read", "body_markdown": "opened src/main.rs" }),
        )
        .await;
    assert_eq!(single.status(), 200, "body: {:?}", single.json().await);
    assert_eq!(single.json().await["created"], json!(1));

    let rows = agent_activity(agent_id).await;
    assert_eq!(rows.len(), 1, "single event wrote one row");
    let row = &rows[0];
    assert_eq!(row.actor_kind, TaskflowActorKind::Agent);
    assert_eq!(row.actor_agent_id, Some(agent_id));
    assert_eq!(row.actor_user, None);
    assert_eq!(row.actor_label, "Builder");
    assert_eq!(row.project.id(), project);
    assert_eq!(row.action, "Read");
    assert_eq!(row.body_markdown.as_deref(), Some("opened src/main.rs"));
    assert_eq!(row.task, None, "no task link supplied");

    // Batch of 3.
    let batch = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/activity",
            json!({ "events": [
                { "action": "Edit", "metadata_json": "{\"file\":\"a.rs\"}" },
                { "action": "Bash" },
                { "action": "session_stop" },
            ] }),
        )
        .await;
    assert_eq!(batch.status(), 200, "body: {:?}", batch.json().await);
    assert_eq!(batch.json().await["created"], json!(3));

    let rows = agent_activity(agent_id).await;
    assert_eq!(rows.len(), 4, "single + batch of 3 = 4 rows");
    // Every row is stamped as the agent — nothing forged from the body.
    for row in &rows {
        assert_eq!(row.actor_kind, TaskflowActorKind::Agent);
        assert_eq!(row.actor_agent_id, Some(agent_id));
        assert_eq!(row.actor_label, "Builder");
        assert_eq!(row.project.id(), project);
    }
    let edit = &rows[1];
    assert_eq!(edit.action, "Edit");
    assert_eq!(edit.metadata_json.as_deref(), Some("{\"file\":\"a.rs\"}"));
}

// The `task` link is project-scoped: a task in the agent's project keeps the
// link; a foreign-project task id stores the row with `task=None` — NOT a 400.
#[tokio::test]
async fn activity_task_link_scoped() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // A task in the agent's own project — the link is kept.
    let own_task = seed_task(project).await;
    // A task in a DIFFERENT project — the link must be dropped.
    let other_project = seed_project().await;
    let foreign_task = seed_task(other_project).await;

    let resp = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/activity",
            json!({ "events": [
                { "action": "Edit", "task": own_task },
                { "action": "Edit", "task": foreign_task },
                { "action": "Edit", "task": 999999 },
            ] }),
        )
        .await;
    assert_eq!(resp.status(), 200, "foreign/stale ids do not fail the batch");
    assert_eq!(resp.json().await["created"], json!(3), "all three rows written");

    let rows = agent_activity(agent_id).await;
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows[0].task.as_ref().map(|fk| fk.id()),
        Some(own_task),
        "same-project task keeps its link"
    );
    assert_eq!(rows[1].task, None, "foreign-project task drops the link");
    assert_eq!(rows[2].task, None, "unknown task drops the link");
}

// An empty (or whitespace-only) `action` is a 400, and nothing is written —
// including when it is buried in a batch (the batch lands whole or not at all).
#[tokio::test]
async fn activity_rejects_empty_action() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Single empty action → 400.
    let single = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/activity",
            json!({ "action": "   " }),
        )
        .await;
    assert_eq!(single.status(), 400, "empty action rejected");

    // A batch with one empty action rejects the WHOLE batch — no partial write.
    let batch = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/activity",
            json!({ "events": [
                { "action": "Read" },
                { "action": "" },
            ] }),
        )
        .await;
    assert_eq!(batch.status(), 400, "one empty action fails the batch");

    assert_eq!(
        agent_activity(agent_id).await.len(),
        0,
        "no row written by either rejected request"
    );
}

// The endpoint is agent-authed: no key and a garbage key are both 401, and
// neither writes anything.
#[tokio::test]
async fn activity_requires_agent_auth() {
    let app = TestApp::new().await;

    // No key at all — the client sends no Authorization header.
    let no_key = app
        .post_json_noauth(
            "/api/taskflow/agents/activity",
            json!({ "action": "Read" }),
        )
        .await;
    assert_eq!(no_key.status(), 401, "missing key is unauthorized");

    // A well-formed-looking but bogus key resolves to no credential → 401.
    let garbage = app
        .post_as_agent(
            "tfk_deadbeef_notarealsecret",
            "/api/taskflow/agents/activity",
            json!({ "action": "Read" }),
        )
        .await;
    assert_eq!(garbage.status(), 401, "garbage key is unauthorized");
}
