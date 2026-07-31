//! Editing is authorship-gated: only the author may revise their own words,
//! the revision is stamped `edited_at`, and everything else about the message
//! (sender, channel, targets) is immutable.

use serde_json::json;

mod support;
use support::{TestApp, seed_channel_with_member};

/// Send one message as `user` in `channel` and return its id.
async fn send_one(app: &TestApp, user: i64, channel: i64, body: &str) -> i64 {
    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": channel, "body_markdown": body }),
        )
        .await;
    assert_eq!(response.status(), 200);
    response.json().await["id"].as_i64().expect("message id")
}

#[tokio::test]
async fn author_edits_own_message_and_edited_at_is_stamped() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;
    let message = send_one(&app, user, channel, "first draft").await;

    let response = app
        .post_as(
            user,
            &format!("/api/taskflow/messages/{message}/edit"),
            json!({ "body_markdown": "second draft" }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    assert_eq!(row["id"], json!(message));
    assert_eq!(row["body_markdown"], json!("second draft"));
    assert!(row["edited_at"].is_string(), "edited_at must be stamped: {row}");
    // The sender trio survives untouched.
    assert_eq!(row["sender_user"], json!(user));
    assert_eq!(row["sender_kind"], json!("user"));
}

#[tokio::test]
async fn non_author_gets_404_not_an_existence_oracle_403() {
    let app = TestApp::new().await;
    let (channel, author) = seed_channel_with_member(&app).await;
    let message = send_one(&app, author, channel, "mine").await;
    let stranger = app.create_user().await;

    let response = app
        .post_as(
            stranger,
            &format!("/api/taskflow/messages/{message}/edit"),
            json!({ "body_markdown": "rewritten by someone else" }),
        )
        .await;

    // 404, not 403 — a 403 would confirm the id exists to any authenticated
    // caller, an oracle over other projects' DM ids.
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn unknown_message_is_404() {
    let app = TestApp::new().await;
    let (_, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/messages/999999/edit",
            json!({ "body_markdown": "into the void" }),
        )
        .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn empty_body_without_attachments_is_rejected() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;
    let message = send_one(&app, user, channel, "has words").await;

    let response = app
        .post_as(
            user,
            &format!("/api/taskflow/messages/{message}/edit"),
            json!({ "body_markdown": "   " }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn unchanged_body_does_not_claim_an_edit() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;
    let message = send_one(&app, user, channel, "same words").await;

    let response = app
        .post_as(
            user,
            &format!("/api/taskflow/messages/{message}/edit"),
            json!({ "body_markdown": "same words" }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    // "(edited)" is a claim the words changed; a no-op save must not make it.
    assert!(row["edited_at"].is_null(), "no-op edit must not stamp edited_at: {row}");
}

#[tokio::test]
async fn anonymous_caller_is_rejected() {
    // No prior authed request: `post_json_noauth` must be the FIRST call on a
    // fresh client (the harness cannot remove a default header once set). The
    // auth gate is an extractor, so it rejects before the id is even looked
    // up — a nonexistent id still proves the gate.
    let app = TestApp::new().await;

    let response = app
        .post_json_noauth(
            "/api/taskflow/messages/1/edit",
            json!({ "body_markdown": "drive-by" }),
        )
        .await;

    assert_eq!(response.status(), 401);
}
