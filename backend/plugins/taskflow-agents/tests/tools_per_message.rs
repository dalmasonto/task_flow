//! #5988 item 8: tools run per agent message. What must hold:
//! 1. Counts the sender's `tool:*` rows between its previous message and this
//!    one; most-used names first; the posting `send_message` isn't counted.
//! 2. Only the message's project; non-tool rows ignored.
//! 3. Looks back at most 2 h after a long silence.
//! 4. A person's message gets no entry; an invisible room is 404.

mod support;

use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{Value, json};
use support::{TestApp, add_channel_roster_row, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::TaskflowChannelKind;
use taskflow_tasks::models::{TaskflowActorKind, TaskflowTaskActivity};

async fn raw(sql: &str) {
    let pool = umbral::db::pool_dispatched();
    let r: Result<(), sqlx::Error> = match &pool {
        umbral::db::DbPool::Sqlite(p) => sqlx::query(sql).execute(p).await.map(|_| ()),
        umbral::db::DbPool::Postgres(p) => sqlx::query(sql).execute(p).await.map(|_| ()),
    };
    r.expect("raw sql");
}

fn ts(t: chrono::DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Nanos, false)
}

async fn mint_agent(app: &TestApp, project: i64, label: &str) -> (String, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let body = app
        .post_as(human, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await
        .json()
        .await;
    (body["key"].as_str().unwrap().to_string(), body["agent_id"].as_i64().unwrap())
}

async fn agent_says(app: &TestApp, key: &str, room: i64, at: chrono::DateTime<Utc>) -> i64 {
    let r = app.post_as_agent(key, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "done" })).await;
    assert_eq!(r.status() / 100, 2, "{}", r.text());
    let id = r.json().await["id"].as_i64().unwrap();
    raw(&format!("UPDATE taskflow_agent_message SET created_at = '{}' WHERE id = {id}", ts(at))).await;
    id
}

async fn activity(project: i64, agent: i64, action: &str, at: chrono::DateTime<Utc>) {
    let row = TaskflowTaskActivity::objects()
        .create(TaskflowTaskActivity {
            id: 0,
            project: umbral::orm::ForeignKey::new(project),
            task: None,
            actor_kind: TaskflowActorKind::Agent,
            actor_user: None,
            actor_agent_id: Some(agent),
            actor_label: "Builder".into(),
            action: action.into(),
            body_markdown: Some("SECRET PAYLOAD".into()),
            metadata_json: None,
            created_at: None,
        })
        .await
        .unwrap();
    raw(&format!("UPDATE taskflow_task_activity SET created_at = '{}' WHERE id = {}", ts(at), row.id)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_between_an_agents_messages() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let other = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent) = mint_agent(&app, project, "Builder").await;
    let me = app.create_user().await;
    make_active_project_member(project, me).await;
    let t = Utc::now() - Duration::hours(10);

    activity(project, agent, "tool:Read", t - Duration::minutes(60)).await;
    let m0 = agent_says(&app, &key, room, t - Duration::minutes(50)).await;
    activity(project, agent, "tool:Edit", t - Duration::minutes(40)).await;
    activity(project, agent, "tool:Edit", t - Duration::minutes(30)).await;
    activity(project, agent, "tool:mcp__taskflow__design_screenshot", t - Duration::minutes(20)).await;
    activity(project, agent, "session_stop", t - Duration::minutes(15)).await;
    activity(project, agent, "tool:mcp__taskflow__send_message", t - Duration::minutes(1)).await;
    activity(other, agent, "tool:Bash", t - Duration::minutes(10)).await;
    let m1 = agent_says(&app, &key, room, t).await;
    // A long silence: only the last 2 h before m2 count.
    activity(project, agent, "tool:Bash", t + Duration::hours(2)).await;
    activity(project, agent, "tool:Grep", t + Duration::hours(4)).await;
    let m2 = agent_says(&app, &key, room, t + Duration::hours(5)).await;
    let mine = app.post_as(me, "/api/taskflow/agents/messages", json!({ "channel": room, "body_markdown": "thanks" })).await.json().await["id"].as_i64().unwrap();

    let r = app.get_as(me, &format!("/api/taskflow/channels/{room}/tools?messages={m0},{m1},{m2},{mine}")).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b: Value = r.json().await;
    assert_eq!(b[m1.to_string()], json!({ "count": 3, "names": ["Edit", "design_screenshot"] }), "{b}");
    assert_eq!(b[m0.to_string()], json!({ "count": 1, "names": ["Read"] }), "{b}");
    assert_eq!(b[m2.to_string()], json!({ "count": 1, "names": ["Grep"] }), "{b}");
    assert!(b.get(mine.to_string()).is_none(), "a person's message has no entry: {b}");
    assert!(!b.to_string().contains("SECRET"), "payloads never leave");

    let many: Vec<String> = (1..=101).map(|i| i.to_string()).collect();
    assert_eq!(app.get_as(me, &format!("/api/taskflow/channels/{room}/tools?messages={}", many.join(","))).await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_private_room_off_my_roster_is_404() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let insider = app.create_user().await;
    make_active_project_member(project, insider).await;
    add_channel_roster_row(project, group, insider).await;
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;
    assert_eq!(app.get_as(insider, &format!("/api/taskflow/channels/{group}/tools?messages=1")).await.status(), 200);
    assert_eq!(app.get_as(outsider, &format!("/api/taskflow/channels/{group}/tools?messages=1")).await.status(), 404);
}
