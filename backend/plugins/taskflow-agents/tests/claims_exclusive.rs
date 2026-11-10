//! #1125: `claim_task` is exclusive. What must hold:
//! 1. A claims, then B claims: B gets 409 `already_claimed` naming A, and the
//!    task still belongs to A.
//! 2. A claims again: 200, unchanged, and no second activity row.
//! 3. Two concurrent claims: exactly one 200 and one 409.
//! 4. An unassigned task claimed by B: 200.
//! And the claim is a column update (no whole-row save, so no `pre_save`),
//! yet realtime still hears it (`post_save` fires with the new holder).

mod support;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{Value, json};
use support::{TestApp, make_active_project_member, seed_project};
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

async fn claim_activities(task: i64) -> usize {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::TASK.eq(task) & taskflow_task_activity::ACTION.eq("claimed_task"))
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

/// Per task id: (pre_save count, assigned_agent_id seen in each post_save).
fn seen() -> &'static Mutex<HashMap<i64, (usize, Vec<Option<i64>>)>> {
    static S: OnceLock<Mutex<HashMap<i64, (usize, Vec<Option<i64>>)>>> = OnceLock::new();
    S.get_or_init(|| {
        umbral::signals::subscribe_async("pre_save:taskflow_task", |p| {
            let id = p["instance"]["id"].as_i64();
            async move {
                if let Some(id) = id {
                    seen().lock().unwrap().entry(id).or_default().0 += 1;
                }
            }
        });
        umbral::signals::subscribe_async("post_save:taskflow_task", |p| {
            let id = p["instance"]["id"].as_i64();
            let agent = p["instance"]["assigned_agent_id"].as_i64();
            async move {
                if let Some(id) = id {
                    seen().lock().unwrap().entry(id).or_default().1.push(agent);
                }
            }
        });
        Mutex::new(HashMap::new())
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claimed_task_cannot_be_taken_by_another_agent() {
    let app = TestApp::new().await;
    let _ = seen();
    let project = seed_project().await;
    let (a_key, a) = mint_agent(&app, project, "Builder A").await;
    let (b_key, _) = mint_agent(&app, project, "Builder B").await;
    let task = seed_task(project).await;
    let (pre_base, post_base) = seen().lock().unwrap().get(&task).map(|e| (e.0, e.1.len())).unwrap_or((0, 0));

    // 4 (for A): an unassigned task is claimable.
    let (s, body) = claim(&app, &a_key, task).await;
    assert_eq!(s, 200, "{body}");
    assert_eq!(body["assigned_agent_id"], a);
    assert_eq!(body["assignee_label"], "Builder A");

    // 1: B can't take it, and is told who has it.
    let (s, body) = claim(&app, &b_key, task).await;
    assert_eq!(s, 409, "{body}");
    assert_eq!(body["error"], "already_claimed");
    assert_eq!(body["holder"]["agent_id"], a);
    assert_eq!(body["holder"]["display_name"], "Builder A");
    assert!(body["detail"].as_str().unwrap().contains("Builder A"), "the MCP shows `detail`: {body}");
    assert_eq!(holder(task).await, Some(a), "still A's");

    // 2: A again is a no-op.
    let (s, body) = claim(&app, &a_key, task).await;
    assert_eq!(s, 200);
    assert_eq!(body["assigned_agent_id"], a);
    assert_eq!(claim_activities(task).await, 1, "one claim, one activity row");

    // A column update, not a whole-row save; realtime still heard the claim once.
    let (pre, posts) = seen().lock().unwrap().get(&task).cloned().unwrap_or_default();
    assert_eq!(pre, pre_base, "the claim rewrote the whole row");
    assert_eq!(posts[post_base..], [Some(a)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_agents_claiming_at_once_make_exactly_one_winner() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (a_key, a) = mint_agent(&app, project, "Racer A").await;
    let (b_key, b) = mint_agent(&app, project, "Racer B").await;
    for _ in 0..5 {
        let task = seed_task(project).await;
        let (ra, rb) = tokio::join!(claim(&app, &a_key, task), claim(&app, &b_key, task));
        let mut statuses = [ra.0, rb.0];
        statuses.sort();
        assert_eq!(statuses, [200, 409], "exactly one winner: {ra:?} {rb:?}");
        let winner = if ra.0 == 200 { a } else { b };
        assert_eq!(holder(task).await, Some(winner), "the 200 is the holder");
        assert_eq!(claim_activities(task).await, 1);
    }
}

/// #1125 review: a task a PERSON holds isn't free for an agent to take.
#[tokio::test(flavor = "multi_thread")]
async fn a_task_a_person_holds_is_not_claimable_by_an_agent() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (key, _) = mint_agent(&app, project, "Eager").await;
    let person = app.create_user().await;
    let task = seed_task(project).await;
    let mut v = serde_json::Map::new();
    v.insert("assigned_user".into(), json!(person));
    v.insert("assignee_label".into(), json!("Achieng"));
    TaskflowTask::objects().filter(taskflow_task::ID.eq(task)).update_values(v).await.unwrap();

    let (s, body) = claim(&app, &key, task).await;
    assert_eq!(s, 409, "{body}");
    assert_eq!(body["holder"]["user_id"], person);
    assert!(body["detail"].as_str().unwrap().contains("Achieng"), "{body}");
    assert_eq!(holder(task).await, None, "still the person's");
    assert_eq!(claim_activities(task).await, 0);
}
