//! #1113: wake-up rules, phase A.
//!
//! What must hold: delivery is a chat notice (never a terminal input), a rule
//! fires exactly once, an offline agent gets ONE batched notice on its next
//! session, a notice never wakes anyone else (no chains), and only the agent or
//! a person may aim a pane wake-up at an agent.

mod support;

use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use serde_json::{Value, json};
use support::{TestApp, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::{
    TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind, TaskflowTerminalInput,
    TaskflowWakeRule, taskflow_agent_channel_member, taskflow_agent_message, taskflow_terminal_input,
    taskflow_wake_rule,
};
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus, taskflow_task};
use umbral::orm::ForeignKey;

async fn mint_agent(app: &TestApp, project: i64, label: &str) -> (String, i64, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(human, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await;
    assert_eq!(resp.status(), 200, "{}", resp.text());
    let body = resp.json().await;
    (body["key"].as_str().unwrap().to_string(), body["agent_id"].as_i64().unwrap(), human)
}

async fn go_live(app: &TestApp, key: &str) {
    let n = umbral_testing::seq();
    let res = app
        .post_as_agent(key, "/api/taskflow/agents/sessions", json!({ "session_identifier": format!("s-{n}"), "host": "box", "pid": 1 }))
        .await;
    assert!(matches!(res.status(), 200 | 201), "{}", res.text());
}

async fn rule(id: i64) -> TaskflowWakeRule {
    TaskflowWakeRule::objects().filter(taskflow_wake_rule::ID.eq(id)).first().await.unwrap().unwrap()
}

/// Hook work is spawned off the write path; wait for it.
async fn eventually<F, Fut>(mut check: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..60 {
        if check().await {
            return true;
        }
        tokio::time::sleep(StdDuration::from_millis(50)).await;
    }
    false
}

async fn notices_for(project: i64, agent: i64) -> Vec<TaskflowAgentMessage> {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::PROJECT.eq(project) & taskflow_agent_message::TARGET_AGENT.eq(agent))
        .fetch()
        .await
        .unwrap()
        .into_iter()
        .filter(|m| m.sender_label == taskflow_agents::wakeups::SENDER_LABEL)
        .collect()
}

async fn make_due(id: i64) {
    let mut r = rule(id).await;
    r.fire_at = Some(Utc::now() - Duration::seconds(1));
    TaskflowWakeRule::objects().save(r).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_time_rule_wakes_the_agent_with_a_chat_notice_exactly_once() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (key, agent, linked_by) = mint_agent(&app, project, "Sleeper").await;
    go_live(&app, &key).await;

    let created = app
        .post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "after_time", "in_minutes": 5, "note": "Check the renderer deploy." }))
        .await;
    assert_eq!(created.status(), 201, "{}", created.text());
    let id = created.json().await["id"].as_i64().unwrap();
    assert_eq!(rule(id).await.agent.id(), agent, "an agent's own rule wakes itself");

    make_due(id).await;
    taskflow_agents::wakeups::sweep_due().await;
    taskflow_agents::wakeups::sweep_due().await; // a second sweep must not fire it again

    let r = rule(id).await;
    assert_eq!(serde_json::to_value(r.status).unwrap(), "fired");
    assert!(r.delivered_at.is_some());
    let notices = notices_for(project, agent).await;
    assert_eq!(notices.len(), 1, "fired exactly once");
    let n = &notices[0];
    assert!(n.body_markdown.starts_with(&format!("[taskflow wake-up #{id}] time is up: Check the renderer deploy.")), "{}", n.body_markdown);
    // Not "from" the agent, or its own MCP would skip it.
    assert_eq!(n.sender_agent, None);
    assert_eq!(n.sender_user, None);
    // In its private Wake-ups DM: the agent and the human who linked it.
    assert_eq!(Some(n.channel.id()), r.pane_channel.as_ref().map(|c| c.id()));
    let roster = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::CHANNEL.eq(n.channel.id()))
        .fetch()
        .await
        .unwrap();
    assert_eq!(roster.len(), 2);
    assert!(roster.iter().any(|m| m.agent.as_ref().map(|a| a.id()) == Some(agent)));
    assert!(roster.iter().any(|m| m.user.as_ref().map(|u| u.id()) == Some(linked_by)));
    // Never a raw terminal input (that could answer a permission prompt).
    let inputs = TaskflowTerminalInput::objects().filter(taskflow_terminal_input::AGENT.eq(agent)).count().await.unwrap();
    assert_eq!(inputs, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_offline_agent_gets_one_batched_notice_when_it_comes_back() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (key, agent, _) = mint_agent(&app, project, "Away").await;
    let mut ids = Vec::new();
    for note in ["First thing", "Second thing"] {
        let res = app.post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "after_time", "in_minutes": 1, "note": note })).await;
        ids.push(res.json().await["id"].as_i64().unwrap());
    }
    for id in &ids {
        make_due(*id).await;
    }
    taskflow_agents::wakeups::sweep_due().await;
    for id in &ids {
        assert_eq!(serde_json::to_value(rule(*id).await.status).unwrap(), "missed");
    }
    assert!(notices_for(project, agent).await.is_empty(), "nothing typed into an absent pane");

    go_live(&app, &key).await;
    assert!(eventually(|| async { !notices_for(project, agent).await.is_empty() }).await, "delivered on the next session");
    let notices = notices_for(project, agent).await;
    assert_eq!(notices.len(), 1, "ONE batched notice, not one per rule");
    let body = &notices[0].body_markdown;
    assert!(body.contains("2 wake-up(s) fired while you were offline"), "{body}");
    assert!(body.find("First thing").unwrap() < body.find("Second thing").unwrap(), "oldest first");
    for id in &ids {
        assert_eq!(serde_json::to_value(rule(*id).await.status).unwrap(), "fired");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_wakes_the_asker_but_its_own_reply_does_not() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent, _) = mint_agent(&app, project, "Asker").await;
    go_live(&app, &key).await;
    let q = app.post_as_agent(&key, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "Which palette?" })).await;
    let q = q.json().await["id"].as_i64().unwrap();
    let id = app
        .post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "reply_to_message", "message": q, "note": "Dalmas answered." }))
        .await
        .json()
        .await["id"]
        .as_i64()
        .unwrap();

    // Its own follow-up does not count.
    app.post_as_agent(&key, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "bump", "reply_to": q })).await;
    tokio::time::sleep(StdDuration::from_millis(300)).await;
    assert_eq!(serde_json::to_value(rule(id).await.status).unwrap(), "armed");

    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    app.post_as(human, "/api/taskflow/agents/messages", json!({ "channel": room, "body_markdown": "Ink.", "reply_to": q })).await;
    assert!(eventually(|| async { serde_json::to_value(rule(id).await.status).unwrap() == "fired" }).await);
    assert_eq!(notices_for(project, agent).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_room_rule_with_mentions_only_and_no_chains() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a_key, a, _) = mint_agent(&app, project, "Alpha").await;
    let (b_key, b, _) = mint_agent(&app, project, "Bravo").await;
    go_live(&app, &a_key).await;
    go_live(&app, &b_key).await;
    let a_rule = app
        .post_as_agent(&a_key, "/api/taskflow/agents/wakeups", json!({ "trigger": "message_in_room", "channel": room, "mentions_only": true, "note": "Someone needs you." }))
        .await
        .json()
        .await["id"]
        .as_i64()
        .unwrap();
    // Bravo watches the same room for ANY message.
    let b_rule = app
        .post_as_agent(&b_key, "/api/taskflow/agents/wakeups", json!({ "trigger": "message_in_room", "channel": room, "note": "Room activity.", "deliver": "pane" }))
        .await
        .json()
        .await["id"]
        .as_i64()
        .unwrap();

    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    // No mention: Alpha's rule stays armed; Bravo's (any message) fires.
    app.post_as(human, "/api/taskflow/agents/messages", json!({ "channel": room, "body_markdown": "general chatter" })).await;
    assert!(eventually(|| async { serde_json::to_value(rule(b_rule).await.status).unwrap() == "fired" }).await);
    assert_eq!(serde_json::to_value(rule(a_rule).await.status).unwrap(), "armed");

    // A mention by id fires Alpha's.
    app.post_as(human, "/api/taskflow/agents/messages", json!({ "channel": room, "body_markdown": format!("[@Alpha](agent:{a}) can you look?") })).await;
    assert!(eventually(|| async { serde_json::to_value(rule(a_rule).await.status).unwrap() == "fired" }).await);

    // No chains: a wake-up notice posted INTO the room wakes nobody.
    let c_rule = app
        .post_as_agent(&b_key, "/api/taskflow/agents/wakeups", json!({ "trigger": "message_in_room", "channel": room, "note": "again" }))
        .await
        .json()
        .await["id"]
        .as_i64()
        .unwrap();
    let d = app
        .post_as_agent(&a_key, "/api/taskflow/agents/wakeups", json!({ "trigger": "after_time", "in_minutes": 1, "note": "posted in the room", "deliver": "room", "deliver_channel": room }))
        .await;
    assert_eq!(d.status(), 201, "{}", d.text());
    let d = d.json().await["id"].as_i64().unwrap();
    make_due(d).await;
    taskflow_agents::wakeups::sweep_due().await;
    assert_eq!(serde_json::to_value(rule(d).await.status).unwrap(), "fired");
    tokio::time::sleep(StdDuration::from_millis(300)).await;
    assert_eq!(serde_json::to_value(rule(c_rule).await.status).unwrap(), "armed", "a wake-up notice must not wake another rule");
    let _ = b;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_unblocked_rule_fires_on_both_save_paths() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (key, _, _) = mint_agent(&app, project, "Waiter").await;
    go_live(&app, &key).await;
    let task = |title: &str, status: TaskflowTaskStatus| TaskflowTask {
        id: 0, project: ForeignKey::new(project), title: title.into(), description_markdown: String::new(), notes_markdown: None,
        status, priority: TaskflowTaskPriority::Normal, sort_order: 0, created_by: None, assigned_user: None, assigned_agent_id: None,
        review_gate: None, estimate_minutes: None, operator_user: None, operator_agent_id: None, created_by_agent_id: None,
        assignee_label: None, due_at: None, closed_at: None, github_issue_number: None, github_issue_url: None, github_repo: None,
        created_at: None, updated_at: None,
    };
    let free = TaskflowTask::objects().create(task("free", TaskflowTaskStatus::NotStarted)).await.unwrap();
    let res = app.post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "task_unblocked", "task": free.id, "note": "go" })).await;
    assert_eq!(res.status(), 400, "a task that is not blocked cannot be waited on");
    assert_eq!(res.json().await["field"], "task");

    // Manager::save path.
    let one = TaskflowTask::objects().create(task("one", TaskflowTaskStatus::Blocked)).await.unwrap();
    let r1 = app.post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "task_unblocked", "task": one.id, "note": "one is free" })).await.json().await["id"].as_i64().unwrap();
    let mut one = one;
    one.status = TaskflowTaskStatus::InProgress;
    TaskflowTask::objects().save(one).await.unwrap();
    assert!(eventually(|| async { serde_json::to_value(rule(r1).await.status).unwrap() == "fired" }).await, "post_save path");

    // update_values path (what a REST PATCH runs: bulk_post_save, ids only).
    let two = TaskflowTask::objects().create(task("two", TaskflowTaskStatus::Blocked)).await.unwrap();
    let r2 = app.post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "task_unblocked", "task": two.id, "note": "two is free" })).await.json().await["id"].as_i64().unwrap();
    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(two.id))
        .update_values(json!({ "status": "not_started" }).as_object().cloned().unwrap())
        .await
        .unwrap();
    assert!(eventually(|| async { serde_json::to_value(rule(r2).await.status).unwrap() == "fired" }).await, "bulk_post_save path");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_agent_or_a_person_may_wake_an_agents_pane() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a_key, a, _) = mint_agent(&app, project, "Alpha").await;
    let (b_key, _, _) = mint_agent(&app, project, "Bravo").await;

    // Bravo may not type into Alpha's pane…
    let pane = app.post_as_agent(&b_key, "/api/taskflow/agents/wakeups", json!({ "agent": a, "trigger": "after_time", "in_minutes": 5, "note": "do X" })).await;
    assert_eq!(pane.status(), 403);
    assert_eq!(pane.json().await["error"], "pane_not_allowed");
    // …but may leave Alpha a room message.
    let room_rule = app
        .post_as_agent(&b_key, "/api/taskflow/agents/wakeups", json!({ "agent": a, "trigger": "after_time", "in_minutes": 5, "note": "ping", "deliver": "room", "deliver_channel": room }))
        .await;
    assert_eq!(room_rule.status(), 201, "{}", room_rule.text());
    let rid = room_rule.json().await["id"].as_i64().unwrap();

    // A person (project member) may aim a pane rule at Alpha.
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let by_person = app.post_as(human, &format!("/api/taskflow/wakeups/{project}"), json!({ "agent": a, "trigger": "after_time", "in_minutes": 5, "note": "standup" })).await;
    assert_eq!(by_person.status(), 201, "{}", by_person.text());
    let pid = by_person.json().await["id"].as_i64().unwrap();
    // A non-member may not.
    let stranger = app.create_user().await;
    assert_eq!(app.post_as(stranger, &format!("/api/taskflow/wakeups/{project}"), json!({ "agent": a, "trigger": "after_time", "in_minutes": 5, "note": "x" })).await.status(), 404);

    // Agents manage only rules they made or that wake them; "deliver" is a person's call.
    let (c_key, _, _) = mint_agent(&app, project, "Charlie").await;
    assert_eq!(app.post_as_agent(&c_key, &format!("/api/taskflow/agents/wakeups/{pid}/cancel"), json!({})).await.status(), 403);
    assert_eq!(app.post_as_agent(&a_key, &format!("/api/taskflow/agents/wakeups/{pid}/pause"), json!({})).await.status(), 200, "it wakes Alpha");
    assert_eq!(app.post_as_agent(&b_key, &format!("/api/taskflow/agents/wakeups/{rid}/cancel"), json!({})).await.status(), 200, "Bravo made it");
    assert_eq!(app.post_as_agent(&a_key, &format!("/api/taskflow/agents/wakeups/{pid}/deliver"), json!({})).await.status(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn limits_and_a_person_delivering_a_missed_rule() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let (key, agent, _) = mint_agent(&app, project, "Busy").await;
    let mut last: Value = Value::Null;
    for i in 0..20 {
        let res = app.post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "after_time", "in_minutes": 60, "note": format!("n{i}") })).await;
        assert_eq!(res.status(), 201);
        last = res.json().await;
    }
    let over = app.post_as_agent(&key, "/api/taskflow/agents/wakeups", json!({ "trigger": "after_time", "in_minutes": 60, "note": "21st" })).await;
    assert_eq!(over.status(), 400);
    assert_eq!(over.json().await["field"], "agent");

    // Offline → missed → a person presses "Deliver now".
    let id = last["id"].as_i64().unwrap();
    make_due(id).await;
    taskflow_agents::wakeups::sweep_due().await;
    assert_eq!(serde_json::to_value(rule(id).await.status).unwrap(), "missed");
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let res = app.post_as(human, &format!("/api/taskflow/wakeups/{project}/{id}/deliver"), json!({})).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json().await["status"], "fired");
    assert_eq!(notices_for(project, agent).await.len(), 1);
}
