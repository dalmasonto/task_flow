//! #5925: a #42 Group is private to its roster, on EVERY path, like a DM.
//! Reads already were (REST, threads, media); the write and agent paths only
//! exempted `Direct`, so anyone in the project could add themselves to a
//! Group, post into it, and (as an agent) read it. What must hold for a
//! project member or agent NOT on the roster:
//! 1. can't add anyone, themselves included (a Group's owner/admin can);
//! 2. can't post, reply in a thread, or mark it read;
//! 3. an agent can't list it, read its messages or a thread in it.
//! Rostered people and agents keep working, and the shared project room is
//! unchanged for everyone.

mod support;

use serde_json::{Value, json};
use support::{
    TestApp, add_channel_roster_row, make_active_project_member, make_project_member_with_role, seed_channel_of_kind,
    seed_message, seed_project,
};
use taskflow_agents::models::TaskflowChannelKind;
use taskflow_projects::models::TaskflowProjectRole;

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

fn listed(body: &Value, channel: i64) -> bool {
    let arr = body.as_array().or_else(|| body["channels"].as_array()).cloned().unwrap_or_default();
    arr.iter().any(|c| c["id"] == channel)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_group_is_private_to_its_roster_on_every_path() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let root = seed_message(project, group).await;

    let insider = app.create_user().await;
    make_active_project_member(project, insider).await;
    add_channel_roster_row(project, group, insider).await;
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    let (key_out, _) = mint_agent(&app, project, "Off roster").await;
    let (key_in, agent_in) = mint_agent(&app, project, "On roster").await;
    app.add_agent_to_channel_roster(project, group, agent_in).await;

    // 1. Roster changes.
    let members = format!("/api/taskflow/channels/{group}/members");
    let before = app.count_channel_members(group).await;
    assert_eq!(app.post_as(outsider, &members, json!({ "user": outsider })).await.status(), 403);
    assert_eq!(app.count_channel_members(group).await, before, "an outsider joined the group");

    // 2. Person writes.
    let send = |user: i64, body: Value| {
        let app = &app;
        async move { app.post_as(user, "/api/taskflow/agents/messages", body).await.status() }
    };
    assert_eq!(send(outsider, json!({ "channel": group, "body_markdown": "hi" })).await, 403);
    assert_eq!(send(outsider, json!({ "channel": group, "body_markdown": "re", "reply_to": root })).await, 403);
    // A thread reply under a Group root (#5926).
    assert_eq!(send(outsider, json!({ "channel": group, "body_markdown": "re", "thread_root": root })).await, 403);
    assert_eq!(
        app.post_as(outsider, &format!("/api/taskflow/channels/{group}/read"), json!({ "last_read_message": root })).await.status(),
        403
    );
    assert_eq!(app.get_as(outsider, &format!("/api/taskflow/channels/{group}/attachments")).await.status() / 100, 4);
    assert_eq!(app.get_as(outsider, &format!("/api/taskflow/channels/{group}/messages/{root}/thread")).await.status() / 100, 4);

    // 3. Agent reads and writes.
    let agent_send = |key: String, body: Value| {
        let app = &app;
        async move { app.post_as_agent(&key, "/api/taskflow/agents/agent/messages", body).await.status() }
    };
    assert_eq!(agent_send(key_out.clone(), json!({ "channel": group, "body_markdown": "hi" })).await, 403);
    assert_eq!(app.get_as_agent(&key_out, &format!("/api/taskflow/agents/messages?channel={group}")).await.status(), 403);
    assert_eq!(
        app.get_as_agent(&key_out, &format!("/api/taskflow/agents/channels/{group}/messages/{root}/thread")).await.status() / 100,
        4
    );
    assert_eq!(
        app.post_as_agent(&key_out, &format!("/api/taskflow/channels/{group}/agent/read"), json!({ "last_read_message": root }))
            .await
            .status(),
        403
    );
    let list = app.get_as_agent(&key_out, "/api/taskflow/agents/channels").await.json().await;
    assert!(!listed(&list, group), "an off-roster agent sees the group: {list}");
    assert!(listed(&list, room), "the shared room must stay visible: {list}");

    // The roster keeps working.
    assert_eq!(send(insider, json!({ "channel": group, "body_markdown": "hello" })).await, 200);
    assert_eq!(agent_send(key_in.clone(), json!({ "channel": group, "body_markdown": "hello" })).await, 200);
    assert_eq!(app.get_as_agent(&key_in, &format!("/api/taskflow/agents/messages?channel={group}")).await.status(), 200);
    assert!(listed(&app.get_as_agent(&key_in, "/api/taskflow/agents/channels").await.json().await, group));
    // An insider can add the outsider; so can an owner/admin who isn't in it.
    assert_eq!(app.post_as(insider, &members, json!({ "user": outsider })).await.status(), 201);
    let third = app.create_user().await;
    make_active_project_member(project, third).await;
    assert_eq!(app.post_as(admin, &members, json!({ "user": third })).await.status(), 201);

    // The shared room is unchanged for the off-roster person and agent.
    assert_eq!(send(third, json!({ "channel": room, "body_markdown": "open room" })).await, 200);
    assert_eq!(agent_send(key_out.clone(), json!({ "channel": room, "body_markdown": "open room" })).await, 200);
}

/// A DM's roster is never an admin's to change.
#[tokio::test(flavor = "multi_thread")]
async fn an_admin_cannot_add_people_to_a_dm() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    assert_eq!(app.post_as(admin, &format!("/api/taskflow/channels/{dm}/members"), json!({ "user": admin })).await.status(), 403);
}
