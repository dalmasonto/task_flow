//! #5949: pins and reactions. What must hold:
//! 1. Pins: anyone who can see the room pins and unpins (idempotent); a
//!    thread-only reply can't be pinned; another room's message 404; the list
//!    is newest first with an excerpt; an archived room refuses writes; a
//!    private room's pins are invisible off its roster.
//! 2. Agents get the room's pins on the first page of a room read and a pin
//!    count in their room list.
//! 3. Reactions: an allowlist; a toggle; summaries count, say `mine`, and are
//!    batched per page (<= 100 ids); private rooms stay private.
//! 4. Neither writes the message row (no pane re-type).

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

async fn edited_at(message: i64) -> Option<String> {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(message))
        .first()
        .await
        .unwrap()
        .unwrap()
        .edited_at
        .map(|t| t.to_rfc3339())
}

#[tokio::test(flavor = "multi_thread")]
async fn pinning() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let other = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let a = seed_message(project, room).await;
    let b = seed_message(project, room).await;
    let elsewhere = seed_message(project, other).await;
    let me = app.create_user().await;
    make_active_project_member(project, me).await;
    let pins = format!("/api/taskflow/channels/{room}/pins");

    assert_eq!(app.post_as(me, &pins, json!({ "message": a })).await.status(), 201);
    assert_eq!(app.post_as(me, &pins, json!({ "message": a })).await.status(), 200);
    assert_eq!(app.post_as(me, &pins, json!({ "message": b })).await.status(), 201);
    assert_eq!(app.post_as(me, &pins, json!({ "message": elsewhere })).await.status(), 404);
    assert_eq!(app.post_as(me, &pins, json!({ "message": a, "note": "x" })).await.status(), 422);
    // #6003: a chip in the pinned message reads as `@Name` in the excerpt.
    let mut v = serde_json::Map::new();
    v.insert("body_markdown".into(), json!("ship it [@Ann](user:3)"));
    TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(b)).update_values(v).await.unwrap();
    let list = app.get_as(me, &pins).await.json().await;
    assert_eq!(list[0]["excerpt"], "ship it @Ann", "{list}");
    let ids: Vec<i64> = list.as_array().unwrap().iter().map(|p| p["message"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![b, a], "newest pin first");
    assert!(list[0]["excerpt"].is_string());
    assert_eq!(list[0]["pinned_by_label"], format!("Project Member {me}"), "{list}");
    // The message row is untouched.
    assert_eq!(edited_at(a).await, None);

    // A thread-only reply can't be pinned.
    let reply = seed_message(project, room).await;
    let mut v = serde_json::Map::new();
    v.insert("thread_root".into(), json!(a));
    v.insert("in_channel".into(), json!(false));
    TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(reply)).update_values(v).await.unwrap();
    let r = app.post_as(me, &pins, json!({ "message": reply })).await;
    assert_eq!(r.status(), 400);
    assert_eq!(r.json().await["error"], "not_a_root");

    // Another room's pin can't be removed through this room's path.
    let other_pins = format!("/api/taskflow/channels/{other}/pins");
    assert_eq!(app.post_as(me, &other_pins, json!({ "message": elsewhere })).await.status(), 201);
    assert_eq!(app.delete_as(me, &format!("{pins}/{elsewhere}")).await.json().await["unpinned"], false);
    assert_eq!(app.get_as(me, &other_pins).await.json().await.as_array().unwrap().len(), 1);
    assert_eq!(app.delete_as(me, &format!("{pins}/{a}")).await.json().await["unpinned"], true);
    assert_eq!(app.delete_as(me, &format!("{pins}/{a}")).await.json().await["unpinned"], false);
    assert_eq!(app.get_as(me, &pins).await.json().await.as_array().unwrap().len(), 1);

    // An outsider to the project can't see or pin.
    let stranger = app.create_user().await;
    assert_eq!(app.get_as(stranger, &pins).await.status(), 404);
    assert_eq!(app.post_as(stranger, &pins, json!({ "message": a })).await.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn private_rooms_and_archived_rooms() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let m = seed_message(project, group).await;
    let insider = app.create_user().await;
    make_active_project_member(project, insider).await;
    add_channel_roster_row(project, group, insider).await;
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;
    let (key_out, _) = mint_agent(&app, project, "Off").await;
    let pins = format!("/api/taskflow/channels/{group}/pins");

    assert_eq!(app.post_as(insider, &pins, json!({ "message": m })).await.status(), 201);
    assert_eq!(app.get_as(outsider, &pins).await.status(), 404);
    assert_eq!(app.post_as(outsider, &pins, json!({ "message": m })).await.status(), 404);
    assert_eq!(app.get_as_agent(&key_out, &format!("/api/taskflow/agents/channels/{group}/pins")).await.status(), 404);
    let react = format!("/api/taskflow/channels/{group}/messages/{m}/reactions");
    assert_eq!(app.post_as(outsider, &react, json!({ "emoji": "eyes" })).await.status(), 404);
    assert_eq!(app.get_as(outsider, &format!("/api/taskflow/channels/{group}/reactions?messages={m}")).await.status(), 404);

    // Archived: reads still work, writes 409.
    let mut v = serde_json::Map::new();
    v.insert("archived".into(), json!(true));
    taskflow_agents::models::TaskflowAgentChannel::objects()
        .filter(taskflow_agents::models::taskflow_agent_channel::ID.eq(group))
        .update_values(v)
        .await
        .unwrap();
    assert_eq!(app.get_as(insider, &pins).await.status(), 200);
    assert_eq!(app.delete_as(insider, &format!("{pins}/{m}")).await.status(), 409);
    assert_eq!(app.post_as(insider, &react, json!({ "emoji": "eyes" })).await.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn agents_read_the_pins_first() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let m = seed_message(project, room).await;
    let (key, _) = mint_agent(&app, project, "Builder").await;

    let r = app.post_as_agent(&key, &format!("/api/taskflow/agents/channels/{room}/pins"), json!({ "message": m })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    assert_eq!(r.json().await["pinned_by_label"], "Builder");

    let first = app.get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={room}")).await.json().await;
    assert_eq!(first["pins"][0]["message"], m, "{first}");
    let later = app.get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={room}&since={m}")).await.json().await;
    assert!(later.get("pins").is_none(), "only the first page carries pins");
    let rooms = app.get_as_agent(&key, "/api/taskflow/agents/channels").await.json().await;
    let mine = rooms.as_array().unwrap().iter().find(|c| c["id"] == room).unwrap().clone();
    assert_eq!(mine["pins"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn reacting() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let m = seed_message(project, room).await;
    let n = seed_message(project, room).await;
    let me = app.create_user().await;
    make_active_project_member(project, me).await;
    let you = app.create_user().await;
    make_active_project_member(project, you).await;
    let (key, _) = mint_agent(&app, project, "Builder").await;
    let react = format!("/api/taskflow/channels/{room}/messages/{m}/reactions");

    let r = app.post_as(me, &react, json!({ "emoji": "eyes" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json().await["reactions"], json!([{ "emoji": "eyes", "count": 1, "mine": true, "by": [format!("Project Member {me}")] }]));
    app.post_as(you, &react, json!({ "emoji": "eyes" })).await;
    app.post_as_agent(&key, &format!("/api/taskflow/agents/channels/{room}/messages/{m}/reactions"), json!({ "emoji": "rocket" })).await;
    assert_eq!(app.post_as(me, &react, json!({ "emoji": "😀" })).await.status(), 400);
    assert_eq!(app.post_as(me, &react, json!({ "emoji": "free text" })).await.status(), 400);

    let all: Value = app.get_as(you, &format!("/api/taskflow/channels/{room}/reactions?messages={m},{n}")).await.json().await;
    let on_m = all[m.to_string()].as_array().unwrap();
    assert_eq!(on_m[0]["emoji"], "eyes");
    assert_eq!(on_m[0]["count"], 2);
    assert_eq!(on_m[0]["mine"], true);
    assert_eq!(on_m[1]["emoji"], "rocket");
    assert_eq!(on_m[1]["mine"], false);
    assert_eq!(on_m[1]["by"], json!(["Builder"]));
    assert_eq!(all[n.to_string()], json!([]));

    // Toggle off.
    let r = app.post_as(me, &react, json!({ "emoji": "eyes" })).await.json().await;
    assert_eq!(r["reactions"][0]["count"], 1);
    assert_eq!(r["reactions"][0]["mine"], false);
    // Batch limits.
    let many: Vec<String> = (1..=101).map(|i| i.to_string()).collect();
    assert_eq!(app.get_as(me, &format!("/api/taskflow/channels/{room}/reactions?messages={}", many.join(","))).await.status(), 400);
    assert_eq!(app.get_as(me, &format!("/api/taskflow/channels/{room}/reactions?messages=1,x")).await.status(), 400);
    // Another room's message through this room's path: 404.
    let other = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let o = seed_message(project, other).await;
    assert_eq!(app.post_as(me, &format!("/api/taskflow/channels/{room}/messages/{o}/reactions"), json!({ "emoji": "eyes" })).await.status(), 404);
    assert_eq!(edited_at(m).await, None);
}

/// #5962: an agent key with `chat:send` denied can't pin, unpin or react
/// (403 capability_denied), but still reads pins and reactions.
#[tokio::test(flavor = "multi_thread")]
async fn a_key_that_may_not_post_may_not_pin_or_react() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let m = seed_message(project, room).await;
    let owner = app.create_user().await;
    support::make_project_member_with_role(project, owner, taskflow_projects::models::TaskflowProjectRole::Owner).await;
    let body = app
        .post_as(owner, "/api/taskflow/agents/link", json!({ "project": project, "display_name": "Quiet", "profile": "quiet", "denied_scopes": ["chat:send"] }))
        .await
        .json()
        .await;
    let key = body["key"].as_str().expect("key").to_string();
    let base = format!("/api/taskflow/agents/channels/{room}");

    for r in [
        app.post_as_agent(&key, &format!("{base}/pins"), json!({ "message": m })).await,
        app.delete_as_agent(&key, &format!("{base}/pins/{m}")).await,
        app.post_as_agent(&key, &format!("{base}/messages/{m}/reactions"), json!({ "emoji": "eyes" })).await,
    ] {
        assert_eq!(r.status(), 403, "{}", r.text());
        assert_eq!(r.json().await["error"], "capability_denied");
    }
    assert_eq!(app.get_as_agent(&key, &format!("{base}/pins")).await.status(), 200);
    assert_eq!(app.get_as_agent(&key, &format!("{base}/reactions?messages={m}")).await.status(), 200);
}
