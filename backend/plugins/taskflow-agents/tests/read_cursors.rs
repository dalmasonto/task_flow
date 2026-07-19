//! Stage 2 of the agent identity system: read receipts / unread cursors. A
//! member (user OR agent) records how far it has read in a channel. Both write
//! paths derive the member identity server-side and upsert the caller's own
//! cursor FORWARD only — a cursor never moves backwards.

use serde_json::json;

mod support;
use support::{
    TestApp, make_active_project_member, seed_channel_of_kind, seed_channel_with_member,
    seed_channel_without_member, seed_message, seed_project,
};
use taskflow_agents::models::TaskflowChannelKind;

/// Mint an agent key for `(project, display_name, profile)` as `user`, returning
/// `(key, agent_id)`. Mirrors the Stage-1 link flow the agent tests use.
async fn mint_agent(app: &TestApp, user: i64, project: i64) -> (String, i64) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Reader", "profile": "main" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    let body = resp.json().await;
    (
        body["key"].as_str().unwrap().to_string(),
        body["agent_id"].as_i64().unwrap(),
    )
}

/// Post a message as `user` into `channel` via the trusted send endpoint,
/// returning the created message id.
async fn send(app: &TestApp, user: i64, channel: i64, body: &str) -> i64 {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": channel, "body_markdown": body }),
        )
        .await;
    assert_eq!(resp.status(), 200, "send failed: {:?}", resp.json().await);
    resp.json().await["id"].as_i64().expect("message id")
}

// A member marks a channel read: the first read CREATES a cursor with
// member_user set; a later read at a higher message id ADVANCES it; a read at a
// lower id does NOT move it backwards. One cursor per (channel, member).
#[tokio::test]
async fn human_marks_read_upserts_cursor() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let m1 = send(&app, user, channel, "first").await;
    let m2 = send(&app, user, channel, "second").await;
    assert!(m2 > m1, "message ids must be increasing: {m1} then {m2}");

    // First read → creates the cursor pointing at m1.
    let create = app
        .post_as(
            user,
            &format!("/api/taskflow/channels/{channel}/read"),
            json!({ "last_read_message": m1 }),
        )
        .await;
    assert_eq!(create.status(), 200, "body: {:?}", create.json().await);
    let row = create.json().await;
    assert_eq!(row["member_kind"], json!("user"));
    assert_eq!(row["member_user"], json!(user));
    assert_eq!(row["member_agent"], json!(null));
    assert_eq!(row["last_read_message"], json!(m1));

    // Second read at a HIGHER id → advances forward.
    let advance = app
        .post_as(
            user,
            &format!("/api/taskflow/channels/{channel}/read"),
            json!({ "last_read_message": m2 }),
        )
        .await;
    assert_eq!(advance.status(), 200);
    assert_eq!(advance.json().await["last_read_message"], json!(m2));

    // Third read at a LOWER id → must NOT move the cursor backwards.
    let backward = app
        .post_as(
            user,
            &format!("/api/taskflow/channels/{channel}/read"),
            json!({ "last_read_message": m1 }),
        )
        .await;
    assert_eq!(backward.status(), 200);
    assert_eq!(
        backward.json().await["last_read_message"],
        json!(m2),
        "a lower id must not move the cursor backwards"
    );

    // Exactly one cursor for this (channel, member) throughout.
    assert_eq!(app.count_read_cursors(channel).await, 1);
}

// An agent marks a shared project room read: the cursor stamps member_agent and
// leaves member_user null.
#[tokio::test]
async fn agent_marks_read() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project).await;

    // A shared project room in the agent's project; project scope authorizes it.
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let message = seed_message(project, channel).await;

    let resp = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/channels/{channel}/agent/read"),
            json!({ "last_read_message": message }),
        )
        .await;
    assert_eq!(resp.status(), 200, "body: {:?}", resp.json().await);
    let row = resp.json().await;
    assert_eq!(row["member_kind"], json!("agent"));
    assert_eq!(row["member_agent"], json!(agent_id));
    assert_eq!(row["member_user"], json!(null));
    assert_eq!(row["last_read_message"], json!(message));
    assert_eq!(app.count_read_cursors(channel).await, 1);
}

// A non-member human cannot mark a channel read: 403, before any message lookup.
#[tokio::test]
async fn read_requires_membership() {
    let app = TestApp::new().await;

    // Human path: an authenticated user who is neither on the roster nor an
    // active project member of the channel's (shared) project.
    let (channel, outsider) = seed_channel_without_member(&app).await;
    let project = app.project_of_channel(channel).await;
    let message = seed_message(project, channel).await;
    let denied = app
        .post_as(
            outsider,
            &format!("/api/taskflow/channels/{channel}/read"),
            json!({ "last_read_message": message }),
        )
        .await;
    assert_eq!(denied.status(), 403);

    // Agent path: an agent from a DIFFERENT project cannot mark a foreign
    // project's shared room read. The agent is minted into `other_project` by a
    // member of THAT project (link requires active membership of the target).
    let other_project = seed_project().await;
    let owner = app.create_user().await;
    make_active_project_member(other_project, owner).await;
    let (foreign_key, _) = mint_agent(&app, owner, other_project).await;
    let agent_denied = app
        .post_as_agent(
            &foreign_key,
            &format!("/api/taskflow/channels/{channel}/agent/read"),
            json!({ "last_read_message": message }),
        )
        .await;
    assert_eq!(agent_denied.status(), 403);

    // No cursor was ever written for either rejected caller.
    assert_eq!(app.count_read_cursors(channel).await, 0);
}

// A message from a DIFFERENT channel is rejected with 400 — a cursor may only
// point at a message that belongs to the channel it marks read.
#[tokio::test]
async fn read_rejects_foreign_message() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    // A message that lives in another channel (another project entirely).
    let other_project = seed_project().await;
    let other_channel = seed_channel_of_kind(other_project, TaskflowChannelKind::Project).await;
    let foreign_message = seed_message(other_project, other_channel).await;

    let resp = app
        .post_as(
            user,
            &format!("/api/taskflow/channels/{channel}/read"),
            json!({ "last_read_message": foreign_message }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(app.count_read_cursors(channel).await, 0);
}

// `unread=true` returns only what is past the agent's cursor. This is the whole
// "what do I still owe a response to?" question, answered server-side so the
// agent cannot get it wrong by comparing ids itself.
#[tokio::test]
async fn unread_filter_returns_only_messages_past_the_cursor() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let minted = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await
        .json()
        .await;
    let key = minted["key"].as_str().unwrap().to_string();
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;

    let first = seed_message(project, channel).await;
    let second = seed_message(project, channel).await;

    // No cursor yet → everything is unread.
    let all = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={channel}&unread=true"))
        .await;
    assert_eq!(all.status(), 200);
    let body = all.json().await;
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(body["unread_count"], json!(2));

    // Mark the first read → only the second remains unread.
    let marked = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/channels/{channel}/agent/read"),
            json!({ "last_read_message": first }),
        )
        .await;
    assert_eq!(marked.status(), 200);

    let rest = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={channel}&unread=true"))
        .await
        .json()
        .await;
    let rows = rest["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "only the unmarked message should remain");
    assert_eq!(rows[0]["id"].as_i64().unwrap(), second);
    assert_eq!(rest["unread_count"], json!(1));

    // Without the flag the full history still comes back — an agent must be able
    // to re-read what it already handled.
    let history = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={channel}"))
        .await
        .json()
        .await;
    assert_eq!(history["messages"].as_array().unwrap().len(), 2);
    assert_eq!(history["read_cursor"].as_i64().unwrap(), first);
}

// `since` and `unread` together take the STRICTER floor, so an explicit `since`
// can never re-deliver something already marked read.
#[tokio::test]
async fn unread_and_since_take_the_stricter_floor() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let minted = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await
        .json()
        .await;
    let key = minted["key"].as_str().unwrap().to_string();
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;

    let first = seed_message(project, channel).await;
    let second = seed_message(project, channel).await;
    let third = seed_message(project, channel).await;

    app.post_as_agent(
        &key,
        &format!("/api/taskflow/channels/{channel}/agent/read"),
        json!({ "last_read_message": second }),
    )
    .await;

    // since=<first> is LOOSER than the cursor; the cursor must still win.
    let page = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}&unread=true&since={first}"),
        )
        .await
        .json()
        .await;
    let rows = page["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "the read cursor must not be undercut by `since`");
    assert_eq!(rows[0]["id"].as_i64().unwrap(), third);
}
