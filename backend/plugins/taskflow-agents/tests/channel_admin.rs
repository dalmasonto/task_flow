//! #5918/#5924: room administration. What must hold:
//! 1. PATCH title/topic: the creator or an owner/admin; another member 403;
//!    off a private room's roster 404; a DM 400; the shared rooms keep their
//!    title (409 fixed_room) but take a topic; titles unique ignoring case
//!    (409 title_taken); limits 80/280; unknown fields 422.
//! 2. Remove: the creator or an owner/admin, or yourself; never the shared
//!    room; the last person can't leave a Group (409 last_human).
//! 3. Archive: manager only, not the shared rooms; an archived room refuses
//!    posts from people and agents, edits and adds (409), until unarchived.
//! 4. Add `{agent}`: an agent of the room's project, idempotent; another
//!    project's agent 400; both or neither of user/agent 400.

mod support;

use serde_json::{Value, json};
use support::{
    TestApp, make_active_project_member, make_project_member_with_role, public_room_of, seed_channel_of_kind, seed_project,
};
use taskflow_agents::models::{TaskflowAgentChannelMember, TaskflowChannelKind, taskflow_agent_channel_member};
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

/// A Group created through the API by `creator`, with `others` on its roster.
async fn group(app: &TestApp, project: i64, creator: i64, title: &str, others: &[i64]) -> i64 {
    let members: Vec<Value> = others.iter().map(|u| json!({ "kind": "user", "user": u })).collect();
    let r = app
        .post_as(creator, "/api/taskflow/channels", json!({ "project": project, "kind": "group", "title": title, "members": members }))
        .await;
    assert_eq!(r.status(), 201, "{}", r.text());
    r.json().await["id"].as_i64().unwrap()
}

async fn member_row(channel: i64, user: i64) -> i64 {
    TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::CHANNEL.eq(channel) & taskflow_agent_channel_member::USER.eq(user))
        .first()
        .await
        .unwrap()
        .unwrap()
        .id
}

struct World {
    project: i64,
    creator: i64,
    member: i64,
    outsider: i64,
    admin: i64,
}

async fn world(app: &TestApp) -> World {
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let member = app.create_user().await;
    make_active_project_member(project, member).await;
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    World { project, creator, member, outsider, admin }
}

#[tokio::test(flavor = "multi_thread")]
async fn editing_a_room() {
    let app = TestApp::new().await;
    let w = world(&app).await;
    let g = group(&app, w.project, w.creator, "Release crew", &[w.member]).await;
    let _other = group(&app, w.project, w.creator, "Ops", &[]).await;
    let url = format!("/api/taskflow/channels/{g}");

    let r = app.patch_as(w.creator, &url, json!({ "title": "  Release   team ", "topic": "Ship v3" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b = r.json().await;
    assert_eq!(b["title"], "Release team");
    assert_eq!(b["topic"], "Ship v3");
    assert_eq!(app.patch_as(w.member, &url, json!({ "topic": "x" })).await.status(), 403);
    assert_eq!(app.patch_as(w.outsider, &url, json!({ "topic": "x" })).await.status(), 404);
    // Not in the project at all: 404 even for an open room.
    let stranger = app.create_user().await;
    let room = public_room_of(w.project).await;
    assert_eq!(app.patch_as(stranger, &format!("/api/taskflow/channels/{room}"), json!({ "topic": "x" })).await.status(), 404);
    assert_eq!(app.patch_as(w.admin, &url, json!({ "topic": null })).await.json().await["topic"], Value::Null);
    let r = app.patch_as(w.creator, &url, json!({ "title": "OPS" })).await;
    assert_eq!(r.status(), 409);
    assert_eq!(r.json().await["error"], "title_taken");
    // Full-width letters fold to the same name (NFKC).
    assert_eq!(app.patch_as(w.creator, &url, json!({ "title": "\u{FF2F}ps" })).await.status(), 409);
    assert_eq!(app.patch_as(w.creator, &url, json!({ "title": "x".repeat(81) })).await.status(), 400);
    assert_eq!(app.patch_as(w.creator, &url, json!({ "title": "  " })).await.status(), 400);
    assert_eq!(app.patch_as(w.creator, &url, json!({ "topic": "x".repeat(281) })).await.status(), 400);
    assert_eq!(app.patch_as(w.creator, &url, json!({ "archived": true })).await.status(), 422);

    // The shared room: a topic, not a title.
    let room = public_room_of(w.project).await;
    let shared = format!("/api/taskflow/channels/{room}");
    let r = app.patch_as(w.admin, &shared, json!({ "title": "Renamed" })).await;
    assert_eq!(r.status(), 409);
    assert_eq!(r.json().await["error"], "fixed_room");
    assert_eq!(app.patch_as(w.admin, &shared, json!({ "topic": "Everyone" })).await.status(), 200);
    assert_eq!(app.patch_as(w.member, &shared, json!({ "topic": "x" })).await.status(), 403);
    // A DM has no settings.
    let dm = seed_channel_of_kind(w.project, TaskflowChannelKind::Direct).await;
    support::add_channel_roster_row(w.project, dm, w.admin).await;
    assert_eq!(app.patch_as(w.admin, &format!("/api/taskflow/channels/{dm}"), json!({ "topic": "x" })).await.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_and_leaving() {
    let app = TestApp::new().await;
    let w = world(&app).await;
    let third = app.create_user().await;
    make_active_project_member(w.project, third).await;
    let g = group(&app, w.project, w.creator, "Crew", &[w.member, third]).await;
    let del = |id: i64| format!("/api/taskflow/channels/{g}/members/{id}");

    // A plain member can't remove someone else, but can leave.
    let third_row = member_row(g, third).await;
    assert_eq!(app.delete_as(w.member, &del(third_row)).await.status(), 403);
    let member_row_id = member_row(g, w.member).await;
    assert_eq!(app.delete_as(w.member, &del(member_row_id)).await.status(), 200);
    // The creator removes the third.
    assert_eq!(app.delete_as(w.creator, &del(third_row)).await.status(), 200);
    // The creator is the last person: can't leave.
    let r = app.delete_as(w.creator, &del(member_row(g, w.creator).await)).await;
    assert_eq!(r.status(), 409);
    assert_eq!(r.json().await["error"], "last_human");
    // A row of another room through this room's path: 404.
    let other = group(&app, w.project, w.member, "Other", &[]).await;
    assert_eq!(app.delete_as(w.creator, &del(member_row(other, w.member).await)).await.status(), 404);
    // The shared room's roster is fixed.
    let room = public_room_of(w.project).await;
    let (_, agent) = mint_agent(&app, w.project, "Bot").await;
    app.add_agent_to_channel_roster(w.project, room, agent).await;
    let row = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::CHANNEL.eq(room) & taskflow_agent_channel_member::AGENT.eq(agent))
        .first()
        .await
        .unwrap()
        .unwrap();
    let r = app.delete_as(w.admin, &format!("/api/taskflow/channels/{room}/members/{}", row.id)).await;
    assert_eq!(r.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn archiving_makes_a_room_read_only() {
    let app = TestApp::new().await;
    let w = world(&app).await;
    let (key, agent) = mint_agent(&app, w.project, "Bot").await;
    let g = group(&app, w.project, w.creator, "Crew", &[w.member]).await;
    app.add_agent_to_channel_roster(w.project, g, agent).await;
    let base = format!("/api/taskflow/channels/{g}");

    assert_eq!(app.post_as(w.member, &format!("{base}/archive"), json!({})).await.status(), 403);
    let r = app.post_as(w.creator, &format!("{base}/archive"), json!({})).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json().await["archived"], true);

    let send = app.post_as(w.member, "/api/taskflow/agents/messages", json!({ "channel": g, "body_markdown": "hi" })).await;
    assert_eq!(send.status(), 409);
    let send = app.post_as_agent(&key, "/api/taskflow/agents/agent/messages", json!({ "channel": g, "body_markdown": "hi" })).await;
    assert_eq!(send.status(), 409);
    assert_eq!(app.patch_as(w.creator, &base, json!({ "topic": "x" })).await.status(), 409);
    assert_eq!(app.post_as(w.creator, &format!("{base}/members"), json!({ "user": w.outsider })).await.status(), 409);

    assert_eq!(app.post_as(w.admin, &format!("{base}/unarchive"), json!({})).await.json().await["archived"], false);
    let send = app.post_as(w.member, "/api/taskflow/agents/messages", json!({ "channel": g, "body_markdown": "back" })).await;
    assert_eq!(send.status(), 200, "{}", send.text());

    // The shared room can't be archived.
    let room = public_room_of(w.project).await;
    assert_eq!(app.post_as(w.admin, &format!("/api/taskflow/channels/{room}/archive"), json!({})).await.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn adding_an_agent() {
    let app = TestApp::new().await;
    let w = world(&app).await;
    let (_, agent) = mint_agent(&app, w.project, "Bot").await;
    let elsewhere = seed_project().await;
    let (_, foreign) = mint_agent(&app, elsewhere, "Foreign").await;
    let g = group(&app, w.project, w.creator, "Crew", &[]).await;
    let url = format!("/api/taskflow/channels/{g}/members");

    let r = app.post_as(w.creator, &url, json!({ "agent": agent })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    assert_eq!(r.json().await["agent"], agent);
    assert_eq!(app.post_as(w.creator, &url, json!({ "agent": agent })).await.status(), 200);
    assert_eq!(app.post_as(w.creator, &url, json!({ "agent": foreign })).await.status(), 400);
    assert_eq!(app.post_as(w.creator, &url, json!({ "agent": agent, "user": w.member })).await.status(), 400);
    assert_eq!(app.post_as(w.creator, &url, json!({})).await.status(), 400);
    // A revoked agent can't be added.
    let (_, gone) = mint_agent(&app, w.project, "Gone").await;
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!("revoked"));
    taskflow_agents::models::TaskflowAgent::objects()
        .filter(taskflow_agents::models::taskflow_agent::ID.eq(gone))
        .update_values(v)
        .await
        .unwrap();
    assert_eq!(app.post_as(w.creator, &url, json!({ "agent": gone })).await.status(), 400);
    // Off the roster of a private room: no adding agents either.
    assert_eq!(app.post_as(w.outsider, &url, json!({ "agent": agent })).await.status(), 403);
}
