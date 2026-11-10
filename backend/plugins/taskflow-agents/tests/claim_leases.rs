//! #1126: claim leases. What must hold: a task held by an agent that has been
//! silent past the lease is released by the sweep (one activity row, one
//! notice to the agent), and then another agent can claim it; a task held by
//! an agent that is heartbeating, or one the agent paused, is untouched; a
//! second sweep changes nothing.

mod support;

use chrono::{Duration, Utc};
use serde_json::{Value, json};
use support::{TestApp, make_active_project_member, seed_project};
use taskflow_agents::models::{TaskflowAgent, TaskflowAgentMessage, taskflow_agent, taskflow_agent_message};
use taskflow_tasks::models::{
    TaskflowTask, TaskflowTaskActivity, TaskflowTaskPriority, TaskflowTaskStatus, taskflow_task, taskflow_task_activity,
};
use umbral::orm::ForeignKey;

async fn mint_agent(app: &TestApp, project: i64, label: &str) -> (String, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(human, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await;
    assert_eq!(resp.status(), 200, "{}", resp.text());
    let body = resp.json().await;
    (body["key"].as_str().unwrap().to_string(), body["agent_id"].as_i64().unwrap())
}

async fn seed_task(project: i64) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0, project: ForeignKey::new(project), title: "build it".into(), description_markdown: None, notes_markdown: None,
            status: TaskflowTaskStatus::NotStarted, priority: TaskflowTaskPriority::Normal, sort_order: 0, created_by: None,
            assigned_user: None, assigned_agent_id: None, review_gate: None, estimate_minutes: None, operator_user: None,
            operator_agent_id: None, created_by_agent_id: None, assignee_label: None, due_at: None, closed_at: None,
            github_issue_number: None, github_issue_url: None, github_repo: None, created_at: None, updated_at: None,
            status_column: None,
        })
        .await
        .unwrap()
        .id
}

async fn holder(task: i64) -> Option<i64> {
    TaskflowTask::objects().filter(taskflow_task::ID.eq(task)).first().await.unwrap().unwrap().assigned_agent_id
}

async fn release_activities(task: i64) -> usize {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::TASK.eq(task) & taskflow_task_activity::ACTION.eq("claim_released"))
        .fetch()
        .await
        .unwrap()
        .len()
}

async fn claim(app: &TestApp, key: &str, task: i64) -> (u16, Value) {
    let r = app.post_as_agent(key, &format!("/api/taskflow/agents/tasks/{task}/claim"), json!({})).await;
    let s = r.status();
    (s, serde_json::from_str(&r.text()).unwrap_or(Value::Null))
}


async fn set_status(task: i64, status: &str) {
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!(status));
    TaskflowTask::objects().filter(taskflow_task::ID.eq(task)).update_values(v).await.unwrap();
}

/// Make the agent silent since `minutes` ago, and the task's last change too.
async fn age(agent: i64, task: i64, minutes: i64) {
    let then = Utc::now() - Duration::minutes(minutes);
    let mut v = serde_json::Map::new();
    v.insert("last_seen_at".into(), json!(then));
    TaskflowAgent::objects().filter(taskflow_agent::ID.eq(agent)).update_values(v).await.unwrap();
    let mut v = serde_json::Map::new();
    v.insert("updated_at".into(), json!(then));
    TaskflowTask::objects().filter(taskflow_task::ID.eq(task)).update_values(v).await.unwrap();
}

async fn notices(project: i64, agent: i64) -> Vec<String> {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::PROJECT.eq(project) & taskflow_agent_message::TARGET_AGENT.eq(agent))
        .fetch()
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.body_markdown)
        .filter(|b| b.contains("was released"))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_agents_claim_is_released_and_can_be_taken() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (a_key, a) = mint_agent(&app, project, "Gone Quiet").await;
    let (b_key, b) = mint_agent(&app, project, "Fresh").await;
    let stale = seed_task(project).await;
    let live = seed_task(project).await;
    let paused = seed_task(project).await;
    for t in [stale, live, paused] {
        assert_eq!(claim(&app, &a_key, t).await.0, 200);
    }
    set_status(stale, "in_progress").await;
    set_status(paused, "paused").await;

    // `stale` and `paused` last moved 40 minutes ago; A is silent since then.
    age(a, stale, 40).await;
    age(a, paused, 40).await;
    // `live` was touched a minute ago: inside the lease.
    let mut v = serde_json::Map::new();
    v.insert("updated_at".into(), json!(Utc::now() - Duration::minutes(1)));
    TaskflowTask::objects().filter(taskflow_task::ID.eq(live)).update_values(v).await.unwrap();

    taskflow_agents::leases::sweep_once(Utc::now(), Duration::minutes(30)).await;

    assert_eq!(holder(stale).await, None, "the silent agent's claim is released");
    assert_eq!(holder(live).await, Some(a), "inside the lease: kept");
    assert_eq!(holder(paused).await, Some(a), "a paused task keeps its assignee");
    assert_eq!(release_activities(stale).await, 1);
    let told = notices(project, a).await;
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("build it") || told[0].contains(&format!("{stale}")), "{}", told[0]);

    // Another agent can take it now; a second sweep changes nothing.
    let (s, body): (u16, Value) = claim(&app, &b_key, stale).await;
    assert_eq!(s, 200, "{body}");
    assert_eq!(holder(stale).await, Some(b));
    taskflow_agents::leases::sweep_once(Utc::now(), Duration::minutes(30)).await;
    assert_eq!(holder(stale).await, Some(b), "B just claimed: its lease is fresh");
    assert_eq!(release_activities(stale).await, 1, "still exactly one release row");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_heartbeat_keeps_the_lease() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (key, a) = mint_agent(&app, project, "Busy").await;
    let task = seed_task(project).await;
    assert_eq!(claim(&app, &key, task).await.0, 200);
    // The task hasn't changed for an hour, but the agent heartbeated just now.
    age(a, task, 60).await;
    let mut v = serde_json::Map::new();
    v.insert("last_seen_at".into(), json!(Utc::now()));
    TaskflowAgent::objects().filter(taskflow_agent::ID.eq(a)).update_values(v).await.unwrap();
    taskflow_agents::leases::sweep_once(Utc::now(), Duration::minutes(30)).await;
    assert_eq!(holder(task).await, Some(a));
    assert_eq!(release_activities(task).await, 0);
    // And the lease length is readable for the board's chip.
    let r = app.get_as_agent(&key, "/api/taskflow/claim-lease").await;
    assert_eq!(r.json().await["lease_minutes"], 30);
}
