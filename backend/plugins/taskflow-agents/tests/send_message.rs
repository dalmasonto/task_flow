//! The send endpoint is the only trusted write path for messages: it derives
//! the sender from the authenticated identity and refuses non-members.

use serde_json::json;

mod support;
use support::{
    TestApp, seed_channel_with_member, seed_channel_without_member, seed_project_member_off_roster,
};
use taskflow_agents::models::TaskflowChannelKind;
use taskflow_projects::models::TaskflowMembershipStatus;

#[tokio::test]
async fn derives_sender_from_identity_and_ignores_client_claims() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    // The client lies about who it is. The server must not believe it.
    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "hello",
                "sender_label": "Totally The CEO",
                "sender_user": 9999,
                "sender_kind": "agent",
            }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    assert_eq!(row["sender_user"], json!(user));
    assert_eq!(row["sender_kind"], json!("user"));
    // Pin the actual derived value, not merely "not the client's lie" — the
    // latter would also pass for null, "", or any other wrong value.
    assert_eq!(row["sender_label"], json!(format!("Member {user}")));
}

#[tokio::test]
async fn rejects_non_member_with_403() {
    let app = TestApp::new().await;
    let (channel, outsider) = seed_channel_without_member(&app).await;

    let response = app
        .post_as(
            outsider,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "let me in",
            }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

// A user who joined a project via invite gets a `TaskflowProjectMember` but no
// channel-roster row. They can see and read the project's shared rooms (SP-A
// scoping), so they must be able to POST in them too — this is the reported bug.
#[tokio::test]
async fn active_project_member_off_roster_can_post_in_project_channel() {
    let app = TestApp::new().await;
    let (channel, user, display_name) = seed_project_member_off_roster(
        &app,
        TaskflowChannelKind::Project,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "posting as a project member",
            }),
        )
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;
    assert_eq!(row["sender_user"], json!(user));
    assert_eq!(row["sender_kind"], json!("user"));
    // The label is the project-member display_name — a real, non-empty value,
    // not "" and not a fabricated one.
    assert_eq!(row["sender_label"], json!(display_name));
}

// DMs stay private to their explicit roster. Project membership must NOT let a
// user into a Direct channel they were never added to.
#[tokio::test]
async fn active_project_member_off_roster_cannot_post_in_direct_channel() {
    let app = TestApp::new().await;
    let (channel, user, _) = seed_project_member_off_roster(
        &app,
        TaskflowChannelKind::Direct,
        TaskflowMembershipStatus::Active,
    )
    .await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "let me into this DM",
            }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

// A non-active (suspended) project member has no live access to the project, so
// the fallback must not authorize them even in a shared room.
#[tokio::test]
async fn suspended_project_member_cannot_post_in_project_channel() {
    let app = TestApp::new().await;
    let (channel, user, _) = seed_project_member_off_roster(
        &app,
        TaskflowChannelKind::Project,
        TaskflowMembershipStatus::Suspended,
    )
    .await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "suspended but trying",
            }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn rejects_unknown_channel_with_404() {
    let app = TestApp::new().await;
    let (_, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": 999999,
                "body_markdown": "into the void",
            }),
        )
        .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn rejects_empty_body_with_400() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "   ",
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn rejects_body_over_max_chars_with_400() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "a".repeat(20_001),
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn same_nonce_twice_inserts_once_and_returns_the_stored_row() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;
    let body = json!({
        "channel": channel,
        "body_markdown": "only once",
        "client_nonce": "nonce-abc-123",
    });

    let first = app
        .post_as(user, "/api/taskflow/agents/messages", body.clone())
        .await;
    let second = app
        .post_as(user, "/api/taskflow/agents/messages", body)
        .await;

    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(first.json().await["id"], second.json().await["id"]);
    assert_eq!(app.count_messages(channel).await, 1);
}

#[tokio::test]
async fn derives_project_from_the_channel() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "scoped",
                "project": 4242,          // client-supplied project is ignored
            }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    assert_eq!(row["project"], json!(app.project_of_channel(channel).await));
}

// The 403 check MUST run before the idempotency lookup. The nonce is scoped
// to (channel, nonce) only — it carries no sender — so an outsider who
// guesses or observes a nonce must not be able to replay it and have the
// idempotency branch hand back the stored message body. If a future
// refactor "tidies" the handler by moving the idempotency check earlier,
// this test must fail.
#[tokio::test]
async fn non_member_replaying_a_nonce_gets_403_not_the_stored_row() {
    let app = TestApp::new().await;
    let (channel, member) = seed_channel_with_member(&app).await;
    let outsider = app.create_user().await;

    app.post_as(
        member,
        "/api/taskflow/agents/messages",
        json!({
            "channel": channel,
            "body_markdown": "secret plans",
            "client_nonce": "n-1",
        }),
    )
    .await;

    let replay = app
        .post_as(
            outsider,
            "/api/taskflow/agents/messages",
            json!({
                "channel": channel,
                "body_markdown": "gimme",
                "client_nonce": "n-1",
            }),
        )
        .await;

    assert_eq!(replay.status(), 403, "leaked: {:?}", replay.json().await);
}
