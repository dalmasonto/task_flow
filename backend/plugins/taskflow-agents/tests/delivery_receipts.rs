//! #5988 item 7: delivery receipts. What must hold:
//! 1. The agent (from its key) reports a message it can read: 201, then 200
//!    with the same row; the message row is untouched.
//! 2. Not its own message (400), not a private room off its roster (404),
//!    not another project's message (404); `pane` must look like `%4`.
//! 3. People read receipts per message, batched; `[]` for none; an
//!    invisible room 404; more than 100 ids 400.

mod support;

use serde_json::{Value, json};
use support::{TestApp, add_channel_roster_row, make_active_project_member, seed_channel_of_kind, seed_message, seed_project};
use taskflow_agents::models::{TaskflowAgentMessage, TaskflowChannelKind, taskflow_agent_message};

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

fn url(m: i64) -> String {
    format!("/api/taskflow/agents/messages/{m}/delivered")
}

#[tokio::test(flavor = "multi_thread")]
async fn agents_report_and_people_read() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let (key, agent) = mint_agent(&app, project, "Builder").await;
    let (key2, agent2) = mint_agent(&app, project, "Reviewer").await;
    let me = app.create_user().await;
    make_active_project_member(project, me).await;
    let m = seed_message(project, room).await;
    let n = seed_message(project, room).await;

    let r = app.post_as_agent(&key, &url(m), json!({ "pane": "%4" })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    assert_eq!(r.json().await["pane"], "%4");
    let again = app.post_as_agent(&key, &url(m), json!({ "pane": "%9" })).await;
    assert_eq!(again.status(), 200);
    assert_eq!(again.json().await["pane"], "%4", "the first report stands");
    assert_eq!(app.post_as_agent(&key2, &url(m), json!({})).await.status(), 201);
    let row = TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(m)).first().await.unwrap().unwrap();
    assert!(row.edited_at.is_none(), "the message row is untouched");

    // Shape and bodies.
    for bad in ["4", "%", "%4; ls", "%x"] {
        assert_eq!(app.post_as_agent(&key, &url(n), json!({ "pane": bad })).await.status(), 400, "{bad}");
    }
    assert_eq!(app.post_as_agent(&key, &url(n), json!({ "agent": agent2 })).await.status(), 422, "the agent is never the body's");
    // Its own message.
    let own = app.post_as_agent(&key, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "mine" })).await.json().await["id"].as_i64().unwrap();
    let r = app.post_as_agent(&key, &url(own), json!({})).await;
    assert_eq!(r.status(), 400);
    assert_eq!(r.json().await["error"], "own_message");
    // A private room off its roster, and another project's message.
    let secret = seed_message(project, group).await;
    assert_eq!(app.post_as_agent(&key, &url(secret), json!({})).await.status(), 404);
    let elsewhere = seed_project().await;
    let far = seed_message(elsewhere, seed_channel_of_kind(elsewhere, TaskflowChannelKind::Project).await).await;
    assert_eq!(app.post_as_agent(&key, &url(far), json!({})).await.status(), 404);
    assert_eq!(app.post_as_agent(&key, &url(999_999), json!({})).await.status(), 404);

    // People read.
    let b: Value = app.get_as(me, &format!("/api/taskflow/channels/{room}/deliveries?messages={m},{n}")).await.json().await;
    let on_m = b[m.to_string()].as_array().unwrap();
    assert_eq!(on_m.len(), 2, "{b}");
    assert_eq!(on_m[0]["agent"], agent);
    assert_eq!(on_m[0]["label"], "Builder");
    assert_eq!(on_m[0]["pane"], "%4");
    assert!(on_m[0]["delivered_at"].is_string());
    assert_eq!(b[n.to_string()], json!([]));
    // A message of another room through this room's path reads as none.
    let other = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let b: Value = app.get_as(me, &format!("/api/taskflow/channels/{other}/deliveries?messages={m}")).await.json().await;
    assert_eq!(b[m.to_string()], json!([]));
    let many: Vec<String> = (1..=101).map(|i| i.to_string()).collect();
    assert_eq!(app.get_as(me, &format!("/api/taskflow/channels/{room}/deliveries?messages={}", many.join(","))).await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn private_rooms_follow_their_roster() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let (key, agent) = mint_agent(&app, project, "Builder").await;
    app.add_agent_to_channel_roster(project, group, agent).await;
    let insider = app.create_user().await;
    make_active_project_member(project, insider).await;
    add_channel_roster_row(project, group, insider).await;
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;
    let m = seed_message(project, group).await;

    assert_eq!(app.post_as_agent(&key, &url(m), json!({ "pane": "%1" })).await.status(), 201);
    let path = format!("/api/taskflow/channels/{group}/deliveries?messages={m}");
    assert_eq!(app.get_as(insider, &path).await.json().await[m.to_string()].as_array().unwrap().len(), 1);
    assert_eq!(app.get_as(outsider, &path).await.status(), 404);
}
