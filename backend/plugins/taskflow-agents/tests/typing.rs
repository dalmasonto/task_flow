//! #5988 item 6: typing events. What must hold:
//! 1. A visible shared room publishes one `typing` event to
//!    `project:{p}:typing` with server-derived `who`, `label`, `until`.
//! 2. A private room (DM/Group) is accepted and dropped: nothing published.
//! 3. A second event within the throttle is dropped.
//! 4. `context` is validated (allowlisted kind, route shape); unknown fields
//!    422; an invisible room 404; an archived one 409.
//! 5. Agents publish as themselves.

mod support;

use std::collections::HashSet;

use serde_json::{Value, json};
use support::{TestApp, add_channel_roster_row, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::TaskflowChannelKind;
use umbral_realtime::Realtime;

async fn watch(group: &str) -> tokio::sync::mpsc::Receiver<std::sync::Arc<umbral_realtime::Delivery>> {
    let (_id, rx) = Realtime::registry().register(None, HashSet::from([group.to_string()]), 16).await.expect("register");
    rx
}

fn drain(rx: &mut tokio::sync::mpsc::Receiver<std::sync::Arc<umbral_realtime::Delivery>>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if ev.event == "typing" {
            out.push(ev.data.clone());
        }
    }
    out
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

#[tokio::test(flavor = "multi_thread")]
async fn typing_in_rooms() {
    let app = TestApp::new_with_realtime().await;
    taskflow_agents::typing::reset_throttle();
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let me = app.create_user().await;
    make_active_project_member(project, me).await;
    add_channel_roster_row(project, group, me).await;
    let mut rx = watch(&format!("project:{project}:typing")).await;
    let url = |c: i64| format!("/api/taskflow/channels/{c}/typing");

    let r = app.post_as(me, &url(room), json!({ "context": { "kind": "design_page", "route": "/board" } })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json().await["published"], true);
    let evs = drain(&mut rx);
    assert_eq!(evs.len(), 1, "{evs:?}");
    assert_eq!(evs[0]["channel"], room);
    assert_eq!(evs[0]["who"], json!({ "kind": "user", "id": me }));
    assert_eq!(evs[0]["label"], format!("Project Member {me}"));
    assert_eq!(evs[0]["context"], json!({ "kind": "design_page", "route": "/board" }));
    assert!(evs[0]["until"].is_string());

    // Throttled.
    assert_eq!(app.post_as(me, &url(room), json!({})).await.json().await["published"], false);
    assert!(drain(&mut rx).is_empty());

    // A private room: accepted and dropped.
    let r = app.post_as(me, &url(group), json!({})).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.json().await["published"], false);
    assert!(drain(&mut rx).is_empty(), "nothing from a private room");

    // Validation.
    taskflow_agents::typing::reset_throttle();
    for bad in [
        json!({ "context": { "kind": "anything" } }),
        json!({ "context": { "kind": "design_page", "route": "board" } }),
        json!({ "context": { "kind": "design_page", "route": format!("/{}", "x".repeat(200)) } }),
        json!({ "context": { "kind": "design_comment" } }),
    ] {
        assert_eq!(app.post_as(me, &url(room), bad.clone()).await.status(), 400, "{bad}");
    }
    assert_eq!(app.post_as(me, &url(room), json!({ "who": "someone" })).await.status(), 422);
    assert!(drain(&mut rx).is_empty(), "a refused request publishes nothing");

    // Not visible: 404. Archived: 409.
    let stranger = app.create_user().await;
    assert_eq!(app.post_as(stranger, &url(room), json!({})).await.status(), 404);
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;
    assert_eq!(app.post_as(outsider, &url(group), json!({})).await.status(), 404);
    let mut v = serde_json::Map::new();
    v.insert("archived".into(), json!(true));
    taskflow_agents::models::TaskflowAgentChannel::objects()
        .filter(taskflow_agents::models::taskflow_agent_channel::ID.eq(room))
        .update_values(v)
        .await
        .unwrap();
    assert_eq!(app.post_as(me, &url(room), json!({})).await.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn agents_type_as_themselves() {
    let app = TestApp::new_with_realtime().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent) = mint_agent(&app, project, "Builder").await;
    let mut rx = watch(&format!("project:{project}:typing")).await;
    let r = app.post_as_agent(&key, &format!("/api/taskflow/agents/channels/{room}/typing"), json!({})).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let evs = drain(&mut rx);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["who"], json!({ "kind": "agent", "id": agent }));
    assert_eq!(evs[0]["label"], "Builder");
    assert_eq!(evs[0]["context"], Value::Null);
}
