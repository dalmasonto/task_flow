//! #1096: a channel's pinned current state.
//!
//! What must hold: setting it appends (the newest is current, the old is
//! history), a DM's state is the DM's alone, agents on the channel may set it,
//! a denied chat:send blocks agent writes, and no message row is written.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::TaskflowChannelKind;

async fn mint_agent(app: &TestApp, project: i64, label: &str) -> (String, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(human, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await;
    let body = resp.json().await;
    (body["key"].as_str().unwrap().to_string(), body["agent_id"].as_i64().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn setting_the_state_appends_and_the_newest_is_current() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent) = mint_agent(&app, project, "Builder").await;
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let path = format!("/api/taskflow/channels/{room}/state");

    assert_eq!(app.get_as(human, &path).await.json().await["current"], serde_json::Value::Null);
    let first = app.post_as(human, &path, json!({ "body_markdown": "Branch `ui_upgrade`. Group 2 in review." })).await;
    assert_eq!(first.status(), 201, "{}", first.text());
    let by_agent = app
        .post_as_agent(&key, &format!("/api/taskflow/agents/channels/{room}/state"), json!({ "body_markdown": "Group 2 merged. Next: onboarding." }))
        .await;
    assert_eq!(by_agent.status(), 201, "{}", by_agent.text());

    let read = app.get_as(human, &format!("{path}?history=true")).await.json().await;
    assert_eq!(read["current"]["body_markdown"], "Group 2 merged. Next: onboarding.");
    assert_eq!(read["current"]["author_agent"], agent);
    assert_eq!(read["history"][0]["body_markdown"], "Branch `ui_upgrade`. Group 2 in review.");
    // The agent reads the same.
    let seen = app.get_as_agent(&key, &format!("/api/taskflow/agents/channels/{room}/state")).await.json().await;
    assert_eq!(seen["current"]["author_label"], "Builder");
    // No chat message was posted for it.
    assert_eq!(app.count_messages(room).await, 0);

    let too_long = "x".repeat(8001);
    assert_eq!(app.post_as(human, &path, json!({ "body_markdown": too_long })).await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dms_state_is_the_dms_alone() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let (key, agent) = mint_agent(&app, project, "Insider").await;
    let (outsider_key, _) = mint_agent(&app, project, "Outsider").await;
    app.add_agent_to_channel_roster(project, dm, agent).await;
    let member = app.create_user().await;
    make_active_project_member(project, member).await;

    let set = app.post_as_agent(&key, &format!("/api/taskflow/agents/channels/{dm}/state"), json!({ "body_markdown": "private plan" })).await;
    assert_eq!(set.status(), 201);
    // A project member off the roster, and an agent off it, see nothing and can write nothing.
    assert_eq!(app.get_as(member, &format!("/api/taskflow/channels/{dm}/state")).await.status(), 404);
    assert_eq!(app.post_as(member, &format!("/api/taskflow/channels/{dm}/state"), json!({ "body_markdown": "x" })).await.status(), 404);
    assert_eq!(app.get_as_agent(&outsider_key, &format!("/api/taskflow/agents/channels/{dm}/state")).await.status(), 404);
}
