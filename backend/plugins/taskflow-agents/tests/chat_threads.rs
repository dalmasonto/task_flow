//! Chat threads (#1132). What must hold:
//! - a thread reply names a ROOT of the same channel; anything else is a 400;
//! - a thread-only reply is `in_channel = false`, an `also_send` one is true;
//! - its targets are computed (root author, prior repliers, mentioned members
//!   who can see the channel), never empty, never a broadcast;
//! - `check_messages` hands a thread-only reply only to its agent targets (and
//!   its sender), with `unread_count` counted after that filter;
//! - the thread read returns root, replies in order and the count; the summary
//!   counts replies per root; neither leaks to someone off the channel.

mod support;

use serde_json::{Value, json};
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

async fn person_send(app: &TestApp, user: i64, body: Value) -> (u16, Value) {
    let r = app.post_as(user, "/api/taskflow/agents/messages", body).await;
    let status = r.status();
    (status, serde_json::from_str(&r.text()).unwrap_or(Value::Null))
}

async fn agent_send(app: &TestApp, key: &str, body: Value) -> (u16, Value) {
    let r = app.post_as_agent(key, "/api/taskflow/agents/agent/messages", body).await;
    let status = r.status();
    (status, serde_json::from_str(&r.text()).unwrap_or(Value::Null))
}

/// The ids `check_messages` (unread) hands this agent, and its unread_count.
async fn unread_ids(app: &TestApp, key: &str, channel: i64) -> (Vec<i64>, i64) {
    let r = app.get_as_agent(key, &format!("/api/taskflow/agents/messages?channel={channel}&unread=true")).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let body = r.json().await;
    let ids = body["messages"].as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect();
    (ids, body["unread_count"].as_i64().unwrap())
}

fn targets(m: &Value) -> Vec<(String, i64)> {
    let raw = m["targets"].as_str().unwrap_or("[]");
    let list: Vec<Value> = serde_json::from_str(raw).unwrap();
    list.iter().map(|t| (t["kind"].as_str().unwrap().to_string(), t["id"].as_i64().unwrap())).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_thread_reply_reaches_its_participants_and_no_one_else() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let person = app.create_user().await;
    make_active_project_member(project, person).await;
    let (builder_key, builder) = mint_agent(&app, project, "Builder").await;
    let (bystander_key, bystander) = mint_agent(&app, project, "Bystander").await;
    let (_, foreign) = mint_agent(&app, seed_project().await, "Foreign").await;

    let (s, root) = person_send(&app, person, json!({ "channel": room, "body_markdown": "can someone check the build?" })).await;
    assert_eq!(s, 200, "{root}");
    let root_id = root["id"].as_i64().unwrap();
    assert_eq!(root["in_channel"], true);
    assert!(root["thread_root"].is_null());

    // The builder answers in the thread only: aimed at the root's author.
    let (s, a) = agent_send(&app, &builder_key, json!({ "channel": room, "body_markdown": "on it", "thread_root": root_id })).await;
    assert_eq!(s, 200, "{a}");
    assert_eq!(a["thread_root"], root_id);
    assert_eq!(a["in_channel"], false);
    assert_eq!(targets(&a), vec![("user".into(), person)]);

    // The person replies: the builder (a prior replier) is the target.
    let (_, p) = person_send(&app, person, json!({ "channel": room, "body_markdown": "thanks", "thread_root": root_id })).await;
    assert_eq!(targets(&p), vec![("agent".into(), builder)]);
    assert_eq!(p["target_agent"], builder, "the back-compat single target follows");

    // The bystander never gets the thread-only replies; it does get the root.
    let (ids, count) = unread_ids(&app, &bystander_key, room).await;
    assert_eq!(ids, vec![root_id]);
    assert_eq!(count, 1, "unread_count is counted after the thread filter");
    // The builder gets the person's reply (not its own).
    let (ids, _) = unread_ids(&app, &builder_key, room).await;
    assert_eq!(ids, vec![root_id, p["id"].as_i64().unwrap()]);

    // Mentioning the bystander pulls it in; a foreign agent's chip is dropped.
    let (_, m) = agent_send(
        &app,
        &builder_key,
        json!({ "channel": room, "thread_root": root_id,
                "body_markdown": format!("[@Bystander](agent:{bystander}) and [@Foreign](agent:{foreign}) look") }),
    )
    .await;
    let t = targets(&m);
    assert!(t.contains(&("agent".into(), bystander)) && t.contains(&("user".into(), person)), "{t:?}");
    assert!(!t.iter().any(|(_, id)| *id == foreign), "an agent off the channel is never a target: {t:?}");
    assert!(!t.contains(&("agent".into(), builder)), "the sender is not its own target: {t:?}");
    let (ids, _) = unread_ids(&app, &bystander_key, room).await;
    assert!(ids.contains(&m["id"].as_i64().unwrap()));

    // also_send: shows in the channel and reaches everyone.
    let (_, also) = person_send(&app, person, json!({ "channel": room, "body_markdown": "fixed, FYI all", "thread_root": root_id, "also_send": true })).await;
    assert_eq!(also["in_channel"], true);
    let (ids, _) = unread_ids(&app, &bystander_key, room).await;
    assert!(ids.contains(&also["id"].as_i64().unwrap()));

    // The thread: root first, replies in order, the count.
    let t = app.get_as(person, &format!("/api/taskflow/channels/{room}/messages/{root_id}/thread")).await;
    assert_eq!(t.status(), 200, "{}", t.text());
    let t = t.json().await;
    assert_eq!(t["root"]["id"], root_id);
    let reply_ids: Vec<i64> = t["replies"].as_array().unwrap().iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(reply_ids, vec![a["id"].as_i64().unwrap(), p["id"].as_i64().unwrap(), m["id"].as_i64().unwrap(), also["id"].as_i64().unwrap()]);
    assert_eq!(t["reply_count"], 4);
    assert!(t["replies"][0]["attachments"].is_array());
    // The agent twin reads the same thread, even as a non-target.
    let at = app.get_as_agent(&bystander_key, &format!("/api/taskflow/agents/channels/{room}/messages/{root_id}/thread")).await;
    assert_eq!(at.status(), 200);
    assert_eq!(at.json().await["reply_count"], 4);
    // A reply is not a root.
    let not_root = app.get_as(person, &format!("/api/taskflow/channels/{room}/messages/{}/thread", a["id"])).await;
    assert_eq!(not_root.status(), 404);

    // The summary: one root with replies, one without (absent).
    let (_, lone) = person_send(&app, person, json!({ "channel": room, "body_markdown": "unrelated" })).await;
    let s = app.get_as(person, &format!("/api/taskflow/channels/{room}/threads?roots={root_id},{}", lone["id"])).await;
    assert_eq!(s.status(), 200, "{}", s.text());
    let s = s.json().await;
    assert_eq!(s[root_id.to_string()]["reply_count"], 4);
    assert!(s[root_id.to_string()]["last_reply_at"].is_string());
    assert!(s.get(lone["id"].to_string()).is_none());
    assert_eq!(app.get_as(person, &format!("/api/taskflow/channels/{room}/threads?roots=x")).await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_thread_root_must_be_a_root_of_this_channel() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let other_room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let person = app.create_user().await;
    make_active_project_member(project, person).await;
    let (key, _) = mint_agent(&app, project, "Builder").await;

    let (_, root) = person_send(&app, person, json!({ "channel": room, "body_markdown": "root" })).await;
    let root_id = root["id"].as_i64().unwrap();
    let (_, elsewhere) = person_send(&app, person, json!({ "channel": other_room, "body_markdown": "elsewhere" })).await;
    let (_, reply) = person_send(&app, person, json!({ "channel": room, "body_markdown": "r", "thread_root": root_id })).await;

    for bad in [elsewhere["id"].as_i64().unwrap(), reply["id"].as_i64().unwrap(), 999_999] {
        let (s, _) = person_send(&app, person, json!({ "channel": room, "body_markdown": "x", "thread_root": bad })).await;
        assert_eq!(s, 400, "person, root {bad}");
        let (s, _) = agent_send(&app, &key, json!({ "channel": room, "body_markdown": "x", "thread_root": bad })).await;
        assert_eq!(s, 400, "agent, root {bad}");
    }

    // Replying alone to your own root: the sender is the one target, so the
    // list is never empty (empty would mean broadcast).
    assert_eq!(targets(&reply), vec![("user".into(), person)]);
    assert_eq!(reply["in_channel"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_thread_stays_inside_its_dm() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let (key, insider) = mint_agent(&app, project, "Insider").await;
    let (_, outsider) = mint_agent(&app, project, "Outsider").await;
    app.add_agent_to_channel_roster(project, dm, insider).await;
    let member = app.create_user().await;
    make_active_project_member(project, member).await;

    let (s, root) = agent_send(&app, &key, json!({ "channel": dm, "body_markdown": "private" })).await;
    assert_eq!(s, 200, "{root}");
    let root_id = root["id"].as_i64().unwrap();
    // Mentioning an agent of the project who is NOT on the DM roster drops it.
    let (_, r) = agent_send(
        &app,
        &key,
        json!({ "channel": dm, "thread_root": root_id, "body_markdown": format!("[@Outsider](agent:{outsider}) see") }),
    )
    .await;
    assert_eq!(targets(&r), vec![("agent".into(), insider)], "only the sender remains");
    // A project member off the roster cannot read the thread or the summary.
    assert_eq!(app.get_as(member, &format!("/api/taskflow/channels/{dm}/messages/{root_id}/thread")).await.status(), 404);
    assert_eq!(app.get_as(member, &format!("/api/taskflow/channels/{dm}/threads?roots={root_id}")).await.status(), 404);
}

async fn row(id: i64) -> taskflow_agents::models::TaskflowAgentMessage {
    use taskflow_agents::models::{TaskflowAgentMessage, taskflow_agent_message};
    TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(id)).first().await.unwrap().unwrap()
}

/// #1132 review: deleting a root (the admin UI can) must not orphan its
/// replies, hidden from the feed with no thread to open. They are released
/// into the channel. Both delete paths: per-row and queryset (bulk).
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_root_releases_its_replies_into_the_channel() {
    use taskflow_agents::models::{TaskflowAgentMessage, taskflow_agent_message};
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let person = app.create_user().await;
    make_active_project_member(project, person).await;

    let mut replies = Vec::new();
    for bulk in [false, true] {
        let (_, root) = person_send(&app, person, json!({ "channel": room, "body_markdown": "root" })).await;
        let root_id = root["id"].as_i64().unwrap();
        let (_, reply) = person_send(&app, person, json!({ "channel": room, "body_markdown": "r", "thread_root": root_id })).await;
        let reply_id = reply["id"].as_i64().unwrap();
        assert!(!row(reply_id).await.in_channel);
        if bulk {
            TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(root_id)).delete().await.unwrap();
        } else {
            let r = row(root_id).await;
            TaskflowAgentMessage::objects().delete_instance(&r).await.unwrap();
        }
        replies.push((bulk, reply_id));
    }
    for (bulk, id) in replies {
        let mut released = false;
        for _ in 0..100 {
            let r = row(id).await;
            if r.in_channel && r.thread_root.is_none() {
                released = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(released, "bulk={bulk}: the reply was left orphaned");
    }
}
