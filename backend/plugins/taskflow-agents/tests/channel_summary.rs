//! #5983 item 4: per-room unread and mention counts. What must hold:
//! 1. `unread` counts in-channel messages after my read cursor that I didn't
//!    send; marking read zeroes it; thread-only replies don't count.
//! 2. `mentions` counts unread messages that target me or mention me by chip;
//!    a chip for someone else (or a longer id) doesn't count.
//! 3. A private room off my roster is absent; an outsider gets 404.
//! 4. Agents get the same shape for themselves.

mod support;

use serde_json::{Value, json};
use support::{TestApp, add_channel_roster_row, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::TaskflowChannelKind;

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

async fn send(app: &TestApp, user: i64, body: Value) -> i64 {
    let r = app.post_as(user, "/api/taskflow/agents/messages", body).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    r.json().await["id"].as_i64().unwrap()
}

fn room_of(list: &Value, channel: i64) -> Option<Value> {
    list.as_array().unwrap().iter().find(|r| r["channel"] == channel).cloned()
}

#[tokio::test(flavor = "multi_thread")]
async fn unread_and_mentions_per_room() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let me = app.create_user().await;
    make_active_project_member(project, me).await;
    let them = app.create_user().await;
    make_active_project_member(project, them).await;
    add_channel_roster_row(project, group, them).await;
    let url = format!("/api/taskflow/projects/{project}/channels/summary");

    send(&app, them, json!({ "channel": room, "body_markdown": "hello all" })).await;
    send(&app, them, json!({ "channel": room, "body_markdown": format!("ping [@Me](user:{me})") })).await;
    // A longer id that starts with mine is not me.
    send(&app, them, json!({ "channel": room, "body_markdown": format!("ping [@X](user:{me}9)") })).await;
    let root = send(&app, them, json!({ "channel": room, "body_markdown": "a root", "targets": [{ "kind": "user", "id": me }] })).await;
    // My own message isn't unread for me; a thread-only reply isn't in the room.
    send(&app, me, json!({ "channel": room, "body_markdown": "mine" })).await;
    let reply = app.post_as(them, "/api/taskflow/agents/messages", json!({ "channel": room, "body_markdown": "in thread", "thread_root": root })).await;
    assert_eq!(reply.status(), 200, "{}", reply.text());

    let list = app.get_as(me, &url).await.json().await;
    let r = room_of(&list, room).expect("the shared room");
    assert_eq!(r["unread"], 4, "{r}");
    assert_eq!(r["mentions"], 2, "{r}");
    assert_eq!(r["last"]["excerpt"], "mine");
    assert_eq!(r["is_design"], false);
    assert_eq!(r["archived"], false);
    assert!(room_of(&list, group).is_none(), "a private room off my roster is absent");

    // Marking read zeroes it.
    let last = r["last"]["id"].as_i64().unwrap();
    assert_eq!(app.post_as(me, &format!("/api/taskflow/channels/{room}/read"), json!({ "last_read_message": last })).await.status() / 100, 2);
    let r = room_of(&app.get_as(me, &url).await.json().await, room).unwrap();
    assert_eq!(r["unread"], 0);
    assert_eq!(r["mentions"], 0);

    // The group is there for its member.
    assert!(room_of(&app.get_as(them, &url).await.json().await, group).is_some());
    let stranger = app.create_user().await;
    assert_eq!(app.get_as(stranger, &url).await.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn agents_get_their_own_counts() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent) = mint_agent(&app, project, "Builder").await;
    let person = app.create_user().await;
    make_active_project_member(project, person).await;
    send(&app, person, json!({ "channel": room, "body_markdown": "for everyone" })).await;
    send(&app, person, json!({ "channel": room, "body_markdown": "you", "targets": [{ "kind": "agent", "id": agent }] })).await;

    let list = app.get_as_agent(&key, "/api/taskflow/agents/channels/summary").await.json().await;
    let r = room_of(&list, room).expect("the room");
    assert_eq!(r["unread"], 2, "{r}");
    assert_eq!(r["mentions"], 1, "{r}");
}
