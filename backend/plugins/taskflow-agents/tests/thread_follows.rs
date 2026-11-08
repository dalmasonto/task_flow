//! #5983 item 5: following threads. What must hold:
//! 1. Replying follows the thread (read up to your reply), and the first reply
//!    makes the root's sender follow it too.
//! 2. `new_replies` counts replies after my read mark that I didn't send;
//!    marking read zeroes it; a reply of another thread can't be the mark.
//! 3. Follow / unfollow toggle; `root` must be a root of that room.
//! 4. Thread summaries carry `following` and `last_repliers`.
//! 5. A private room off my roster: 404, and never listed.

mod support;

use serde_json::{Value, json};
use support::{TestApp, add_channel_roster_row, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::TaskflowChannelKind;

async fn send(app: &TestApp, user: i64, body: Value) -> i64 {
    let r = app.post_as(user, "/api/taskflow/agents/messages", body).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    r.json().await["id"].as_i64().unwrap()
}

fn find(list: &Value, root: i64) -> Option<Value> {
    list.as_array().unwrap().iter().find(|t| t["root"] == root).cloned()
}

#[tokio::test(flavor = "multi_thread")]
async fn following_a_thread() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let asker = app.create_user().await;
    make_active_project_member(project, asker).await;
    let helper = app.create_user().await;
    make_active_project_member(project, helper).await;
    let list_url = format!("/api/taskflow/projects/{project}/threads/following");

    let root = send(&app, asker, json!({ "channel": room, "body_markdown": "can someone look at the build?" })).await;
    assert!(app.get_as(asker, &list_url).await.json().await.as_array().unwrap().is_empty(), "no replies yet, no follow");

    let r1 = send(&app, helper, json!({ "channel": room, "body_markdown": "looking", "thread_root": root })).await;
    // The replier follows, read up to their own reply.
    let t = find(&app.get_as(helper, &list_url).await.json().await, root).expect("helper follows");
    assert_eq!(t["new_replies"], 0);
    // The root's sender follows too, with the reply new for them.
    let t = find(&app.get_as(asker, &list_url).await.json().await, root).expect("asker follows");
    assert_eq!(t["replies"], 1);
    assert_eq!(t["new_replies"], 1);
    assert_eq!(t["excerpt"], "can someone look at the build?");

    let r2 = send(&app, helper, json!({ "channel": room, "body_markdown": "fixed", "thread_root": root })).await;
    let t = find(&app.get_as(asker, &list_url).await.json().await, root).unwrap();
    assert_eq!(t["new_replies"], 2);
    assert_eq!(t["last_repliers"], json!([format!("Project Member {helper}")]));
    // The helper's own reply isn't new for them.
    assert_eq!(find(&app.get_as(helper, &list_url).await.json().await, root).unwrap()["new_replies"], 0);

    // Mark read.
    let read = format!("/api/taskflow/channels/{room}/threads/{root}/read");
    assert_eq!(app.post_as(asker, &read, json!({ "last_read_reply": r1 })).await.status(), 200);
    assert_eq!(find(&app.get_as(asker, &list_url).await.json().await, root).unwrap()["new_replies"], 1);
    assert_eq!(app.post_as(asker, &read, json!({ "last_read_reply": r2 })).await.status(), 200);
    assert_eq!(find(&app.get_as(asker, &list_url).await.json().await, root).unwrap()["new_replies"], 0);
    // The mark never moves back.
    app.post_as(asker, &read, json!({ "last_read_reply": r1 })).await;
    assert_eq!(find(&app.get_as(asker, &list_url).await.json().await, root).unwrap()["new_replies"], 0);
    // A message that isn't a reply here can't be the mark.
    let other = send(&app, asker, json!({ "channel": room, "body_markdown": "unrelated" })).await;
    assert_eq!(app.post_as(asker, &read, json!({ "last_read_reply": other })).await.status(), 400);

    // Summaries.
    let s = app.get_as(asker, &format!("/api/taskflow/channels/{room}/threads?roots={root}")).await.json().await;
    assert_eq!(s[root.to_string()]["following"], true, "{s}");
    assert_eq!(s[root.to_string()]["last_reply_by"], format!("Project Member {helper}"));

    // Unfollow, follow.
    let follow = format!("/api/taskflow/channels/{room}/threads/{root}/follow");
    assert_eq!(app.delete_as(asker, &follow).await.json().await["following"], false);
    assert!(find(&app.get_as(asker, &list_url).await.json().await, root).is_none());
    let s = app.get_as(asker, &format!("/api/taskflow/channels/{room}/threads?roots={root}")).await.json().await;
    assert_eq!(s[root.to_string()]["following"], false);
    assert_eq!(app.post_as(asker, &follow, json!({})).await.json().await["following"], true);
    assert!(find(&app.get_as(asker, &list_url).await.json().await, root).is_some());
    // A reply isn't a root.
    assert_eq!(app.post_as(asker, &format!("/api/taskflow/channels/{room}/threads/{r1}/follow"), json!({})).await.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn private_threads_stay_private() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let insider = app.create_user().await;
    make_active_project_member(project, insider).await;
    add_channel_roster_row(project, group, insider).await;
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;

    let root = send(&app, insider, json!({ "channel": group, "body_markdown": "secret plan" })).await;
    send(&app, insider, json!({ "channel": group, "body_markdown": "step one", "thread_root": root })).await;
    let follow = format!("/api/taskflow/channels/{group}/threads/{root}/follow");
    assert_eq!(app.post_as(outsider, &follow, json!({})).await.status(), 404);
    assert!(app.get_as(outsider, &format!("/api/taskflow/projects/{project}/threads/following")).await.json().await.as_array().unwrap().is_empty());

    // Someone who follows and then leaves the room no longer sees it listed.
    let leaver = app.create_user().await;
    make_active_project_member(project, leaver).await;
    add_channel_roster_row(project, group, leaver).await;
    assert_eq!(app.post_as(leaver, &follow, json!({})).await.status(), 200);
    let list = format!("/api/taskflow/projects/{project}/threads/following");
    assert!(find(&app.get_as(leaver, &list).await.json().await, root).is_some());
    taskflow_agents::models::TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agents::models::taskflow_agent_channel_member::CHANNEL.eq(group)
                & taskflow_agents::models::taskflow_agent_channel_member::USER.eq(leaver),
        )
        .delete()
        .await
        .unwrap();
    assert!(find(&app.get_as(leaver, &list).await.json().await, root).is_none());
}
