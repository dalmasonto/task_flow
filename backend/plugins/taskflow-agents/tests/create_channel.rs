//! `POST /api/taskflow/channels` — the trusted create-channel endpoint.
//!
//! A channel and its roster used to be created in two separate client calls
//! through auto-REST, which left orphan channels when the second call failed and
//! forced the roster table to stay client-writable. `visible_channel_ids` READS
//! that roster to decide who may see a DM, so a client-writable roster let
//! anyone opt into any DM. These tests pin the replacement: one call, one
//! transaction, every identity-bearing field derived server-side.

mod support;

use serde_json::json;
use support::*;
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};
use umbral::orm::ForeignKey;

const CREATE: &str = "/api/taskflow/channels";

/// Seed a bare task directly in `project` — there is no channel-facing task
/// create used here, a plain row is enough to point a `task` link at.
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
            created_by_agent_id: None,
            assigned_user: None,
            assigned_agent_id: None,
            operator_user: None,
            operator_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            assignee_label: None,
            due_at: None,
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id
}

/// Create an agent in `project` and return its id. `POST /agents/link` returns
/// `agent_id` alongside the raw key; the tests here need the id, not the key.
///
/// Note `link_agent` calls `ensure_project_room`, so minting an agent also
/// creates a shared project room — any `count_channels` baseline must be taken
/// AFTER seeding agents.
async fn seed_agent_id(app: &TestApp, project: i64, label: &str) -> i64 {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(
            human,
            "/api/taskflow/agents/link",
            serde_json::json!({ "project": project, "display_name": label, "profile": label }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await["agent_id"].as_i64().expect("agent_id")
}

// 1. The happy path: the caller lands on the roster without asking.
#[tokio::test]
async fn creator_is_added_to_the_roster() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let other = app.create_user().await;
    make_active_project_member(project, other).await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "DM",
                "members": [{ "kind": "user", "user": other }]
            }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let row = response.json().await;
    let members = row["members"].as_array().expect("members array");
    assert_eq!(members.len(), 2, "creator + the named target");
    let user_ids: Vec<i64> = members.iter().filter_map(|m| m["user"].as_i64()).collect();
    assert!(user_ids.contains(&creator), "creator must be rostered");
    assert!(user_ids.contains(&other));
    assert_eq!(row["created_by_user"], json!(creator));
}

// 2. A channel with only its creator is legal.
#[tokio::test]
async fn an_empty_member_list_yields_a_channel_with_just_the_creator() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({ "project": project, "kind": "project", "title": "Room", "members": [] }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    assert_eq!(response.json().await["members"].as_array().unwrap().len(), 1);
}

// 3. Agents can be rostered — the gap that made the one-line fix impossible.
#[tokio::test]
async fn an_agent_can_be_added_at_creation() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let agent = seed_agent_id(&app, project, "Claude").await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "Claude",
                "members": [{ "kind": "agent", "agent": agent }]
            }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let members = response.json().await["members"].as_array().unwrap().clone();
    assert!(members.iter().any(|m| m["agent"].as_i64() == Some(agent)));
    assert!(members.iter().any(|m| m["user"].as_i64() == Some(creator)));
}

// 4. Caller gate: a non-member of the project cannot create in it.
#[tokio::test]
async fn a_non_member_cannot_create_a_channel() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let outsider = app.create_user().await;

    let response = app
        .post_as(
            outsider,
            CREATE,
            json!({ "project": project, "kind": "project", "title": "Nope", "members": [] }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

// 5. Target gate: you cannot roster someone who is not in the project.
#[tokio::test]
async fn an_outsider_target_is_rejected_and_nothing_is_written() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let outsider = app.create_user().await;

    let before = app.count_channels(project).await;
    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "DM",
                "members": [{ "kind": "user", "user": outsider }]
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
    assert_eq!(response.json().await["code"], json!("not_a_project_member"));
    // Atomicity: the rejected target must not leave a half-built channel.
    assert_eq!(app.count_channels(project).await, before);
}

// 6. An agent from ANOTHER project cannot be rostered.
#[tokio::test]
async fn an_agent_from_another_project_is_rejected() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let elsewhere = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let foreign_agent = seed_agent_id(&app, elsewhere, "Foreign").await;

    let before = app.count_channels(project).await;
    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "DM",
                "members": [{ "kind": "agent", "agent": foreign_agent }]
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
    assert_eq!(app.count_channels(project).await, before);
}

// 7. A duplicate target in the member list is silently deduped, not a 500 from
// the roster's unique index. This is now the ONLY creation path, so a client
// bug here must surface as a clean success/roster-shape, never a rollback.
#[tokio::test]
async fn duplicate_members_are_deduped_not_rejected() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let other = app.create_user().await;
    make_active_project_member(project, other).await;
    let agent = seed_agent_id(&app, project, "Claude").await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "project",
                "title": "Room",
                "members": [
                    { "kind": "user", "user": other },
                    { "kind": "user", "user": other },
                    { "kind": "agent", "agent": agent },
                    { "kind": "agent", "agent": agent },
                ]
            }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let body = response.json().await;
    let members = body["members"].as_array().expect("members array");
    assert_eq!(
        members.len(),
        3,
        "creator + the user once + the agent once, not each entry duplicated: {:?}",
        members
    );
    let user_count = members
        .iter()
        .filter(|m| m["user"].as_i64() == Some(other))
        .count();
    assert_eq!(user_count, 1, "duplicate user entry collapses to one row");
    let agent_count = members
        .iter()
        .filter(|m| m["agent"].as_i64() == Some(agent))
        .count();
    assert_eq!(agent_count, 1, "duplicate agent entry collapses to one row");
}

// 8. `task` is validated against `project`: a task from another project must
// not be copied verbatim onto the channel (and from there onto every message
// in it). The request still succeeds — the link is dropped, not rejected —
// matching the established `scoped_task_link` convention used by activity
// ingest.
#[tokio::test]
async fn a_task_from_another_project_drops_the_link() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let other_project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let foreign_task = seed_task(other_project).await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "project",
                "title": "Room",
                "task": foreign_task,
                "members": []
            }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    assert_eq!(
        response.json().await["task"],
        json!(null),
        "cross-project task id must not be copied onto the channel"
    );
}
