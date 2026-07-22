//! Stage 6 of the agent identity system: agent-authed READ endpoints the MCP
//! needs. REST is human-authed, so these six `GET`s give an agent a
//! project-scoped read surface using its own credential (`RequireAgent`). Every
//! query is filtered to the agent's project, so an agent can only ever see its
//! own project's tasks, channels, messages, peers, and activity. A garbage or
//! absent key is 401; a channel the agent can't see is 403.

use serde_json::json;

mod support;
use support::{
    TestApp, make_active_project_member, seed_channel_of_kind, seed_message, seed_project,
};
use taskflow_agents::models::TaskflowChannelKind;
use taskflow_tasks::models::{
    TaskflowActorKind, TaskflowTask, TaskflowTaskActivity, TaskflowTaskPriority, TaskflowTaskStatus,
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

/// Seed a task in `project` with a chosen status, sort order, and optional agent
/// assignment. Returns its id.
async fn seed_task(
    project: i64,
    title: &str,
    status: TaskflowTaskStatus,
    sort_order: i64,
    assigned_agent_id: Option<i64>,
) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: title.to_string(),
            description_markdown: String::new(),
            notes_markdown: None,
            status,
            priority: TaskflowTaskPriority::Normal,
            sort_order,
            created_by: None,
            created_by_agent_id: None,
            assigned_user: None,
            assigned_agent_id,
            operator_user: None,
            operator_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            assignee_label: assigned_agent_id.map(|_| "Builder".to_string()),
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

/// Seed one activity row in `project`, optionally tied to `task`. Returns its id.
async fn seed_activity(project: i64, action: &str, task: Option<i64>) -> i64 {
    TaskflowTaskActivity::objects()
        .create(TaskflowTaskActivity {
            id: 0,
            project: ForeignKey::new(project),
            task: task.map(ForeignKey::new),
            actor_kind: TaskflowActorKind::Agent,
            actor_user: None,
            actor_agent_id: None,
            actor_label: "Builder".to_string(),
            action: action.to_string(),
            body_markdown: None,
            metadata_json: None,
            created_at: None,
        })
        .await
        .expect("create activity")
        .id
}

// whoami returns the identity behind the presented credential — the agent's own
// id, display name, and project, all derived server-side from the key.
#[tokio::test]
async fn whoami_returns_identity() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    let resp = app.get_as_agent(&key, "/api/taskflow/agents/whoami").await;
    assert_eq!(resp.status(), 200, "body: {:?}", resp.json().await);
    let body = resp.json().await;
    assert_eq!(body["agent_id"], json!(agent_id));
    assert_eq!(body["display_name"], json!("Builder"));
    assert_eq!(body["project"], json!(project));
    assert_eq!(body["identifier"].as_str().is_some(), true);
    assert_eq!(body["status"], json!("offline"));
}

// Tasks are scoped to the agent's project; `?assigned=me` narrows to tasks this
// agent has claimed; `?status=` narrows to one status. A task in another project
// is never returned.
#[tokio::test]
async fn list_tasks_scoped_to_project() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Two tasks in the agent's project: one claimed by the agent, one not. Sort
    // order proves the `sort_order, id` ordering.
    let claimed = seed_task(project, "Claimed", TaskflowTaskStatus::InProgress, 0, Some(agent_id)).await;
    let unclaimed = seed_task(project, "Unclaimed", TaskflowTaskStatus::NotStarted, 1, None).await;
    // A task in a DIFFERENT project must never appear.
    let other_project = seed_project().await;
    let foreign = seed_task(other_project, "Foreign", TaskflowTaskStatus::NotStarted, 0, None).await;

    // All tasks in the project, ordered by sort_order then id.
    let resp = app.get_as_agent(&key, "/api/taskflow/agents/tasks").await;
    assert_eq!(resp.status(), 200, "body: {:?}", resp.json().await);
    let rows = resp.json().await;
    let ids: Vec<i64> = rows.as_array().unwrap().iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![claimed, unclaimed], "project-scoped, sort_order,id ordered");
    assert!(!ids.contains(&foreign), "foreign-project task excluded");

    // `?assigned=me` → only the claimed task.
    let mine = app.get_as_agent(&key, "/api/taskflow/agents/tasks?assigned=me").await;
    assert_eq!(mine.status(), 200);
    let mine_rows = mine.json().await;
    let mine_ids: Vec<i64> = mine_rows.as_array().unwrap().iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(mine_ids, vec![claimed], "assigned=me filters to claimed tasks");

    // `?status=not_started` → only the unclaimed (not-started) task.
    let ns = app.get_as_agent(&key, "/api/taskflow/agents/tasks?status=not_started").await;
    assert_eq!(ns.status(), 200);
    let ns_rows = ns.json().await;
    let ns_ids: Vec<i64> = ns_rows.as_array().unwrap().iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(ns_ids, vec![unclaimed], "status filters to the matching status");
}

// Channels: shared rooms in the project are visible to any in-project agent;
// a DM is visible only when the agent is on its roster.
#[tokio::test]
async fn list_channels_shows_rooms_and_own_dms() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    // A DM the agent is on the roster of — visible.
    let my_dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    app.add_agent_to_channel_roster(project, my_dm, agent_id).await;
    // A DM the agent is NOT on — invisible.
    let other_dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;

    let resp = app.get_as_agent(&key, "/api/taskflow/agents/channels").await;
    assert_eq!(resp.status(), 200, "body: {:?}", resp.json().await);
    let ids: Vec<i64> = resp
        .json()
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_i64().unwrap())
        .collect();
    assert!(ids.contains(&room), "shared room visible");
    assert!(ids.contains(&my_dm), "own DM visible");
    assert!(!ids.contains(&other_dm), "someone else's DM hidden");
}

// Messages: paged forward by `since` in a channel the agent may see; a channel
// the agent CANNOT see (a DM it isn't on) is a 403. The agent's read cursor is
// reported alongside the messages.
#[tokio::test]
async fn list_messages_by_channel_since() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, _agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // A shared room the in-project agent may see, with three messages.
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let m1 = seed_message(project, room).await;
    let m2 = seed_message(project, room).await;
    let m3 = seed_message(project, room).await;

    // No `since` → all three, id-ordered.
    let all = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={room}"))
        .await;
    assert_eq!(all.status(), 200, "body: {:?}", all.json().await);
    let all_body = all.json().await;
    let all_ids: Vec<i64> = all_body["messages"].as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect();
    assert_eq!(all_ids, vec![m1, m2, m3], "all messages id-ordered");
    assert_eq!(all_body["read_cursor"], json!(null), "no cursor yet");

    // `since=m1` → only the messages after m1.
    let since = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={room}&since={m1}"))
        .await;
    assert_eq!(since.status(), 200);
    let since_ids: Vec<i64> = since.json().await["messages"].as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect();
    assert_eq!(since_ids, vec![m2, m3], "since filters to id > since");

    // After the agent marks read at m2, the cursor is reported.
    let mark = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/channels/{room}/agent/read"),
            json!({ "last_read_message": m2 }),
        )
        .await;
    assert_eq!(mark.status(), 200, "mark read: {:?}", mark.json().await);
    let after = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={room}"))
        .await;
    assert_eq!(after.json().await["read_cursor"], json!(m2), "read cursor reported");

    // A DM the agent is NOT on the roster of → 403 (it can't see the channel).
    let secret_dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let forbidden = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={secret_dm}"))
        .await;
    assert_eq!(forbidden.status(), 403, "unseen channel is forbidden");

    // An unknown channel id → 404.
    let missing = app
        .get_as_agent(&key, "/api/taskflow/agents/messages?channel=999999")
        .await;
    assert_eq!(missing.status(), 404, "unknown channel is not found");
}

// Agents and activity are both project-scoped; activity is newest-first.
#[tokio::test]
async fn list_agents_and_activity() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, caller_id) = mint_agent(&app, user, project, "Builder", "main").await;
    // A second agent in the SAME project — must appear in the peer list.
    let (_key2, peer_id) = mint_agent(&app, user, project, "Reviewer", "review").await;
    // An agent in ANOTHER project — must NOT appear.
    let other_project = seed_project().await;
    let other_user = app.create_user().await;
    make_active_project_member(other_project, other_user).await;
    let (_key3, foreign_id) = mint_agent(&app, other_user, other_project, "Outsider", "main").await;

    let agents = app.get_as_agent(&key, "/api/taskflow/agents/agents").await;
    assert_eq!(agents.status(), 200, "body: {:?}", agents.json().await);
    let ids: Vec<i64> = agents.json().await.as_array().unwrap().iter().map(|a| a["id"].as_i64().unwrap()).collect();
    assert!(ids.contains(&caller_id) && ids.contains(&peer_id), "same-project agents listed");
    assert!(!ids.contains(&foreign_id), "foreign-project agent excluded");

    // Activity: two rows in the project, one in another project.
    let a1 = seed_activity(project, "first", None).await;
    let a2 = seed_activity(project, "second", None).await;
    let foreign_activity = seed_activity(other_project, "foreign", None).await;

    let activity = app.get_as_agent(&key, "/api/taskflow/agents/activity").await;
    assert_eq!(activity.status(), 200, "body: {:?}", activity.json().await);
    let act_ids: Vec<i64> = activity.json().await.as_array().unwrap().iter().map(|a| a["id"].as_i64().unwrap()).collect();
    assert_eq!(act_ids, vec![a2, a1], "newest-first, project-scoped");
    assert!(!act_ids.contains(&foreign_activity), "foreign-project activity excluded");

    // `?task=` narrows to one task's stream.
    let task = seed_task(project, "T", TaskflowTaskStatus::NotStarted, 0, None).await;
    let ta = seed_activity(project, "on_task", Some(task)).await;
    let task_activity = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/activity?task={task}"))
        .await;
    let task_ids: Vec<i64> = task_activity.json().await.as_array().unwrap().iter().map(|a| a["id"].as_i64().unwrap()).collect();
    assert_eq!(task_ids, vec![ta], "task filter narrows to that task");
}

// Every read endpoint is agent-authed: a garbage key is 401, and an absent key
// is 401.
#[tokio::test]
async fn read_endpoints_require_agent_auth() {
    let app = TestApp::new().await;

    // No key at all — the client sends no Authorization header. Must be the first
    // request on this fresh client (no header-removal API).
    let no_key = app.get_noauth("/api/taskflow/agents/whoami").await;
    assert_eq!(no_key.status(), 401, "missing key is unauthorized");

    // A well-formed-looking but bogus key resolves to no credential → 401.
    for path in [
        "/api/taskflow/agents/whoami",
        "/api/taskflow/agents/tasks",
        "/api/taskflow/agents/channels",
        "/api/taskflow/agents/agents",
        "/api/taskflow/agents/activity",
        "/api/taskflow/agents/messages?channel=1",
    ] {
        let garbage = app.get_as_agent("tfk_deadbeef_notarealsecret", path).await;
        assert_eq!(garbage.status(), 401, "garbage key is unauthorized for {path}");
    }
}
