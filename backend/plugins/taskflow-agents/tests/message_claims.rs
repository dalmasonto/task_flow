//! #1095: claiming a message ("answering…").
//!
//! What must hold: one active claim per message — under a race too, which is
//! the database's job (partial unique index) — the claim clears the moment the
//! claimer replies, expires on its own, and never writes the message row.

mod support;

use chrono::{Duration, Utc};
use serde_json::{Value, json};
use support::{TestApp, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::{
    TaskflowAgentMessage, TaskflowChannelKind, TaskflowChannelMemberKind, TaskflowMessageClaim,
    taskflow_agent_message, taskflow_message_claim,
};
use umbral::orm::ForeignKey;

async fn mint_agent(app: &TestApp, project: i64, label: &str) -> (String, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(human, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await;
    assert_eq!(resp.status(), 200, "{}", resp.text());
    let body = resp.json().await;
    (body["key"].as_str().unwrap().to_string(), body["agent_id"].as_i64().unwrap())
}

/// A human's message to the room — the thing two agents race to answer.
async fn ask(app: &TestApp, project: i64, room: i64) -> (i64, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let posted = app
        .post_as(human, "/api/taskflow/agents/messages", json!({ "channel": room, "body_markdown": "Can someone check the deploy?" }))
        .await;
    assert_eq!(posted.status(), 200, "{}", posted.text());
    (human, posted.json().await["id"].as_i64().unwrap())
}

fn claim_path(message: i64) -> String {
    format!("/api/taskflow/agents/messages/{message}/claim")
}

async fn claim_rows(message: i64) -> Vec<TaskflowMessageClaim> {
    TaskflowMessageClaim::objects().filter(taskflow_message_claim::MESSAGE.eq(message)).fetch().await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_second_claimer_is_told_who_holds_it() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a, a_id) = mint_agent(&app, project, "Alpha").await;
    let (b, _) = mint_agent(&app, project, "Bravo").await;
    let (_, msg) = ask(&app, project, room).await;
    let before = TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(msg)).first().await.unwrap().unwrap();

    let first = app.post_as_agent(&a, &claim_path(msg), json!({})).await;
    assert_eq!(first.status(), 201, "{}", first.text());
    let second = app.post_as_agent(&b, &claim_path(msg), json!({})).await;
    assert_eq!(second.status(), 409);
    let body = second.json().await;
    assert_eq!(body["error"], "already_claimed");
    assert_eq!(body["claim"]["claimer_agent"], a_id);
    assert_eq!(body["claim"]["claimer_label"], "Alpha");

    // Claiming again yourself extends; it never opens a second row.
    let again = app.post_as_agent(&a, &claim_path(msg), json!({ "minutes": 30 })).await;
    assert_eq!(again.status(), 200);
    assert_eq!(claim_rows(msg).await.len(), 1);

    // The message itself was never written.
    let after = TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(msg)).first().await.unwrap().unwrap();
    assert_eq!(after.edited_at, None);
    assert_eq!(after.body_markdown, before.body_markdown);

    // Everyone reads who holds it.
    let read = app.get_as_agent(&b, &claim_path(msg)).await.json().await;
    assert_eq!(read["claim"]["claimer_label"], "Alpha");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_database_refuses_a_second_open_claim_even_past_the_endpoint() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a, _) = mint_agent(&app, project, "Alpha").await;
    let (_, b_id) = mint_agent(&app, project, "Bravo").await;
    let (_, msg) = ask(&app, project, room).await;
    assert_eq!(app.post_as_agent(&a, &claim_path(msg), json!({})).await.status(), 201);

    // What a racing claimer's insert looks like once it slips past every check:
    // the partial unique index (one open claim per message) refuses it.
    let now = Utc::now();
    let racing = TaskflowMessageClaim::objects()
        .create(TaskflowMessageClaim {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(room),
            message: ForeignKey::new(msg),
            claimer_kind: TaskflowChannelMemberKind::Agent,
            claimer_user: None,
            claimer_agent: Some(ForeignKey::new(b_id)),
            claimer_label: "Bravo".into(),
            claimed_at: now,
            expires_at: now + Duration::minutes(10),
            released_at: None,
        })
        .await;
    assert!(racing.is_err(), "a second open claim on one message must be refused by the database");
    assert_eq!(claim_rows(msg).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn replying_clears_the_claim_with_no_write() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a, _) = mint_agent(&app, project, "Alpha").await;
    let (b, _) = mint_agent(&app, project, "Bravo").await;
    let (_, msg) = ask(&app, project, room).await;
    assert_eq!(app.post_as_agent(&a, &claim_path(msg), json!({})).await.status(), 201);

    // Alpha answers WITH reply_to: its claim is no longer active.
    let reply = app
        .post_as_agent(&a, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "Deploy is fine.", "reply_to": msg }))
        .await;
    assert_eq!(reply.status(), 200, "{}", reply.text());
    assert_eq!(app.get_as_agent(&b, &claim_path(msg)).await.json().await["claim"], Value::Null);
    let page = app.get_as_agent(&b, &claim_path(msg)).await;
    assert_eq!(page.status(), 200);

    // So Bravo may claim (a follow-up), and Alpha's stale row is released.
    assert_eq!(app.post_as_agent(&b, &claim_path(msg), json!({})).await.status(), 201);
    let rows = claim_rows(msg).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().filter(|c| c.released_at.is_none()).count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unrelated_reply_or_a_reply_by_someone_else_does_not_clear_it() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a, _) = mint_agent(&app, project, "Alpha").await;
    let (b, _) = mint_agent(&app, project, "Bravo").await;
    let (_, msg) = ask(&app, project, room).await;
    assert_eq!(app.post_as_agent(&a, &claim_path(msg), json!({})).await.status(), 201);

    // Bravo replies to the message; Alpha posts WITHOUT reply_to. Neither clears Alpha's claim.
    app.post_as_agent(&b, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "me too", "reply_to": msg })).await;
    app.post_as_agent(&a, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "looking" })).await;
    let read = app.get_as_agent(&b, &claim_path(msg)).await.json().await;
    assert_eq!(read["claim"]["claimer_label"], "Alpha");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claim_expires_and_only_its_holder_can_release_it() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a, _) = mint_agent(&app, project, "Alpha").await;
    let (b, _) = mint_agent(&app, project, "Bravo").await;
    let (_, msg) = ask(&app, project, room).await;

    for minutes in [0, 31] {
        let res = app.post_as_agent(&a, &claim_path(msg), json!({ "minutes": minutes })).await;
        assert_eq!(res.status(), 400);
        assert_eq!(res.json().await["field"], "minutes");
    }

    assert_eq!(app.post_as_agent(&a, &claim_path(msg), json!({})).await.status(), 201);
    assert_eq!(app.delete_as_agent(&b, &claim_path(msg)).await.status(), 404, "only the holder releases");
    assert_eq!(app.delete_as_agent(&a, &claim_path(msg)).await.status(), 200);
    assert_eq!(app.get_as_agent(&b, &claim_path(msg)).await.json().await["claim"], Value::Null);

    // Expiry: a claim whose time is up stops counting, and the next claimer takes over.
    assert_eq!(app.post_as_agent(&a, &claim_path(msg), json!({})).await.status(), 201);
    let mut open = claim_rows(msg).await.into_iter().find(|c| c.released_at.is_none()).unwrap();
    open.expires_at = Utc::now() - Duration::seconds(1);
    TaskflowMessageClaim::objects().save(open).await.unwrap();
    assert_eq!(app.get_as_agent(&b, &claim_path(msg)).await.json().await["claim"], Value::Null);
    assert_eq!(app.post_as_agent(&b, &claim_path(msg), json!({})).await.status(), 201);
}

#[tokio::test(flavor = "multi_thread")]
async fn claims_in_a_dm_stay_in_the_dm() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a, a_id) = mint_agent(&app, project, "Alpha").await;
    let (outsider_agent, _) = mint_agent(&app, project, "Outsider").await;
    app.add_agent_to_channel_roster(project, dm, a_id).await;
    let posted = app.post_as_agent(&a, "/api/taskflow/agents/agent/messages", json!({ "channel": dm, "body_markdown": "private" })).await;
    let msg = posted.json().await["id"].as_i64().unwrap();
    let human = app.create_user().await;
    make_active_project_member(project, human).await;

    // An agent off the DM roster, and a member off it, cannot claim or read it.
    assert_eq!(app.post_as_agent(&outsider_agent, &claim_path(msg), json!({})).await.status(), 404);
    assert_eq!(app.post_as(human, &format!("/api/taskflow/messages/{msg}/claim"), json!({})).await.status(), 404);
    assert_eq!(app.get_as(human, &format!("/api/taskflow/messages/{msg}/claim")).await.status(), 404);
    // The by-channel read never reaches across: a DM id in a room read is ignored.
    let page = app.get_as(human, &format!("/api/taskflow/channels/{room}/claims?messages={msg}")).await;
    assert_eq!(page.status(), 200);
    assert_eq!(page.json().await["results"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_human_can_claim_and_the_channel_read_shows_active_claims() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (a, _) = mint_agent(&app, project, "Alpha").await;
    let (human, m1) = ask(&app, project, room).await;
    let (_, m2) = ask(&app, project, room).await;

    let res = app.post_as(human, &format!("/api/taskflow/messages/{m2}/claim"), json!({})).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(app.post_as_agent(&a, &claim_path(m1), json!({})).await.status(), 201);
    // The agent cannot take the human's claim.
    assert_eq!(app.post_as_agent(&a, &claim_path(m2), json!({})).await.status(), 409);

    let page = app.get_as(human, &format!("/api/taskflow/channels/{room}/claims?messages={m1},{m2}")).await.json().await;
    let results = page["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert!(results.iter().any(|c| c["message"] == m2 && c["claimer_kind"] == "user"));
}
